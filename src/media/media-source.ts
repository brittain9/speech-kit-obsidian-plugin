export type MediaSourceId = 'local_file' | 'youtube_yt_dlp' | (string & {});

export type SourceRef =
  | { readonly kind: 'local_file'; readonly fileToken: string }
  | { readonly kind: 'youtube_video_id'; readonly videoId: string };

export type MediaRights =
  | { readonly kind: 'user_supplied_file' }
  | { readonly kind: 'declared_by_source'; readonly policyVersion: string };

export interface MediaPlan {
  readonly displayName: string;
  readonly estimatedBytes?: number;
  readonly sourceId: MediaSourceId;
  readonly canonicalUrl?: string;
  readonly host?: string;
  readonly videoId?: string;
  readonly durationMs?: number;
  readonly requiresConsent?: boolean;
  readonly warnings?: readonly string[];
  readonly access?: 'local' | 'public_guest' | 'authenticated' | 'unknown';
  readonly restrictions?: readonly string[];
}

export interface MediaProvenance {
  readonly acquiredAt: string;
  readonly adapterVersion: string;
  readonly rights: MediaRights;
  readonly sourceId: MediaSourceId;
  readonly temporaryMedia: boolean;
  readonly sourceRef?: SourceRef;
  readonly canonicalUrl?: string;
  readonly title?: string;
  readonly channel?: { readonly id?: string; readonly name?: string };
  readonly durationMs?: number;
  readonly helperVersion?: string;
  readonly container?: string;
  readonly codec?: string;
}

export type MediaReadStream = ReadableStream<Uint8Array>;

/** Provider-neutral temporary access to acquired media bytes. */
export interface MediaLease {
  readonly encodedBytes: number;
  readonly mediaId: string;
  readonly provenance: MediaProvenance;
  openReadStream(): Promise<MediaReadStream>;
  release(): Promise<void>;
  /** Optional lifecycle hook for owners that need to dispose a lease eagerly. */
  dispose?(): Promise<void>;
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

export type AcquisitionFailureCode =
  | 'invalid_or_unsupported_url'
  | 'not_found_or_private'
  | 'region_restricted'
  | 'age_restricted'
  | 'membership_required'
  | 'purchase_required'
  | 'drm_protected'
  | 'authentication_required'
  | 'rate_limited'
  | 'network_failed'
  | 'extractor_changed'
  | 'rights_not_established'
  | 'helper_unavailable'
  | 'helper_version_unsupported'
  | 'resource_limit'
  | 'tool_failed'
  | 'cancelled';

export interface MediaAcquireRequest {
  readonly kind: 'interactive';
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly signal: AbortSignal;
  readonly ref?: SourceRef;
  readonly rights?: MediaRights;
  readonly consentId?: string;
}

export interface MediaAcquisition {
  acquire(request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent>;
}

export interface MediaSource extends MediaAcquisition {
  readonly adapterVersion: string;
  readonly id: MediaSourceId;
  inspect?(ref: SourceRef, signal: AbortSignal): Promise<MediaPlan>;
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
