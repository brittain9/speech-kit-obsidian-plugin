export const MEDIA_MAX_ENCODED_BYTES = 512 * 1024 * 1024;
// A video can be much larger than its audio track. The local file is streamed
// to a bounded temporary file, so its limit can be higher than an audio-only
// YouTube download without increasing decoded-memory use.
export const LOCAL_MEDIA_MAX_ENCODED_BYTES = 2 * 1024 * 1024 * 1024;
export const MEDIA_MAX_DECODED_BYTES = 192 * 1024 * 1024;
export const MEDIA_MAX_DURATION_MS = 4 * 60 * 60 * 1_000;

export const MEDIA_ACQUISITION_LIMITS = {
  maxBytes: MEDIA_MAX_ENCODED_BYTES,
  maxDurationMs: MEDIA_MAX_DURATION_MS,
} as const;

export const LOCAL_MEDIA_ACQUISITION_LIMITS = {
  maxBytes: LOCAL_MEDIA_MAX_ENCODED_BYTES,
  maxDurationMs: MEDIA_MAX_DURATION_MS,
} as const;
