export type MediaSourceId = 'local_file' | (string & {});

export type SourceRef =
  | { readonly kind: 'local_file'; readonly fileToken: string }
  | { readonly kind: 'remote_media'; readonly mediaToken: string };

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
  readonly sourceRef: SourceRef;
  readonly temporaryMedia: boolean;
}

export type MediaReadStream = ReadableStream<Uint8Array>;

export interface LocalMediaLease {
  readonly encodedBytes: number;
  readonly mediaId: string;
  readonly provenance: MediaProvenance;
  openReadStream(): Promise<MediaReadStream>;
  release(): Promise<void>;
}

export type AcquisitionEvent =
  | { readonly type: 'plan'; readonly plan: MediaPlan }
  | {
      readonly type: 'progress';
      readonly bytes?: number;
      readonly phase: string;
      readonly totalBytes?: number;
    }
  | { readonly type: 'ready'; readonly lease: LocalMediaLease }
  | { readonly type: 'warning'; readonly code: string; readonly message: string };

export type MediaInspectRequest =
  | { readonly kind: 'interactive_local'; readonly signal: AbortSignal }
  | { readonly kind: 'referenced'; readonly ref: SourceRef; readonly signal: AbortSignal };

export type MediaAcquireRequest =
  | {
      readonly kind: 'interactive_local';
      readonly maxBytes: number;
      readonly maxDurationMs: number;
      readonly signal: AbortSignal;
    }
  | {
      readonly kind: 'referenced';
      readonly maxBytes: number;
      readonly maxDurationMs: number;
      readonly ref: SourceRef;
      readonly signal: AbortSignal;
    };

export interface MediaInspection {
  readonly plan: MediaPlan;
  readonly ref: SourceRef;
}

export interface MediaAcquisition {
  acquire(request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent>;
}

export interface MediaSource extends MediaAcquisition {
  readonly adapterVersion: string;
  readonly id: MediaSourceId;
  inspect(request: MediaInspectRequest): Promise<MediaInspection | null>;
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
