import { describe, expect, it, vi } from 'vitest';
import {
  AudioFileBackpressureGate,
  AudioFileBackpressureTimeoutError,
} from '../src/audio/audio-file-backpressure';
import { createAudioFileCancellationError } from '../src/audio/audio-file-decoder';

describe('AudioFileBackpressureGate', () => {
  it('blocks the next frame while the sidecar falls behind and resumes on normal', async () => {
    const gate = new AudioFileBackpressureGate(5_000);
    const order: string[] = [];
    gate.update('falling_behind');

    const waiting = gate.waitUntilNormal(new AbortController().signal).then(() => {
      order.push('normal');
    });
    order.push('waiting');
    gate.update('normal');
    await waiting;

    expect(order).toEqual(['waiting', 'normal']);
  });

  it('catching_up does not pause a bounded file source', async () => {
    const gate = new AudioFileBackpressureGate(5_000);
    gate.update('catching_up');

    await expect(gate.waitUntilNormal(new AbortController().signal)).resolves.toBeUndefined();
  });

  it('aborts a pending backpressure wait through the shared source signal', async () => {
    const gate = new AudioFileBackpressureGate(5_000);
    const abortController = new AbortController();
    gate.update('saturated');
    const waiting = gate.waitUntilNormal(abortController.signal);

    abortController.abort(createAudioFileCancellationError());

    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects instead of waiting indefinitely when the queue never recovers', async () => {
    vi.useFakeTimers();
    try {
      const gate = new AudioFileBackpressureGate(1_000);
      gate.update('saturated');
      const waiting = gate.waitUntilNormal(new AbortController().signal);
      const assertion = expect(waiting).rejects.toBeInstanceOf(AudioFileBackpressureTimeoutError);

      await vi.advanceTimersByTimeAsync(1_000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
