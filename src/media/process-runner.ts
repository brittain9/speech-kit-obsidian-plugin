import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface ManagedProcessResult {
  readonly cancelled: boolean;
  readonly exitCode: number | null;
  readonly failed: boolean;
  readonly outputLimitExceeded: boolean;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ManagedProcessOptions {
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly stderrLimitBytes?: number;
  readonly timeoutMs: number;
  readonly onStderr?: (stderr: string) => void;
  readonly onStdout?: (stdout: string) => void;
}

export interface ManagedProcessSpawnOptions extends SpawnOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly taskkillEnvironment?: NodeJS.ProcessEnv;
  readonly taskkillPath?: string;
}

interface TaskkillOptions {
  readonly command: string;
  readonly environment: NodeJS.ProcessEnv;
}

export async function runManagedProcess(
  command: string,
  args: readonly string[],
  options: ManagedProcessSpawnOptions,
  limits: ManagedProcessOptions,
): Promise<ManagedProcessResult> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const platform = options.platform ?? process.platform;
  const {
    platform: _platform,
    spawnProcess: _spawnProcess,
    taskkillEnvironment: _taskkillEnvironment,
    taskkillPath: _taskkillPath,
    ...spawnOptions
  } = options;
  const taskkill = taskkillOptions(options, platform);
  const child = spawnProcess(command, args, {
    ...spawnOptions,
    detached: platform !== 'win32',
    shell: false,
  });
  return await collectProcessOutput(child, platform, spawnProcess, taskkill, limits);
}

async function collectProcessOutput(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
  taskkill: TaskkillOptions,
  limits: ManagedProcessOptions,
): Promise<ManagedProcessResult> {
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let exitObserved = false;
  let observedExitCode: number | null = null;
  let forceTimer: number | undefined;
  let timeoutTimer: number | undefined;
  let terminationPromise: Promise<void> | null = null;
  let exitCleanupPromise: Promise<void> | null = null;
  let resolveResult!: (result: ManagedProcessResult) => void;
  const resultPromise = new Promise<ManagedProcessResult>((resolve) => {
    resolveResult = resolve;
  });
  const childPid = child.pid;

  const clearForceTimer = (): void => {
    if (forceTimer === undefined) return;
    window.clearTimeout(forceTimer);
    forceTimer = undefined;
  };
  const terminate = (signal: ProcessSignal, scheduleForce: boolean): void => {
    if (settled || exitObserved) return;
    terminationPromise = killProcessTree({
      allowDirectChild: true,
      child,
      childPid,
      platform,
      signal,
      spawnProcess,
      taskkill,
    });
    if (scheduleForce && forceTimer === undefined) {
      forceTimer = window.setTimeout(() => {
        forceTimer = undefined;
        if (settled || exitObserved) return;
        void killProcessTree({
          allowDirectChild: true,
          child,
          childPid,
          platform,
          signal: 'SIGKILL',
          spawnProcess,
          taskkill,
        });
      }, 1_000);
    }
  };
  const finish = (exitCode: number | null, failed: boolean): void => {
    if (settled) return;
    settled = true;
    clearForceTimer();
    if (timeoutTimer !== undefined) {
      window.clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    limits.signal?.removeEventListener('abort', abort);
    child.stdout?.removeListener('data', onStdout);
    child.stderr?.removeListener('data', onStderr);
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
    child.removeListener('close', onClose);
    // No kill is initiated from close. Normal descendant cleanup starts at
    // exit, while cancellation/timeout cleanup starts while the child is live.
    const cleanup = exitCleanupPromise ?? terminationPromise ?? Promise.resolve();
    void cleanup.finally(() => {
      resolveResult({
        cancelled,
        exitCode,
        failed,
        outputLimitExceeded,
        stderr,
        stdout,
        timedOut,
      });
    });
  };
  const abort = (): void => {
    cancelled = true;
    terminate('SIGTERM', true);
  };
  const onStdout = (chunk: Buffer | string): void => {
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stdoutBytes += Buffer.byteLength(value, 'utf8');
    if (stdoutBytes > limits.maxOutputBytes) {
      outputLimitExceeded = true;
      terminate('SIGKILL', false);
      finish(null, true);
      return;
    }
    stdout += value;
    limits.onStdout?.(stdout);
  };
  const onStderr = (chunk: Buffer | string): void => {
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    stderrBytes += Buffer.byteLength(value, 'utf8');
    const stderrLimit = limits.stderrLimitBytes ?? limits.maxOutputBytes;
    if (stderrBytes > stderrLimit) {
      outputLimitExceeded = true;
      terminate('SIGKILL', false);
      finish(null, true);
      return;
    }
    stderr += value;
    limits.onStderr?.(stderr);
  };
  const onError = (): void => {
    terminate('SIGKILL', false);
    finish(null, true);
  };
  const onExit = (code: number | null): void => {
    if (settled) return;
    exitObserved = true;
    observedExitCode = code;
    exitCleanupPromise = killProcessTree({
      allowDirectChild: false,
      child,
      childPid,
      platform,
      signal: 'SIGKILL',
      spawnProcess,
      taskkill,
    });
  };
  const onClose = (code: number | null): void =>
    finish(observedExitCode ?? code, observedExitCode !== 0);
  timeoutTimer = window.setTimeout(
    () => {
      timedOut = true;
      terminate('SIGTERM', true);
    },
    Math.max(1, limits.timeoutMs),
  );

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.once('error', onError);
  child.once('exit', onExit);
  child.once('close', onClose);
  limits.signal?.addEventListener('abort', abort, { once: true });
  if (limits.signal?.aborted === true) abort();
  return await resultPromise;
}

async function killProcessTree(options: {
  readonly allowDirectChild: boolean;
  readonly child: ChildProcess;
  readonly childPid: number | undefined;
  readonly platform: NodeJS.Platform;
  readonly signal: ProcessSignal;
  readonly spawnProcess: typeof spawn;
  readonly taskkill: TaskkillOptions;
}): Promise<void> {
  const { allowDirectChild, child, childPid, platform, signal, spawnProcess, taskkill } = options;
  if (platform === 'win32') {
    if (childPid === undefined) return;
    await new Promise<void>((resolve) => {
      let taskkillProcess: ChildProcess;
      try {
        taskkillProcess = spawnProcess(taskkill.command, ['/pid', String(childPid), '/T', '/F'], {
          env: taskkill.environment,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        if (allowDirectChild) child.kill(signal);
        resolve();
        return;
      }
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(() => {
        taskkillProcess.kill('SIGKILL');
        if (allowDirectChild) child.kill(signal);
        finish();
      }, 1_000);
      taskkillProcess.once('error', () => {
        if (allowDirectChild) child.kill(signal);
        finish();
      });
      taskkillProcess.once('close', finish);
    });
    return;
  }
  if (childPid === undefined) {
    if (allowDirectChild) child.kill(signal);
    return;
  }
  try {
    process.kill(-childPid, signal);
  } catch {
    if (allowDirectChild) child.kill(signal);
  }
}

function taskkillOptions(
  options: ManagedProcessSpawnOptions,
  platform: NodeJS.Platform,
): TaskkillOptions {
  if (platform !== 'win32') {
    return { command: '', environment: {} };
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const command = options.taskkillPath ?? `${systemRoot}\\System32\\taskkill.exe`;
  if (!isWindowsAbsolutePath(command)) {
    throw new Error('The Windows taskkill executable must be an absolute path.');
  }
  return {
    command,
    environment: options.taskkillEnvironment ?? {
      ComSpec: `${systemRoot}\\System32\\cmd.exe`,
      PATH: '',
      SystemRoot: systemRoot,
    },
  };
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}
