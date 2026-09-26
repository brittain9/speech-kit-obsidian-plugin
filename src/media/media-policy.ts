export const MEDIA_MAX_ENCODED_BYTES = 64 * 1024 * 1024;
export const MEDIA_MAX_DECODED_BYTES = 192 * 1024 * 1024;
export const MEDIA_MAX_DURATION_MS = 30 * 60 * 1_000;

export const MEDIA_ACQUISITION_LIMITS = {
  maxBytes: MEDIA_MAX_ENCODED_BYTES,
  maxDurationMs: MEDIA_MAX_DURATION_MS,
} as const;
