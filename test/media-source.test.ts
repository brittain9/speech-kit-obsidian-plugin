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
    kind: 'interactive' as const,
    maxBytes: Number.MAX_SAFE_INTEGER,
    maxDurationMs: Number.MAX_SAFE_INTEGER,
    provider: undefined,
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
  it('opens the picker once and returns a provider-neutral ready lease', async () => {
    const file = makeFile();
    const pickFile = vi.fn(async () => file);
    const source = new LocalMediaSource({ pickFile });
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
    expect(pickFile).toHaveBeenCalledOnce();

    const firstRelease = ready.lease.release();
    expect(ready.lease.release()).toBe(firstRelease);
    await firstRelease;
    await expect(ready.lease.openReadStream()).rejects.toMatchObject({ code: 'read_failed' });
  });

  it('uses a pull-driven stream and cancels the single source reader on release', async () => {
    let pulls = 0;
    let cancellations = 0;
    const file = {
      size: 4,
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array([1, 2]));
          },
          cancel() {
            cancellations += 1;
          },
        }),
    } as File;
    const source = new LocalMediaSource({ pickFile: async () => file });
    const events = await collect(source.acquire(request()));
    const ready = events[2];
    if (ready?.type !== 'ready') throw new Error('Expected a ready lease.');
    const stream = await ready.lease.openReadStream();
    const reader = stream.getReader();
    expect(pulls).toBeLessThanOrEqual(1);
    expect(await reader.read()).toMatchObject({ done: false, value: new Uint8Array([1, 2]) });
    const release = ready.lease.release();
    await release;
    expect(cancellations).toBe(1);
    await expect(reader.read()).rejects.toMatchObject({ code: 'read_failed' });
    expect(ready.lease.release()).toBe(release);
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
