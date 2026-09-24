import { describe, expect, it, vi } from 'vitest';
import { LocalMediaSource } from '../src/media/local-media-source';
import { createGeneratedWavFile } from './fixtures/audio-file';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function request(signal = new AbortController().signal) {
  return {
    kind: 'interactive_local' as const,
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxDurationMs: Number.MAX_SAFE_INTEGER,
    signal,
  };
}

function makeFile(name = 'private-name.wav') {
  return createGeneratedWavFile(name, {
    channelCount: 1,
    sampleRate: 16_000,
    samples: [new Float32Array([0, 0])],
  });
}

describe('LocalMediaSource', () => {
  it('emits provider-neutral events and an idempotent local lease', async () => {
    const file = makeFile();
    const source = new LocalMediaSource({ pickFile: vi.fn(async () => file) });
    const events = await collect(source.acquire(request()));

    expect(events.map((event) => event.type)).toEqual(['plan', 'progress', 'ready']);
    expect(events[0]).toMatchObject({
      plan: { displayName: 'Local audio file', sourceId: 'local_file' },
      type: 'plan',
    });
    const ready = events[2];
    if (ready?.type !== 'ready') throw new Error('Expected a local media lease.');
    const serialized = JSON.stringify(ready.lease.provenance);
    expect(serialized).not.toContain('private-name.wav');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('/private/');

    const firstRelease = ready.lease.release();
    expect(ready.lease.release()).toBe(firstRelease);
    await firstRelease;
    await expect(ready.lease.openReadStream()).rejects.toMatchObject({ code: 'read_failed' });
  });

  it('binds a referenced acquisition to the inspected token without reopening the picker', async () => {
    const file = makeFile('token.wav');
    const pickFile = vi.fn(async () => file);
    const source = new LocalMediaSource({ pickFile });
    const inspected = await source.inspect({
      kind: 'interactive_local',
      signal: new AbortController().signal,
    });
    expect(inspected).not.toBeNull();
    if (inspected === null) return;

    const events = await collect(
      source.acquire({
        kind: 'referenced',
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxDurationMs: Number.MAX_SAFE_INTEGER,
        ref: inspected.ref,
        signal: new AbortController().signal,
      }),
    );
    const ready = events[2];
    if (ready?.type !== 'ready') throw new Error('Expected a ready lease.');
    expect(ready.lease.provenance.sourceRef).toEqual(inspected.ref);
    expect(pickFile).toHaveBeenCalledTimes(1);

    await ready.lease.release();
    await expect(
      collect(
        source.acquire({
          kind: 'referenced',
          maxBytes: Number.MAX_SAFE_INTEGER,
          maxDurationMs: Number.MAX_SAFE_INTEGER,
          ref: inspected.ref,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'read_failed' });
    expect(pickFile).toHaveBeenCalledTimes(1);
  });

  it('returns a real stream and cancels an active reader when the lease is released', async () => {
    const source = new LocalMediaSource({ pickFile: async () => makeFile() });
    const events = await collect(source.acquire(request()));
    const ready = events[2];
    if (ready?.type !== 'ready') throw new Error('Expected a ready lease.');
    const stream = await ready.lease.openReadStream();
    const reader = stream.getReader();
    expect(stream.locked).toBe(true);
    await reader.cancel('test cancellation');
    expect(stream.locked).toBe(true);
    reader.releaseLock();
    expect(stream.locked).toBe(false);
    await ready.lease.release();
  });

  it('does not emit a lease when the picker is cancelled or dismissed', async () => {
    const dismissed = new LocalMediaSource({ pickFile: async () => null });
    await expect(collect(dismissed.acquire(request()))).resolves.toEqual([]);

    const controller = new AbortController();
    controller.abort();
    const cancelled = new LocalMediaSource({ pickFile: vi.fn(async () => null) });
    await expect(collect(cancelled.acquire(request(controller.signal)))).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('stops acquisition before a selected file is exposed when cancelled', async () => {
    const controller = new AbortController();
    const file = makeFile('cancelled.wav');
    const source = new LocalMediaSource({
      pickFile: async () => {
        controller.abort();
        return file;
      },
    });

    await expect(collect(source.acquire(request(controller.signal)))).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});
