import type { QueueBackpressureTier } from '../sidecar/protocol';
import { type AudioFileError, createAudioFileCancellationError } from './audio-file-decoder';

interface BackpressureWaiter {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly signal: AbortSignal;
  readonly timeoutHandle: number | null;
  readonly onAbort: () => void;
}

export class AudioFileBackpressureTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The speech engine queue did not recover within ${String(timeoutMs)} ms.`);
    this.name = 'AudioFileBackpressureTimeoutError';
  }
}

export class AudioFileBackpressureGate {
  private tier: QueueBackpressureTier = 'normal';
  private readonly waiters = new Set<BackpressureWaiter>();

  constructor(private readonly timeoutMs: number | null) {
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('Audio-file backpressure timeout must be a positive number.');
    }
  }

  getTier(): QueueBackpressureTier {
    return this.tier;
  }

  update(tier: QueueBackpressureTier): void {
    this.tier = tier;
    if (tier !== 'normal') {
      return;
    }
    for (const waiter of [...this.waiters]) {
      this.settleWaiter(waiter, () => waiter.resolve());
    }
  }

  waitUntilNormal(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.tier === 'normal' || this.tier === 'catching_up') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: BackpressureWaiter = {
        reject,
        resolve,
        signal,
        timeoutHandle:
          this.timeoutMs === null
            ? null
            : window.setTimeout(() => {
                this.settleWaiter(waiter, () =>
                  reject(new AudioFileBackpressureTimeoutError(this.timeoutMs ?? 0)),
                );
              }, this.timeoutMs),
        onAbort: () => {
          this.settleWaiter(waiter, () => reject(abortReason(signal)));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.add(waiter);
    });
  }

  private settleWaiter(waiter: BackpressureWaiter, settle: () => void): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    if (waiter.timeoutHandle !== null) window.clearTimeout(waiter.timeoutHandle);
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    settle();
  }
}

function abortReason(signal: AbortSignal): AudioFileError {
  return signal.reason instanceof Error && 'code' in signal.reason
    ? (signal.reason as AudioFileError)
    : createAudioFileCancellationError();
}
