import type { AudioFileBackpressureGate } from '../audio/audio-file-backpressure';
import type { SidecarLifecycleLease } from '../sidecar/sidecar-lifecycle-gate';
import type { AudioFileTranscriptAdapter } from './audio-file-transcript-adapter';

export type AudioFileSessionPhase =
  | 'created'
  | 'starting'
  | 'streaming'
  | 'stop-requested'
  | 'cancel-requested'
  | 'stopped'
  | 'quarantined';

export type AudioFileStartState = 'not-issued' | 'issued' | 'acknowledged';

export interface ManagedAudioFileSessionOptions {
  readonly abortController: AbortController;
  readonly backpressure: AudioFileBackpressureGate;
  readonly sessionId: string;
  readonly speechLease: SidecarLifecycleLease;
  readonly timestamps: AudioFileTranscriptAdapter['timestamps'];
  readonly useNoteAsContext: boolean;
}

export class ManagedAudioFileSession {
  private feedbackClaimed = false;
  private leaseTransferred = false;
  private phase: AudioFileSessionPhase = 'created';
  private startState: AudioFileStartState = 'not-issued';
  private stopTimeoutHandle: number | null = null;
  private readonly completion: Promise<void>;
  private completionFinalized = false;
  private completionResolve: () => void = () => {};

  constructor(
    readonly abortController: AbortController,
    readonly backpressure: AudioFileBackpressureGate,
    readonly sessionId: string,
    readonly speechLease: SidecarLifecycleLease,
    readonly timestamps: AudioFileTranscriptAdapter['timestamps'],
    readonly useNoteAsContext: boolean,
    readonly transcript: AudioFileTranscriptAdapter,
  ) {
    this.completion = new Promise<void>((resolve) => {
      this.completionResolve = resolve;
    });
  }

  static create(
    options: ManagedAudioFileSessionOptions,
    transcript: AudioFileTranscriptAdapter,
  ): ManagedAudioFileSession {
    return new ManagedAudioFileSession(
      options.abortController,
      options.backpressure,
      options.sessionId,
      options.speechLease,
      options.timestamps,
      options.useNoteAsContext,
      transcript,
    );
  }

  getStatus(): AudioFileSessionPhase {
    return this.phase;
  }

  getStartState(): AudioFileStartState {
    return this.startState;
  }

  getCompletion(): Promise<void> {
    return this.completion;
  }

  isTerminal(): boolean {
    return this.phase === 'stopped' || this.phase === 'quarantined';
  }

  isStartIssued(): boolean {
    return this.startState !== 'not-issued';
  }

  isActiveInput(): boolean {
    return this.phase !== 'stopped' && this.phase !== 'quarantined';
  }

  canAcceptSidecarWork(): boolean {
    return this.phase === 'streaming' || this.phase === 'stop-requested';
  }

  markStartIssued(): void {
    if (this.phase !== 'created' && this.phase !== 'starting') {
      throw new Error(`Cannot issue start_session while audio-file phase is ${this.phase}.`);
    }
    if (this.startState !== 'not-issued') {
      throw new Error('The audio-file start command was issued more than once.');
    }
    this.startState = 'issued';
    this.phase = 'starting';
  }

  markStartAcknowledged(): void {
    if (this.startState !== 'issued') {
      throw new Error('The audio-file start command was acknowledged before it was issued.');
    }
    this.startState = 'acknowledged';
    if (this.phase !== 'cancel-requested' && this.phase !== 'stopped' && this.phase !== 'quarantined') {
      this.phase = 'starting';
    }
  }

  markStreaming(): boolean {
    if (this.phase === 'cancel-requested' || this.phase === 'stopped' || this.phase === 'quarantined') {
      return false;
    }
    if (this.startState !== 'acknowledged') {
      throw new Error('The audio-file session cannot stream before start acknowledgement.');
    }
    this.phase = 'streaming';
    return true;
  }

  requestStop(): boolean {
    if (this.phase === 'stop-requested') return false;
    if (this.phase !== 'streaming') {
      throw new Error(`Cannot gracefully stop audio-file phase ${this.phase}.`);
    }
    this.phase = 'stop-requested';
    return true;
  }

  requestCancel(): boolean {
    if (this.phase === 'cancel-requested') return false;
    if (this.phase === 'stopped' || this.phase === 'quarantined') return false;
    this.phase = 'cancel-requested';
    return true;
  }

  claimFeedback(): boolean {
    if (this.feedbackClaimed) return false;
    this.feedbackClaimed = true;
    return true;
  }

  hasClaimedFeedback(): boolean {
    return this.feedbackClaimed;
  }

  setStopTimeout(handle: number): void {
    if (this.stopTimeoutHandle !== null) {
      window.clearTimeout(this.stopTimeoutHandle);
    }
    this.stopTimeoutHandle = handle;
  }

  clearStopTimeout(): void {
    if (this.stopTimeoutHandle === null) return;
    window.clearTimeout(this.stopTimeoutHandle);
    this.stopTimeoutHandle = null;
  }

  markStopped(): boolean {
    if (this.phase === 'stopped') return false;
    if (this.phase === 'quarantined') return false;
    this.phase = 'stopped';
    this.clearStopTimeout();
    this.releaseLease();
    return true;
  }

  markQuarantined(): boolean {
    if (this.phase === 'stopped' || this.phase === 'quarantined') return false;
    this.phase = 'quarantined';
    this.clearStopTimeout();
    return true;
  }

  transferLeaseToQuarantine(): SidecarLifecycleLease {
    if (this.leaseTransferred) {
      throw new Error('The audio-file speech lease was already transferred to quarantine.');
    }
    this.leaseTransferred = true;
    return this.speechLease;
  }

  releaseLease(): void {
    if (this.leaseTransferred) return;
    this.leaseTransferred = true;
    this.speechLease.release();
  }

  complete(): void {
    if (this.completionFinalized) return;
    this.completionFinalized = true;
    this.completionResolve();
  }
}
