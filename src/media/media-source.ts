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

export interface MediaAcquireRequest<TProvider = never> {
  readonly kind: 'interactive';
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly provider: TProvider;
  readonly signal: AbortSignal;
}

export type LocalMediaAcquireRequest = MediaAcquireRequest<
  { readonly file: File | null } | undefined
>;

export type MediaAcquireRequestBase = Omit<MediaAcquireRequest, 'provider'>;
export type MediaAcquireRequestLike = MediaAcquireRequestBase & { readonly provider: unknown };

export interface MediaTranscriptionEntry<TContext, TRequest extends MediaAcquireRequestLike> {
  readonly createRequest: (context: TContext, request: MediaAcquireRequestBase) => TRequest;
  readonly id: string;
  readonly isEnabled: () => boolean;
  readonly source: MediaSource<TRequest>;
}

export interface MediaAcquisition<
  TRequest extends MediaAcquireRequestLike = MediaAcquireRequest<undefined>,
> {
  acquire(request: TRequest): AsyncIterable<AcquisitionEvent>;
}

export interface MediaSource<
  TRequest extends MediaAcquireRequestLike = MediaAcquireRequest<undefined>,
> extends MediaAcquisition<TRequest> {
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
