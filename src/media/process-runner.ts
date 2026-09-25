import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process';

export type ProcessSignal = 'SIGTERM' | 'SIGKILL';

export interface ManagedProcessResult {
  readonly cancelled: boolean;
  readonly cleanupFailed: boolean;
  readonly exitCode: number | null;
  readonly failed: boolean;
  readonly outputLimitExceeded: boolean;
  readonly stderr: string;
  readonly streamError?: unknown;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ManagedProcessOptions {
  readonly closeTimeoutMs?: number;
  readonly forceDelayMs?: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly stderrLimitBytes?: number;
  readonly timeoutMs: number;
  readonly onStderr?: (stderr: string) => void;
  readonly onStdout?: (stdout: string) => void;
  /** Consume stdout as bounded chunks. The pipe pauses until each chunk is consumed. */
  readonly onStdoutChunk?: (chunk: Buffer) => Promise<void> | void;
}

export interface ManagedProcessSpawnOptions extends SpawnOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly taskkillEnvironment?: NodeJS.ProcessEnv;
  readonly taskkillPath?: string;
}

const PROCESS_CLOSE_TIMEOUT_MS = 2_000;
const PROCESS_FORCE_DELAY_MS = 1_000;

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
  let cleanupFailed = false;
  let settled = false;
  let observedExitCode: number | null = null;
  let closeDeadlineTimer: number | undefined;
  let forceTimer: number | undefined;
  let timeoutTimer: number | undefined;
  let forceCleanupPromise: Promise<boolean> | null = null;
  let terminationPromise: Promise<boolean> | null = null;
  let exitCleanupPromise: Promise<boolean> | null = null;
  let stdoutCallbackQueue: Promise<void> = Promise.resolve();
  let stdoutCallbackError: unknown;
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
  const armCloseDeadline = (): void => {
    if (closeDeadlineTimer !== undefined) return;
    closeDeadlineTimer = window.setTimeout(
      () => {
        closeDeadlineTimer = undefined;
        if (settled) return;
        cleanupFailed = true;
        finish(null, true);
      },
      Math.max(1, limits.closeTimeoutMs ?? PROCESS_CLOSE_TIMEOUT_MS),
    );
  };
  const armForceTimer = (allowDirectChild: boolean): void => {
    if (forceTimer !== undefined || platform === 'win32') return;
    forceTimer = window.setTimeout(
      () => {
        forceTimer = undefined;
        if (settled) return;
        forceCleanupPromise = killProcessTree({
          allowDirectChild,
          child,
          childPid,
          platform,
          signal: 'SIGKILL',
          spawnProcess,
          taskkill,
        }).then((succeeded) => {
          cleanupFailed ||= !succeeded;
          return succeeded;
        });
      },
      Math.max(1, limits.forceDelayMs ?? PROCESS_FORCE_DELAY_MS),
    );
  };
  const terminate = (signal: ProcessSignal, scheduleForce: boolean): void => {
    if (settled || terminationPromise !== null) return;
    terminationPromise = killProcessTree({
      allowDirectChild: true,
      child,
      childPid,
      platform,
      signal,
      spawnProcess,
      taskkill,
    }).then((succeeded) => {
      cleanupFailed ||= !succeeded;
      return succeeded;
    });
    armCloseDeadline();
    if (scheduleForce) armForceTimer(true);
  };
  const finish = (exitCode: number | null, failed: boolean): void => {
    if (settled) return;
    settled = true;
    clearForceTimer();
    if (closeDeadlineTimer !== undefined) {
      window.clearTimeout(closeDeadlineTimer);
      closeDeadlineTimer = undefined;
    }
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
    const cleanup = Promise.all(
      [exitCleanupPromise, terminationPromise, forceCleanupPromise].filter(
        (value): value is Promise<boolean> => value !== null,
      ),
    ).then((results) => {
      for (const succeeded of results) cleanupFailed ||= !succeeded;
    });
    void cleanup
      .then(async () => await stdoutCallbackQueue.catch(() => {}))
      .finally(() => {
        resolveResult({
          cancelled,
          cleanupFailed,
          exitCode,
          failed: failed || cleanupFailed,
          outputLimitExceeded,
          stderr,
          ...(stdoutCallbackError === undefined ? {} : { streamError: stdoutCallbackError }),
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
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    stdoutBytes += bytes.byteLength;
    if (stdoutBytes > limits.maxOutputBytes) {
      outputLimitExceeded = true;
      terminate('SIGKILL', false);
      return;
    }
    if (limits.onStdoutChunk !== undefined) {
      child.stdout?.pause();
      stdoutCallbackQueue = stdoutCallbackQueue.then(async () => {
        await limits.onStdoutChunk?.(bytes);
      });
      void stdoutCallbackQueue
        .then(() => {
          if (!settled) child.stdout?.resume();
        })
        .catch((error: unknown) => {
          stdoutCallbackError = error;
          terminate('SIGTERM', true);
        });
      return;
    }
    const value = bytes.toString('utf8');
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
      return;
    }
    stderr += value;
    limits.onStderr?.(stderr);
  };
  const onError = (): void => {
    // A process error can arrive while stdout/stderr pipes are still open.
    // Keep the close listener and bounded deadline alive so callers never
    // mistake an error event for completed process-tree cleanup.
    if (childPid === undefined) {
      armCloseDeadline();
      return;
    }
    terminate('SIGKILL', false);
  };
  const onExit = (code: number | null): void => {
    if (settled) return;
    observedExitCode = code;
    if (terminationPromise !== null) return;
    armCloseDeadline();
    if (platform === 'win32') {
      exitCleanupPromise = Promise.resolve(true);
      return;
    }
    exitCleanupPromise = killProcessTree({
      allowDirectChild: false,
      child,
      childPid,
      platform,
      signal: 'SIGKILL',
      spawnProcess,
      taskkill,
    }).then((succeeded) => {
      cleanupFailed ||= !succeeded;
      return succeeded;
    });
    armForceTimer(false);
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
}): Promise<boolean> {
  const { allowDirectChild, child, childPid, platform, signal, spawnProcess, taskkill } = options;
  if (platform === 'win32') {
    if (childPid === undefined) return !allowDirectChild;
    return await new Promise<boolean>((resolve) => {
      let taskkillProcess: ChildProcess;
      let timer: number | undefined;
      const fail = (): void => {
        if (allowDirectChild) child.kill(signal);
        finish(false);
      };
      const finish = (succeeded: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        resolve(succeeded);
      };
      let settled = false;
      try {
        taskkillProcess = spawnProcess(taskkill.command, ['/pid', String(childPid), '/T', '/F'], {
          env: taskkill.environment,
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        fail();
        return;
      }
      timer = window.setTimeout(() => {
        taskkillProcess.kill('SIGKILL');
        if (allowDirectChild) child.kill(signal);
        finish(false);
      }, 1_000);
      taskkillProcess.once('error', fail);
      taskkillProcess.once('close', (code) => {
        if (code === 0) finish(true);
        else fail();
      });
    });
  }
  if (childPid === undefined) {
    if (allowDirectChild) child.kill(signal);
    return !allowDirectChild;
  }
  try {
    process.kill(-childPid, signal);
    return true;
  } catch (error) {
    if (isProcessGoneError(error)) return true;
    if (allowDirectChild) child.kill(signal);
    return false;
  }
}

function isProcessGoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
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
