import { AudioFileBackpressureTimeoutError } from '../audio/audio-file-backpressure';
import { AudioFileError, isAudioFileCancellation } from '../audio/audio-file-decoder';
import { YouTubeAcquisitionError, type YouTubeFailureCode } from '../media/youtube-media-source';
import { type TranslationKey, t } from '../shared/i18n';
import type { FeedbackRequest, UserFeedback } from '../shared/user-feedback';
import { SidecarError } from '../sidecar/sidecar-connection';
import { SidecarNotInstalledError } from '../sidecar/sidecar-paths';

type YouTubeWorkflowTranslationKey = Extract<TranslationKey, `youtube.error.${string}`>;

export type FileWorkflowTranslationKey =
  | 'audio-file-busy'
  | 'audio-file-decoded-memory'
  | 'audio-file-decode-failed'
  | 'audio-file-desktop-only'
  | 'audio-file-duration'
  | 'audio-file-empty'
  | 'audio-file-encoded-size'
  | 'audio-file-language-unsupported'
  | 'audio-file-language-changed'
  | 'audio-file-maintenance'
  | 'audio-file-model-changed'
  | 'audio-file-model-duration'
  | 'audio-file-model-not-batch'
  | 'audio-file-model-required'
  | 'audio-file-queue-overload'
  | 'audio-file-read-failed'
  | 'audio-file-sidecar-failed'
  | 'audio-file-shutdown-uncertain'
  | 'audio-file-sidecar-missing'
  | 'audio-file-start-failed'
  | 'audio-file-target-changed'
  | 'audio-file-target-closed'
  | 'audio-file-target-deleted'
  | 'audio-file-target-required'
  | 'audio-file-transcript-write-failed'
  | 'audio-file-surface-changed'
  | YouTubeWorkflowTranslationKey;

export class AudioFileWorkflowError extends Error {
  constructor(
    readonly translationKey: FileWorkflowTranslationKey,
    readonly parameters: Record<string, string> = {},
    options?: { cause?: unknown },
  ) {
    super(translationKey, options);
    this.name = 'AudioFileWorkflowError';
  }
}

interface FeedbackClaim {
  claimFeedback(): boolean;
}

interface AudioFileFailureMapperDependencies {
  readonly feedback: Pick<UserFeedback, 'show'>;
  readonly onModelMissing?: () => void;
  readonly onSidecarMissing?: () => void;
}

export class AudioFileFailureMapper {
  constructor(private readonly dependencies: AudioFileFailureMapperDependencies) {}

  reportFailure(error: unknown, claim?: FeedbackClaim): void {
    if (error instanceof SidecarNotInstalledError) {
      this.report('audio-file-sidecar-missing', error, claim);
      return;
    }
    this.report(resolveWorkflowTranslationKey(error), error, claim);
  }

  reportTranslation(
    translationKey: FileWorkflowTranslationKey,
    cause: unknown,
    claim?: FeedbackClaim,
  ): void {
    this.report(translationKey, cause, claim);
  }

  isCancellation(error: unknown): boolean {
    return (
      isAudioFileCancellation(error) ||
      (error instanceof YouTubeAcquisitionError && error.code === 'cancelled')
    );
  }

  isQueueAbort(error: unknown): boolean {
    return error instanceof AudioFileError && error.code === 'queue_overload';
  }

  isNoActiveSession(error: unknown, expectedSessionId?: string): boolean {
    return (
      error instanceof SidecarError &&
      error.code === 'no_active_session' &&
      (expectedSessionId === undefined || error.sessionId === expectedSessionId)
    );
  }

  private report(
    translationKey: FileWorkflowTranslationKey,
    cause: unknown,
    claim?: FeedbackClaim,
  ): void {
    if (claim !== undefined && !claim.claimFeedback()) {
      return;
    }
    this.dependencies.feedback.show({
      cause,
      intent: resolveFeedbackIntent(translationKey),
      key: translationKey,
      message: t(translationKey, translationParameters(translationKey, cause)),
    });
    if (translationKey === 'audio-file-sidecar-missing') {
      this.dependencies.onSidecarMissing?.();
    }
    if (translationKey === 'audio-file-model-required') {
      this.dependencies.onModelMissing?.();
    }
  }
}

const YOUTUBE_ERROR_KEYS: Readonly<Record<YouTubeFailureCode, YouTubeWorkflowTranslationKey>> = {
  invalid_or_unsupported_url: 'youtube.error.invalid_url',
  not_found_or_private: 'youtube.error.not_found_private',
  region_restricted: 'youtube.error.region_restricted',
  age_restricted: 'youtube.error.age_restricted',
  membership_required: 'youtube.error.membership_required',
  purchase_required: 'youtube.error.purchase_required',
  drm_protected: 'youtube.error.drm_protected',
  authentication_required: 'youtube.error.authentication_required',
  rate_limited: 'youtube.error.rate_limited',
  network_failed: 'youtube.error.network_failed',
  extractor_changed: 'youtube.error.extractor_changed',
  live_stream: 'youtube.error.live_stream',
  rights_not_established: 'youtube.error.rights_not_established',
  helper_unavailable: 'youtube.error.helper_unavailable',
  helper_version_unsupported: 'youtube.error.helper_version_unsupported',
  resource_limit: 'youtube.error.resource_limit',
  tool_failed: 'youtube.error.tool_failed',
  cancelled: 'youtube.error.cancelled',
};

function resolveWorkflowTranslationKey(error: unknown): FileWorkflowTranslationKey {
  if (error instanceof AudioFileWorkflowError) {
    return error.translationKey;
  }
  if (error instanceof SidecarError) {
    return error.code === 'session_capacity_exceeded'
      ? 'audio-file-start-failed'
      : 'audio-file-sidecar-failed';
  }
  if (error instanceof AudioFileError) {
    switch (error.code) {
      case 'cancelled':
        return 'audio-file-busy';
      case 'decoded_memory':
        return 'audio-file-decoded-memory';
      case 'decode_failed':
      case 'invalid_decode':
        return 'audio-file-decode-failed';
      case 'duration':
        return 'audio-file-duration';
      case 'encoded_size':
        return 'audio-file-encoded-size';
      case 'empty':
        return 'audio-file-empty';
      case 'model_duration':
        return 'audio-file-model-duration';
      case 'queue_overload':
        return 'audio-file-queue-overload';
      case 'read_failed':
        return 'audio-file-read-failed';
      case 'sidecar_failed':
        return 'audio-file-sidecar-failed';
    }
  }
  if (error instanceof YouTubeAcquisitionError) {
    return YOUTUBE_ERROR_KEYS[error.code];
  }
  if (error instanceof AudioFileBackpressureTimeoutError) {
    return 'audio-file-queue-overload';
  }
  return 'audio-file-start-failed';
}

function resolveFeedbackIntent(
  translationKey: FileWorkflowTranslationKey,
): FeedbackRequest['intent'] {
  if (
    translationKey === 'audio-file-maintenance' ||
    translationKey === 'audio-file-queue-overload'
  ) {
    return 'warning';
  }
  if (
    translationKey === 'audio-file-language-unsupported' ||
    translationKey === 'audio-file-model-changed' ||
    translationKey === 'audio-file-model-not-batch' ||
    translationKey === 'audio-file-model-required'
  ) {
    return 'action-required';
  }
  return 'error';
}

function translationParameters(
  translationKey: FileWorkflowTranslationKey,
  error: unknown,
): Record<string, string> {
  if (
    translationKey === 'audio-file-language-unsupported' &&
    error instanceof AudioFileWorkflowError
  ) {
    return error.parameters;
  }
  return {};
}
