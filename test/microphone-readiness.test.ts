import { describe, expect, it, vi } from 'vitest';

import { MicrophoneReadiness } from '../src/setup/microphone-readiness';

function deniedError(): Error {
  const error = new Error('permission denied');
  error.name = 'NotAllowedError';
  return error;
}

function streamWithTrack(stop = vi.fn()): MediaStream {
  return { getTracks: () => [{ stop }] } as unknown as MediaStream;
}

describe('MicrophoneReadiness', () => {
  it('does not reprompt after denial when the Permissions API remains prompt', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(deniedError());
    const readiness = new MicrophoneReadiness({
      mediaDevices: { getUserMedia },
      permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) },
    });

    await expect(readiness.check()).resolves.toMatchObject({
      recovery: 'recheck',
      status: 'unavailable',
    });
    await readiness.check();
    await readiness.check();

    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('does not reprompt after denial when the Permissions API is unavailable', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(deniedError());
    const readiness = new MicrophoneReadiness({ mediaDevices: { getUserMedia } });

    await expect(readiness.check()).resolves.toMatchObject({
      recovery: 'reopen',
      status: 'unavailable',
    });
    await readiness.check();
    await readiness.check();

    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('does not call media devices when permission is already denied', async () => {
    const getUserMedia = vi.fn();
    const readiness = new MicrophoneReadiness({
      mediaDevices: { getUserMedia },
      permissions: { query: vi.fn().mockResolvedValue({ state: 'denied' }) },
    });

    await expect(readiness.check()).resolves.toMatchObject({
      recovery: 'recheck',
      status: 'unavailable',
    });
    await readiness.check();

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('verifies the device after permission becomes granted and releases its track', async () => {
    const stop = vi.fn();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(deniedError())
      .mockResolvedValueOnce(streamWithTrack(stop));
    let permissionState: PermissionState = 'prompt';
    const readiness = new MicrophoneReadiness({
      mediaDevices: { getUserMedia },
      permissions: { query: vi.fn().mockImplementation(async () => ({ state: permissionState })) },
    });

    await expect(readiness.check()).resolves.toMatchObject({ status: 'unavailable' });
    permissionState = 'granted';
    await expect(readiness.check()).resolves.toEqual({ recovery: 'recheck', status: 'ready' });

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });
});
