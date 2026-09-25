import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runManagedProcess } from '../src/media/process-runner';

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kill = vi.fn();
  pid: number | undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('managed process runner', () => {
  it('bounds cumulative stdout and stderr across small chunks', async () => {
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      '/private/helper',
      ['--version'],
      { platform: 'linux', shell: false, spawnProcess },
      { closeTimeoutMs: 20, maxOutputBytes: 5, stderrLimitBytes: 5, timeoutMs: 1_000 },
    );
    child.stdout.emit('data', '123');
    child.stdout.emit('data', '456');
    child.stderr.emit('data', 'abc');
    child.stderr.emit('data', 'def');
    const result = await resultPromise;
    expect(result.outputLimitExceeded).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('clears the force timer after normal settlement', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      '/private/helper',
      [],
      { platform: 'linux', shell: false, spawnProcess },
      { maxOutputBytes: 100, timeoutMs: 1_000 },
    );
    child.emit('close', 0);
    await resultPromise;
    const callsAtSettlement = child.kill.mock.calls.length;
    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledTimes(callsAtSettlement);
  });

  it('terminates a POSIX process group when the leader closes', async () => {
    const child = new FakeChild();
    child.pid = 4321;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      '/private/helper',
      [],
      { platform: 'linux', shell: false, spawnProcess },
      { maxOutputBytes: 100, timeoutMs: 1_000 },
    );
    child.emit('exit', 0);
    child.emit('close', 0);
    await resultPromise;
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
    expect(kill).toHaveBeenCalledTimes(1);
    kill.mockRestore();
  });
  it('does not kill a reused PID when close arrives without an exit event', async () => {
    const child = new FakeChild();
    child.pid = 9876;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      '/private/helper',
      [],
      { platform: 'linux', shell: false, spawnProcess },
      { maxOutputBytes: 100, timeoutMs: 1_000 },
    );
    child.emit('close', 0);
    await resultPromise;
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });
  it('escalates a POSIX group and fails bounded when exit leaves close pending', async () => {
    const child = new FakeChild();
    child.pid = 4322;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      '/private/helper',
      [],
      { platform: 'linux', shell: false, spawnProcess },
      {
        closeTimeoutMs: 20,
        forceDelayMs: 5,
        maxOutputBytes: 100,
        timeoutMs: 1_000,
      },
    );
    child.emit('exit', 0);
    const result = await resultPromise;
    expect(result.exitCode).toBeNull();
    expect(result.cleanupFailed).toBe(true);
    expect(result.failed).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4322, 'SIGKILL');
    expect(kill).toHaveBeenCalledTimes(2);
    kill.mockRestore();
  });

  it('settles after a bounded timeout when a child never closes', async () => {
    const child = new FakeChild();
    child.pid = 7654;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const result = await runManagedProcess(
      '/private/helper',
      [],
      { platform: 'linux', shell: false, spawnProcess },
      { closeTimeoutMs: 20, maxOutputBytes: 100, timeoutMs: 5 },
    );
    expect(result.timedOut).toBe(true);
    expect(kill).toHaveBeenCalledWith(-7654, 'SIGTERM');
    kill.mockRestore();
  });

  it('rejects a SIGTERM-ignoring child that never closes', async () => {
    const child = new FakeChild();
    child.pid = 7655;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const result = await runManagedProcess(
      '/private/helper',
      [],
      { platform: 'linux', shell: false, spawnProcess },
      { closeTimeoutMs: 20, maxOutputBytes: 100, timeoutMs: 5 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.cleanupFailed).toBe(true);
    expect(result.failed).toBe(true);
    expect(kill).toHaveBeenCalledWith(-7655, 'SIGTERM');
    kill.mockRestore();
  });

  it('does not taskkill a normally exited Windows child', async () => {
    const child = new FakeChild();
    child.pid = 2468;
    const calls: string[] = [];
    const spawnProcess = vi.fn((command: string) => {
      calls.push(command);
      return child;
    }) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      'C:\\helper.exe',
      [],
      { platform: 'win32', shell: false, spawnProcess },
      { maxOutputBytes: 100, timeoutMs: 1_000 },
    );
    child.emit('exit', 0);
    child.emit('close', 0);
    const result = await resultPromise;
    expect(calls).toEqual(['C:\\helper.exe']);
    expect(result.exitCode).toBe(0);
    expect(result.cleanupFailed).toBe(false);
    expect(result.failed).toBe(false);
  });

  it('fails closed when taskkill cannot spawn during a live timeout', async () => {
    const child = new FakeChild();
    child.pid = 2469;
    const spawnProcess = vi.fn((command: string) => {
      if (command.endsWith('taskkill.exe')) throw new Error('taskkill spawn failed');
      return child;
    }) as unknown as typeof spawn;
    const result = await runManagedProcess(
      'C:\\helper.exe',
      [],
      { platform: 'win32', shell: false, spawnProcess },
      { closeTimeoutMs: 20, maxOutputBytes: 100, timeoutMs: 5 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.cleanupFailed).toBe(true);
    expect(result.failed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('fails closed and directly kills a live child when taskkill errors', async () => {
    const child = new FakeChild();
    child.pid = 2470;
    const taskkill = new FakeChild();
    const spawnProcess = vi.fn((command: string) =>
      command.endsWith('taskkill.exe') ? taskkill : child,
    ) as unknown as typeof spawn;
    const controller = new AbortController();
    const resultPromise = runManagedProcess(
      'C:\\helper.exe',
      [],
      { platform: 'win32', shell: false, spawnProcess },
      { closeTimeoutMs: 20, maxOutputBytes: 100, signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();
    taskkill.emit('error', new Error('taskkill failed'));
    const result = await resultPromise;
    expect(result.cleanupFailed).toBe(true);
    expect(result.failed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('rejects a Windows child that ignores termination and never closes', async () => {
    const child = new FakeChild();
    child.pid = 2471;
    const taskkill = new FakeChild();
    const spawnProcess = vi.fn((command: string) =>
      command.endsWith('taskkill.exe') ? taskkill : child,
    ) as unknown as typeof spawn;
    const controller = new AbortController();
    const resultPromise = runManagedProcess(
      'C:\\helper.exe',
      [],
      { platform: 'win32', shell: false, spawnProcess },
      { closeTimeoutMs: 20, maxOutputBytes: 100, signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();
    taskkill.emit('close', 0);
    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
    expect(result.cleanupFailed).toBe(true);
    expect(result.failed).toBe(true);
  });

  it('uses fixed taskkill argv without a shell on Windows', async () => {
    const child = new FakeChild();
    child.pid = 1234;
    const taskkill = new FakeChild();
    const calls: Array<{
      command: string;
      args: readonly string[];
      options?: { env?: NodeJS.ProcessEnv; shell?: boolean };
    }> = [];
    const spawnProcess = vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: { env?: NodeJS.ProcessEnv; shell?: boolean },
      ) => {
        calls.push({ args, command, ...(options === undefined ? {} : { options }) });
        return command.endsWith('taskkill.exe') ? taskkill : child;
      },
    ) as unknown as typeof spawn;
    const controller = new AbortController();
    const resultPromise = runManagedProcess(
      'C:\\helper.exe',
      ['--version'],
      {
        platform: 'win32',
        shell: false,
        spawnProcess,
        taskkillEnvironment: { PATH: '', SystemRoot: 'C:\\Windows' },
        taskkillPath: 'C:\\Windows\\System32\\taskkill.exe',
      },
      {
        closeTimeoutMs: 100,
        maxOutputBytes: 100,
        signal: controller.signal,
        timeoutMs: 1_000,
      },
    );
    controller.abort();
    taskkill.emit('close', 0);
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.cancelled).toBe(true);
    const taskkillCall = calls.find(({ command }) => command.endsWith('taskkill.exe'));
    expect(taskkillCall).toMatchObject({
      args: ['/pid', '1234', '/T', '/F'],
      command: 'C:\\Windows\\System32\\taskkill.exe',
    });
    expect(taskkillCall?.options).toMatchObject({
      env: { PATH: '', SystemRoot: 'C:\\Windows' },
      shell: false,
    });
    expect(calls.every(({ args }) => !args.includes('-c'))).toBe(true);
  });
});
