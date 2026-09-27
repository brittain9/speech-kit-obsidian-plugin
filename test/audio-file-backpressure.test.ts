import { describe, expect, it, vi } from 'vitest';
import {
  AudioFileBackpressureGate,
  AudioFileBackpressureTimeoutError,
  AudioFileFlowControlTimeoutError,
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

  it('pauses file audio at catching_up and resumes when the worker recovers', async () => {
    const gate = new AudioFileBackpressureGate(5_000);
    gate.update('catching_up');
    let resumed = false;
    const waiting = gate.waitUntilNormal(new AbortController().signal).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    gate.update('normal');
    await waiting;
    expect(resumed).toBe(true);
  });

  it('limits file audio ahead of consumed-frame acknowledgments', async () => {
    const gate = new AudioFileBackpressureGate(null);
    for (let index = 0; index < 50; index += 1) {
      await gate.waitUntilNormal(new AbortController().signal);
      gate.markFrameSent();
    }
    let resumed = false;
    const waiting = gate.waitUntilNormal(new AbortController().signal).then(() => {
      resumed = true;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    gate.acknowledgeFramesConsumed(25);
    await waiting;
    expect(resumed).toBe(true);
  });

  it('fails clearly if an older sidecar never acknowledges file audio', async () => {
    vi.useFakeTimers();
    try {
      const gate = new AudioFileBackpressureGate(null);
      for (let index = 0; index < 50; index += 1) gate.markFrameSent();
      const waiting = gate.waitUntilNormal(new AbortController().signal);
      const assertion = expect(waiting).rejects.toBeInstanceOf(AudioFileFlowControlTimeoutError);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  it('allows a batch worker more than 30 seconds to drain without aborting the source', async () => {
    vi.useFakeTimers();
    try {
      const gate = new AudioFileBackpressureGate(null);
      gate.update('falling_behind');
      let resumed = false;
      const waiting = gate.waitUntilNormal(new AbortController().signal).then(() => {
        resumed = true;
      });
      await vi.advanceTimersByTimeAsync(31_000);
      expect(resumed).toBe(false);
      gate.update('normal');
      await waiting;
      expect(resumed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
