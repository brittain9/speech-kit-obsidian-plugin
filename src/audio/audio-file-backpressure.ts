import type { QueueBackpressureTier } from '../sidecar/protocol';
import { type AudioFileError, createAudioFileCancellationError } from './audio-file-decoder';

interface BackpressureWaiter {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  readonly signal: AbortSignal;
  timeoutHandle: number | null;
  timeoutKind: 'file-progress' | 'queue' | null;
  readonly onAbort: () => void;
}

const MAX_UNCONSUMED_FILE_FRAMES = 50;
const FILE_PROGRESS_TIMEOUT_MS = 30_000;

export class AudioFileFlowControlTimeoutError extends Error {
  constructor() {
    super(
      'The speech engine did not acknowledge file audio within 30 seconds. Update the native sidecar and try again.',
    );
    this.name = 'AudioFileFlowControlTimeoutError';
  }
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
  private sentFrames = 0;
  private consumedFrames = 0;

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
    this.resumeIfReady();
  }

  markFrameSent(): void {
    this.sentFrames += 1;
  }

  acknowledgeFramesConsumed(framesConsumed: number): void {
    if (!Number.isSafeInteger(framesConsumed) || framesConsumed < 0) return;
    this.consumedFrames = Math.max(this.consumedFrames, framesConsumed);
    this.resumeIfReady();
  }

  waitUntilNormal(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.canSendFrame()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: BackpressureWaiter = {
        reject,
        resolve,
        signal,
        timeoutHandle: null,
        timeoutKind: null,
        onAbort: () => {
          this.settleWaiter(waiter, () => reject(abortReason(signal)));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.add(waiter);
      this.refreshWaiterTimeout(waiter);
    });
  }

  private canSendFrame(): boolean {
    return (
      this.tier === 'normal' && this.sentFrames - this.consumedFrames < MAX_UNCONSUMED_FILE_FRAMES
    );
  }

  private resumeIfReady(): void {
    for (const waiter of [...this.waiters]) {
      if (this.canSendFrame()) {
        this.settleWaiter(waiter, () => waiter.resolve());
      } else {
        this.refreshWaiterTimeout(waiter);
      }
    }
  }

  private refreshWaiterTimeout(waiter: BackpressureWaiter): void {
    const timeoutKind =
      this.tier === 'normal' ? 'file-progress' : this.timeoutMs === null ? null : 'queue';
    if (waiter.timeoutKind === timeoutKind) return;

    if (waiter.timeoutHandle !== null) window.clearTimeout(waiter.timeoutHandle);
    waiter.timeoutHandle = null;
    waiter.timeoutKind = timeoutKind;
    if (timeoutKind === null) return;

    const timeoutMs = timeoutKind === 'file-progress' ? FILE_PROGRESS_TIMEOUT_MS : this.timeoutMs;
    if (timeoutMs === null) return;

    waiter.timeoutHandle = window.setTimeout(() => {
      this.settleWaiter(waiter, () => {
        waiter.reject(
          timeoutKind === 'file-progress'
            ? new AudioFileFlowControlTimeoutError()
            : new AudioFileBackpressureTimeoutError(timeoutMs),
        );
      });
    }, timeoutMs);
  }

  private settleWaiter(waiter: BackpressureWaiter, settle: () => void): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    if (waiter.timeoutHandle !== null) window.clearTimeout(waiter.timeoutHandle);
    waiter.timeoutHandle = null;
    waiter.timeoutKind = null;
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    settle();
  }
}

function abortReason(signal: AbortSignal): AudioFileError {
  return signal.reason instanceof Error && 'code' in signal.reason
    ? (signal.reason as AudioFileError)
    : createAudioFileCancellationError();
}
