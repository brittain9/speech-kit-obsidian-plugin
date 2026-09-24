export type MediaSourceId = 'local_file' | (string & {});

export type SourceRef =
  | { readonly kind: 'local_file'; readonly fileToken: string }
  | { readonly kind: 'remote_media'; readonly mediaToken: string };

export type RightsEvidence =
  | { readonly kind: 'user_supplied_file' }
  | { readonly kind: 'official_user_owned_export' }
  | { readonly kind: 'platform_permission'; readonly permissionId: string }
  | { readonly kind: 'declared_license'; readonly evidence: string; readonly license: string }
  | { readonly kind: 'maintainer_approved_eligibility'; readonly policyVersion: string };

export interface MediaPlan {
  readonly access: 'local' | 'public_guest' | 'authenticated' | 'unknown';
  readonly displayName: string;
  readonly durationMs?: number;
  readonly estimatedBytes?: number;
  readonly requiresConsent: boolean;
  readonly restrictions: readonly string[];
  readonly sourceId: MediaSourceId;
  readonly warnings: readonly string[];
}

export interface MediaProvenance {
  readonly acquiredAt: string;
  readonly access: MediaPlan['access'];
  readonly adapterVersion: string;
  readonly sourceId: MediaSourceId;
  readonly sourceRef: SourceRef;
  readonly temporaryMedia: boolean;
  readonly rights: RightsEvidence;
}

export type MediaReadStream = ReadableStream<Uint8Array>;

export interface LocalMediaLease {
  readonly encodedBytes: number;
  readonly mediaId: string;
  readonly provenance: MediaProvenance;
  /** Opens an opaque local byte stream. Consumers never receive a path or URL. */
  openReadStream(): Promise<MediaReadStream>;
  /** Idempotently invalidates the local bytes and releases adapter resources. */
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

export type AcquisitionFailureCode =
  | 'cancelled'
  | 'invalid_or_unsupported_url'
  | 'not_found_or_private'
  | 'region_restricted'
  | 'age_restricted'
  | 'membership_required'
  | 'purchase_required'
  | 'drm_protected'
  | 'authentication_required'
  | 'rate_limited'
  | 'extractor_changed'
  | 'rights_not_established'
  | 'tool_unavailable'
  | 'resource_limit'
  | 'unknown';

export interface AcquireRequest {
  readonly maxBytes: number;
  readonly maxDurationMs: number;
  readonly ref: SourceRef;
  readonly rights: RightsEvidence;
  readonly signal: AbortSignal;
}

export interface MediaAcquisition {
  acquire(request: AcquireRequest): AsyncIterable<AcquisitionEvent>;
}

export interface MediaSource extends MediaAcquisition {
  readonly adapterVersion: string;
  readonly id: MediaSourceId;
  inspect(ref: SourceRef, signal: AbortSignal): Promise<MediaPlan>;
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
