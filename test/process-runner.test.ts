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
      { maxOutputBytes: 5, stderrLimitBytes: 5, timeoutMs: 1_000 },
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
    child.emit('close', 0);
    await resultPromise;
    expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL');
    kill.mockRestore();
  });
  it('uses fixed taskkill argv without a shell on Windows', async () => {
    const child = new FakeChild();
    child.pid = 1234;
    const taskkill = new FakeChild();
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawnProcess = vi.fn((command: string, args: readonly string[]) => {
      calls.push({ args, command });
      return command === 'taskkill' ? taskkill : child;
    }) as unknown as typeof spawn;
    const resultPromise = runManagedProcess(
      'C:\\helper.exe',
      ['--version'],
      { platform: 'win32', shell: false, spawnProcess },
      { maxOutputBytes: 100, timeoutMs: 1_000 },
    );
    child.emit('close', 0);
    taskkill.emit('close', 0);
    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(calls).toContainEqual({
      args: ['/pid', '1234', '/T', '/F'],
      command: 'taskkill',
    });
    expect(calls.every(({ args }) => !args.includes('-c'))).toBe(true);
  });
});
