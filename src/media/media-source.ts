export type MediaSourceId = 'local_file' | (string & {});

export type MediaRights =
  | { readonly kind: 'user_supplied_file' }
  | { readonly kind: 'declared_by_source'; readonly policyVersion: string };

export interface MediaPlan {
  readonly displayName: string;
  readonly estimatedBytes?: number;
  readonly sourceId: MediaSourceId;
}

export interface MediaProvenance {
  readonly acquiredAt: string;
  readonly adapterVersion: string;
  readonly rights: MediaRights;
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

/** The local adapter's concrete lease type; consumers depend on MediaLease. */
export type LocalMediaLease = MediaLease;

export type AcquisitionEvent =
  | { readonly type: 'plan'; readonly plan: MediaPlan }
  | {
      readonly type: 'progress';
      readonly bytes?: number;
      readonly phase: string;
      readonly totalBytes?: number;
    }
  | { readonly type: 'ready'; readonly lease: MediaLease }
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
