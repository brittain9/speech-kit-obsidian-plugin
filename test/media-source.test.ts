import { describe, expect, it, vi } from 'vitest';
import { LocalMediaSource } from '../src/media/local-media-source';
import { createGeneratedWavFile } from './fixtures/audio-file';

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

describe('LocalMediaSource', () => {
  it('emits provider-neutral events and an idempotent local lease', async () => {
    const file = createGeneratedWavFile('private-name.wav', {
      channelCount: 1,
      sampleRate: 16_000,
      samples: [new Float32Array([0, 0])],
    });
    const source = new LocalMediaSource({ pickFile: vi.fn(async () => file) });
    const events = await collect(source.acquirePicked(new AbortController().signal));

    expect(events.map((event) => event.type)).toEqual(['plan', 'progress', 'ready']);
    expect(events[0]).toMatchObject({
      plan: { access: 'local', displayName: 'Local audio file', sourceId: 'local_file' },
      type: 'plan',
    });
    const ready = events[2];
    if (ready?.type !== 'ready') {
      throw new Error('Expected a local media lease.');
    }
    const serialized = JSON.stringify(ready.lease.provenance);
    expect(serialized).not.toContain('private-name.wav');
    expect(serialized).not.toContain('file://');
    expect(serialized).not.toContain('/private/');

    await ready.lease.release();
    await ready.lease.release();
    await expect(ready.lease.openReadStream()).rejects.toMatchObject({ code: 'read_failed' });
  });

  it('does not emit a lease when the picker is cancelled or dismissed', async () => {
    const dismissed = new LocalMediaSource({ pickFile: async () => null });
    await expect(collect(dismissed.acquirePicked(new AbortController().signal))).resolves.toEqual(
      [],
    );

    const controller = new AbortController();
    controller.abort();
    const cancelled = new LocalMediaSource({ pickFile: vi.fn(async () => null) });
    await expect(collect(cancelled.acquirePicked(controller.signal))).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('stops acquisition before a selected file is exposed when cancelled', async () => {
    const controller = new AbortController();
    const file = createGeneratedWavFile('cancelled.wav', {
      channelCount: 1,
      sampleRate: 16_000,
      samples: [new Float32Array([0, 0])],
    });
    const source = new LocalMediaSource({
      pickFile: async () => {
        controller.abort();
        return file;
      },
    });

    await expect(collect(source.acquirePicked(controller.signal))).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});
