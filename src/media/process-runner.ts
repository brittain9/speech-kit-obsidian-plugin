import { type ChildProcess, execFileSync, type SpawnOptions, spawn } from 'node:child_process';

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
}

export async function runManagedProcess(
  command: string,
  args: readonly string[],
  options: ManagedProcessSpawnOptions,
  limits: ManagedProcessOptions,
): Promise<ManagedProcessResult> {
  const spawnProcess = options.spawnProcess ?? spawn;
  const platform = options.platform ?? process.platform;
  const { platform: _platform, spawnProcess: _spawnProcess, ...spawnOptions } = options;
  const child = spawnProcess(command, args, {
    ...spawnOptions,
    detached: platform !== 'win32',
    shell: false,
  });
  return await collectProcessOutput(child, platform, spawnProcess, limits);
}

async function collectProcessOutput(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
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
  let forceTimer: number | undefined;
  let timeoutTimer: number | undefined;
  let treePollTimer: number | undefined;
  const descendantPids = new Set<number>();
  let terminationPromise: Promise<void> | null = null;
  let resolveResult!: (result: ManagedProcessResult) => void;
  const resultPromise = new Promise<ManagedProcessResult>((resolve) => {
    resolveResult = resolve;
  });

  const clearForceTimer = (): void => {
    if (forceTimer !== undefined) {
      window.clearTimeout(forceTimer);
      forceTimer = undefined;
    }
  };
  const terminate = (signal: ProcessSignal, scheduleForce: boolean): void => {
    if (settled) return;
    terminationPromise = killProcessTree(child, platform, spawnProcess, signal, descendantPids);
    if (scheduleForce && forceTimer === undefined) {
      forceTimer = window.setTimeout(() => {
        forceTimer = undefined;
        if (!settled)
          void killProcessTree(child, platform, spawnProcess, 'SIGKILL', descendantPids);
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
    if (treePollTimer !== undefined) {
      window.clearInterval(treePollTimer);
      treePollTimer = undefined;
    }
    limits.signal?.removeEventListener('abort', abort);
    child.stdout?.removeListener('data', onStdout);
    child.stderr?.removeListener('data', onStderr);
    child.removeListener('error', onError);
    child.removeListener('close', onClose);
    // A detached helper can leave descendants behind after its leader exits.
    // Terminate the group/tree before settling, but never schedule a later kill.
    const cleanup =
      !cancelled && !timedOut && !outputLimitExceeded
        ? killProcessTree(child, platform, spawnProcess, 'SIGKILL', descendantPids)
        : (terminationPromise ?? Promise.resolve());
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
  const onClose = (code: number | null): void => finish(code, code !== 0);
  timeoutTimer = window.setTimeout(
    () => {
      timedOut = true;
      terminate('SIGTERM', true);
    },
    Math.max(1, limits.timeoutMs),
  );
  if (platform !== 'win32' && child.pid !== undefined) {
    treePollTimer = window.setInterval(() => {
      for (const pid of collectDescendantPids(child.pid as number)) descendantPids.add(pid);
    }, 10);
  }

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.once('error', onError);
  child.once('close', onClose);
  limits.signal?.addEventListener('abort', abort, { once: true });
  if (limits.signal?.aborted === true) abort();
  return await resultPromise;
}

async function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawnProcess: typeof spawn,
  signal: ProcessSignal,
  descendants: ReadonlySet<number> = new Set(),
): Promise<void> {
  if (platform === 'win32') {
    if (child.pid === undefined) {
      child.kill(signal);
      return;
    }
    await new Promise<void>((resolve) => {
      let taskkill: ChildProcess;
      try {
        taskkill = spawnProcess('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        child.kill(signal);
        resolve();
        return;
      }
      taskkill.once('error', () => {
        child.kill(signal);
        resolve();
      });
      taskkill.once('close', () => resolve());
    });
    return;
  }
  for (const pid of descendants) {
    try {
      process.kill(pid, signal);
    } catch {
      // The descendant may have exited between snapshots.
    }
  }
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through for a child without a detached process group.
    }
  }
  child.kill(signal);
}

function collectDescendantPids(rootPid: number): number[] {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const children = new Map<number, number[]>();
    for (const line of output.split(/\r?\n/u)) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
      if (match === null) continue;
      const pid = Number(match[1]);
      const parent = Number(match[2]);
      const siblings = children.get(parent) ?? [];
      siblings.push(pid);
      children.set(parent, siblings);
    }
    const descendants: number[] = [];
    const pending = [...(children.get(rootPid) ?? [])];
    while (pending.length > 0) {
      const pid = pending.pop();
      if (pid === undefined) continue;
      descendants.push(pid);
      pending.push(...(children.get(pid) ?? []));
    }
    return descendants;
  } catch {
    return [];
  }
}
