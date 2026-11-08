export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
export const YOUTUBE_CANONICAL_HOST = 'www.youtube.com';
export const YOUTUBE_CANONICAL_URL_PREFIX = 'https://www.youtube.com/watch?v=';

const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_PATH_PREFIX = '/shorts/';
const VIDEO_ID_PARAMETER = 'v';

export class InvalidYouTubeUrlError extends Error {
  readonly code = 'invalid_or_unsupported_url' as const;

  constructor(message = 'Enter one YouTube video URL.') {
    super(message);
    this.name = 'InvalidYouTubeUrlError';
  }
}

export interface YouTubeVideoRef {
  readonly kind: 'youtube_video_id';
  readonly videoId: string;
  readonly host: string;
  readonly canonicalUrl: string;
  readonly inputUrl: string;
}

export function parseYouTubeVideoUrl(input: string): YouTubeVideoRef {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) throw new InvalidYouTubeUrlError();

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidYouTubeUrlError();
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.port.length > 0
  ) {
    throw new InvalidYouTubeUrlError();
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    return createRef(host, decodeSinglePathSegment(parsed.pathname));
  }

  if (!WATCH_HOSTS.has(host) && !SHORT_HOSTS.has(host)) {
    throw new InvalidYouTubeUrlError();
  }

  if (parsed.pathname === '/watch') {
    const values = parsed.searchParams.getAll(VIDEO_ID_PARAMETER);
    if (values.length !== 1) throw new InvalidYouTubeUrlError();
    return createRef(host, values[0]);
  }

  if (parsed.pathname.startsWith(SHORT_PATH_PREFIX)) {
    return createRef(
      host,
      decodeSinglePathSegment(`/${parsed.pathname.slice(SHORT_PATH_PREFIX.length)}`),
    );
  }

  throw new InvalidYouTubeUrlError();
}

export const inspectYouTubeVideoUrl = parseYouTubeVideoUrl;
export const parseYouTubeUrl = parseYouTubeVideoUrl;

export function canonicalYouTubeUrl(videoId: string): string {
  assertVideoId(videoId);
  return `${YOUTUBE_CANONICAL_URL_PREFIX}${videoId}`;
}

export function isYouTubeVideoId(value: string): boolean {
  return YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

export function toYouTubeSourceRef(input: string): YouTubeVideoRef {
  return parseYouTubeVideoUrl(input);
}

export function assertVideoId(value: string): asserts value is string {
  if (!isYouTubeVideoId(value)) throw new InvalidYouTubeUrlError();
}

function createRef(host: string, videoId: string | undefined): YouTubeVideoRef {
  if (videoId === undefined || !isYouTubeVideoId(videoId)) {
    throw new InvalidYouTubeUrlError();
  }
  return {
    canonicalUrl: canonicalYouTubeUrl(videoId),
    host,
    inputUrl: `https://${host}/`,
    kind: 'youtube_video_id',
    videoId,
  };
}

function decodeSinglePathSegment(value: string): string | undefined {
  if (!value.startsWith('/') || value.endsWith('/')) return undefined;
  const segment = value.slice(1);
  if (segment.includes('/')) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
