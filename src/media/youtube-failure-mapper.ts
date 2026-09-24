import type {
  FileWorkflowTranslationKey,
  MediaFailureAdapter,
} from '../dictation/audio-file-failure';
import { YouTubeHelperError, type YouTubeHelperFailureCode } from './youtube-helper';
import { YouTubeAcquisitionError, type YouTubeFailureCode } from './youtube-media-source';

const YOUTUBE_ERROR_KEYS: Readonly<Record<YouTubeFailureCode, FileWorkflowTranslationKey>> = {
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
  integrity_failed: 'youtube.error.integrity_failed',
  rights_not_established: 'youtube.error.rights_not_established',
  helper_unavailable: 'youtube.error.helper_unavailable',
  helper_version_unsupported: 'youtube.error.helper_version_unsupported',
  resource_limit: 'youtube.error.resource_limit',
  tool_failed: 'youtube.error.tool_failed',
  cancelled: 'youtube.error.cancelled',
};

const HELPER_ERROR_KEYS: Readonly<Record<YouTubeHelperFailureCode, FileWorkflowTranslationKey>> = {
  helper_unavailable: 'youtube.error.helper_unavailable',
  helper_version_unsupported: 'youtube.error.helper_version_unsupported',
  resource_limit: 'youtube.error.resource_limit',
  tool_failed: 'youtube.error.helper_probe_failed',
  cancelled: 'youtube.error.cancelled',
};

export const youtubeMediaFailureAdapter: MediaFailureAdapter = {
  isCancellation: (error) =>
    (error instanceof YouTubeAcquisitionError && error.code === 'cancelled') ||
    (error instanceof YouTubeHelperError && error.code === 'cancelled'),
  map: (error) => {
    if (error instanceof YouTubeAcquisitionError) return YOUTUBE_ERROR_KEYS[error.code];
    if (error instanceof YouTubeHelperError) return HELPER_ERROR_KEYS[error.code];
    return null;
  },
  sanitize: (error) => {
    const code =
      error instanceof YouTubeAcquisitionError || error instanceof YouTubeHelperError
        ? error.code
        : 'unknown';
    return { code: `youtube:${code}`, name: 'YouTubeMediaFailure' };
  },
};
