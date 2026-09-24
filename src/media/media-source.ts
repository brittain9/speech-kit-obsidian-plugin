export type MediaSourceId = string;

export interface MediaPlan {
  readonly displayName: string;
  readonly estimatedBytes?: number;
  readonly sourceId: MediaSourceId;
}

export interface MediaProvenance {
  readonly acquiredAt: string;
  readonly adapterVersion: string;
  readonly sourceId: MediaSourceId;
  readonly temporaryMedia: boolean;
}

export type MediaReadStream = ReadableStream<Uint8Array>;

/** Provider-neutral temporary access to acquired media bytes. */
export interface MediaLease {
  readonly encodedBytes: number;
  readonly mediaId: string;
  readonly provenance: MediaProvenance;
  openReadStream(): Promise<MediaReadStream>;
  release(): Promise<void>;
}

export type LocalMediaLease = MediaLease;

export type AcquisitionEvent<TLease extends MediaLease = MediaLease> =
  | { readonly type: 'plan'; readonly plan: MediaPlan }
  | {
      readonly type: 'progress';
      readonly bytes?: number;
      readonly phase: string;
      readonly totalBytes?: number;
    }
  | { readonly type: 'ready'; readonly lease: TLease }
  | { readonly type: 'warning'; readonly code: string; readonly message: string };

export interface MediaAcquireRequest {
  readonly kind: 'interactive';
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly signal: AbortSignal;
}

export interface MediaAcquisition {
  acquire(request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent>;
}

export interface MediaSource extends MediaAcquisition {
  readonly adapterVersion: string;
  readonly id: MediaSourceId;
}

export type MediaTranscriptionProgressPhase =
  | 'acquire'
  | 'decode'
  | 'transcribe'
  | 'format'
  | 'ai_processing'
  | 'insert';

export interface MediaTranscriptionProgress {
  readonly phase: MediaTranscriptionProgressPhase;
  readonly bytes?: number;
  readonly totalBytes?: number;
}
