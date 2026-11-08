import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const { spawn } = await import('node:child_process');
const { SidecarProcess } = await import('../src/sidecar/sidecar-process');

const mockedSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

// A minimal stand-in for ChildProcessWithoutNullStreams: real pipe streams so
// readline's createInterface(child.stderr) and the stdout/stdin wiring in
// SidecarProcess work unmodified, plus the process-lifecycle bits
// (exitCode/signalCode/killed/kill/'spawn'/'exit') that the fix under test
// depends on.
class FakeChild extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  public pendingWrite: ((error?: Error | null) => void) | null = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  constructor() {
    super();
    this.stdin = new Writable({
      highWaterMark: 16,
      write: (_chunk, _encoding, callback) => {
        this.pendingWrite = callback;
      },
    });
  }

  completePendingWrite(error?: Error | null): void {
    const callback = this.pendingWrite;
    this.pendingWrite = null;
    callback?.(error);
  }

  kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => {
    this.killed = true;
    return true;
  });

  /** Simulates the OS actually reaping the process. */
  reallyExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function queueChild(): FakeChild {
  const child = new FakeChild();
  // doStart() awaits resolveLaunchSpec() before calling spawn(), so the test
  // can't emit 'spawn' right after calling start() -- the listener isn't
  // attached yet at that point. Queueing the emit as a microtask from inside
  // spawn() itself guarantees it runs after waitForSpawn() has synchronously
  // registered its listeners (which happens in the same synchronous stretch
  // as this spawn() call, right before doStart suspends on that promise).
  mockedSpawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
  return child;
}

function createHandlers() {
  return {
    onExit: vi.fn(),
    onStderrLine: vi.fn(),
    onStdoutChunk: vi.fn(),
  };
}

async function startChild(process: InstanceType<typeof SidecarProcess>): Promise<FakeChild> {
  const child = queueChild();
  await process.start();
  return child;
}

beforeEach(() => {
  mockedSpawn.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SidecarProcess bounded audio writes', () => {
  it('resolves immediately when the Node writable accepts a frame', async () => {
    const process = new SidecarProcess(
      async () => ({ command: '/tmp/fake-sidecar' }),
      createHandlers(),
    );
    const child = await startChild(process);

    await expect(
      process.writeAudioFrame(new Uint8Array(1), new AbortController().signal),
    ).resolves.toBeUndefined();
    expect(child.pendingWrite).not.toBeNull();
    child.completePendingWrite();
  });

  it('waits for drain after a false write return and cleans up its listeners', async () => {
    const process = new SidecarProcess(
      async () => ({ command: '/tmp/fake-sidecar' }),
      createHandlers(),
    );
    const child = await startChild(process);
    const abortController = new AbortController();
    const writing = process.writeAudioFrame(new Uint8Array(661), abortController.signal);
    const assertion = expect(writing).resolves.toBeUndefined();

    expect(child.stdin.writableNeedDrain).toBe(true);
    child.completePendingWrite();
    await assertion;
    expect(child.stdin.listenerCount('drain')).toBe(0);
    expect(abortController.signal.aborted).toBe(false);
  });

  it('rejects a false write on abort and removes drain/error listeners', async () => {
    const process = new SidecarProcess(
      async () => ({ command: '/tmp/fake-sidecar' }),
      createHandlers(),
    );
    const child = await startChild(process);
    const abortController = new AbortController();
    const writing = process.writeAudioFrame(new Uint8Array(661), abortController.signal);
    const assertion = expect(writing).rejects.toBeDefined();

    abortController.abort();
    await assertion;
    expect(child.stdin.listenerCount('drain')).toBe(0);
    expect(child.stdin.listenerCount('error')).toBe(1);
    child.completePendingWrite();
  });

  it('rejects a false write on stream error and removes the one-shot listener', async () => {
    const process = new SidecarProcess(
      async () => ({ command: '/tmp/fake-sidecar' }),
      createHandlers(),
    );
    const child = await startChild(process);
    const writing = process.writeAudioFrame(new Uint8Array(661), new AbortController().signal);
    const assertion = expect(writing).rejects.toThrow('stdin failed');

    child.stdin.emit('error', new Error('stdin failed'));
    await assertion;
    expect(child.stdin.listenerCount('drain')).toBe(0);
    expect(child.stdin.listenerCount('error')).toBe(1);
    child.completePendingWrite();
  });
});

describe('SidecarProcess shutdown during launch', () => {
  it('waits for a deferred launch and stops the child before resolving without an orphan', async () => {
    const handlers = createHandlers();
    const child = queueChild();
    let resolveLaunch: ((spec: { command: string }) => void) | undefined;
    const process = new SidecarProcess(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        }),
      handlers,
    );

    const starting = process.start();
    const stopping = process.stop();
    resolveLaunch?.({ command: '/tmp/fake-sidecar' });
    await vi.waitFor(() => expect(mockedSpawn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(process.isRunning()).toBe(true));

    let stopResolved = false;
    void stopping.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();

    child.reallyExit(null, 'SIGTERM');
    await Promise.all([starting, stopping]);

    expect(stopResolved).toBe(true);
    expect(process.isRunning()).toBe(false);
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null, 'SIGTERM');
  });
});

describe('SidecarProcess stale-exit race (issue #194)', () => {
  it('stop() does not resolve until the killed child actually exits', async () => {
    const handlers = createHandlers();
    const process = new SidecarProcess(async () => ({ command: '/tmp/fake-sidecar' }), handlers);
    const child = await startChild(process);

    const stopPromise = process.stop();

    // The graceful window elapses; stop() must escalate to SIGKILL rather
    // than resolving on the timeout alone.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(handlers.onExit).not.toHaveBeenCalled();

    // Only once the OS actually reaps the process does stop() resolve.
    child.reallyExit(null, 'SIGKILL');
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null, 'SIGKILL');
  });

  it('does not let a replacement spawn while the killed child is still alive', async () => {
    const handlers = createHandlers();
    const process = new SidecarProcess(async () => ({ command: '/tmp/fake-sidecar' }), handlers);
    await startChild(process);

    const stopPromise = process.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    // A kill signal was sent but the child has not exited: isRunning() must
    // still report true so a concurrent start() doesn't spawn a second child
    // onto the same slot.
    expect(process.isRunning()).toBe(true);
    await process.start();
    expect(mockedSpawn).toHaveBeenCalledTimes(1);

    void stopPromise;
  });

  it('leaves a fully intact replacement process after a delayed old-child exit (restart regression)', async () => {
    const handlers = createHandlers();
    const process = new SidecarProcess(async () => ({ command: '/tmp/fake-sidecar' }), handlers);
    const child1 = await startChild(process);

    // Mirrors SidecarConnection#restart(): stop() the current child, then
    // start() a replacement. The old child ignores the graceful shutdown
    // path (no self-initiated exit) and only dies once SIGKILL lands.
    const stopPromise = process.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    child1.reallyExit(null, 'SIGKILL');
    await stopPromise;

    const child2 = await startChild(process);

    expect(process.isRunning()).toBe(true);
    expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith(null, 'SIGKILL');

    // The new stderr reader is alive and wired to the new child, not a stale
    // reader left over from the old one.
    child2.stderr.write('hello from child2\n');
    await vi.waitFor(() => {
      expect(handlers.onStderrLine).toHaveBeenCalledWith('hello from child2');
    });

    // A stray, late 'exit' on the old child object (e.g. a duplicate signal
    // delivery) must never clear state or refire onExit for the wrong
    // generation.
    child1.emit('exit', 1, null);
    expect(process.isRunning()).toBe(true);
    expect(handlers.onExit).toHaveBeenCalledTimes(1);
  });
});
