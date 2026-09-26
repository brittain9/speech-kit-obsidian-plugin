import type { DictationLanguage } from '../language/dictation-language';
import { t } from '../shared/i18n';
import { canonicalYouTubeUrl, type YouTubeVideoRef } from './youtube-url';

const PLAYER_URL =
  'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const IOS_CLIENT_VERSION = '20.10.38';
const IOS_USER_AGENT =
  'com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';
export const CAPTION_MAX_BYTES = 16 * 1024 * 1024;
export const CAPTION_TIMEOUT_MS = 60_000;

export interface CaptionCue {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: string | null;
}

export interface CaptionResult {
  readonly cues: readonly CaptionCue[];
  readonly language: string;
  readonly source: 'creator_captions' | 'automatic_captions';
  readonly videoUrl: string;
}

export interface CaptionHttpClient {
  request(input: {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<string>;
}

export class CaptionAcquisitionError extends Error {
  constructor(
    readonly code: 'unavailable' | 'access' | 'ambiguous_language' | 'cancelled',
    message: string,
    readonly availableLanguages: readonly string[] = [],
  ) {
    super(message);
    this.name = 'CaptionAcquisitionError';
  }
}

interface CaptionTrack {
  readonly baseUrl?: unknown;
  readonly languageCode?: unknown;
  readonly kind?: unknown;
  readonly isTranslatable?: unknown;
}

interface PlayerData {
  readonly captions?: {
    readonly playerCaptionsTracklistRenderer?: { readonly captionTracks?: unknown };
  };
  readonly playabilityStatus?: { readonly status?: unknown; readonly reason?: unknown };
  readonly videoDetails?: {
    readonly isLiveContent?: unknown;
    readonly defaultAudioLanguage?: unknown;
    readonly lengthSeconds?: unknown;
  };
}

/** Fast, helper-free caption path. YouTube's player endpoint is unofficial and isolated here. */
export async function fetchDirectYouTubeCaptions(
  ref: YouTubeVideoRef,
  language: DictationLanguage,
  http: CaptionHttpClient,
  signal: AbortSignal,
): Promise<CaptionResult | null> {
  const deadline = Date.now() + CAPTION_TIMEOUT_MS;
  const body = JSON.stringify({
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: IOS_CLIENT_VERSION,
        hl: language === 'auto' ? 'en' : language,
        gl: 'US',
      },
    },
    videoId: ref.videoId,
  });
  let metadata: PlayerData;
  try {
    const response = await requestBoundedCaptionText(
      http,
      {
        url: PLAYER_URL,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': IOS_USER_AGENT,
        },
        body,
      },
      signal,
      deadline,
      4 * 1024 * 1024,
    );
    const parsed: unknown = JSON.parse(response);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid YouTube player response.');
    }
    metadata = parsed;
  } catch (error) {
    if (signal.aborted) throw cancellationError(signal);
    if (error instanceof CaptionAcquisitionError) throw error;
    throw new CaptionAcquisitionError('unavailable', t('youtube.caption.checkFailed'));
  }
  const status = metadata.playabilityStatus?.status;
  if (
    status === 'LOGIN_REQUIRED' ||
    status === 'UNPLAYABLE' ||
    status === 'AGE_CHECK_REQUIRED' ||
    status === 'CONTENT_CHECK_REQUIRED'
  ) {
    throw new CaptionAcquisitionError(
      'access',
      playerReason(metadata.playabilityStatus?.reason, t('youtube.caption.restricted')),
    );
  }
  if (
    status === 'ERROR' ||
    status === 'LIVE_STREAM_OFFLINE' ||
    metadata.videoDetails?.isLiveContent === true
  ) {
    throw new CaptionAcquisitionError(
      'unavailable',
      playerReason(metadata.playabilityStatus?.reason, t('youtube.caption.unavailable')),
    );
  }
  const tracks = metadata.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks))
    throw new CaptionAcquisitionError('unavailable', t('youtube.modal.noCaptions'));
  const candidates = selectCaptionTracks(
    tracks as CaptionTrack[],
    language,
    metadata.videoDetails?.defaultAudioLanguage,
  );
  if (candidates.length === 0)
    throw new CaptionAcquisitionError('unavailable', t('youtube.caption.languageUnavailable'));

  for (const selected of candidates) {
    let captionUrl: URL;
    try {
      captionUrl = new URL(selected.baseUrl as string);
      if (
        captionUrl.protocol !== 'https:' ||
        !['www.youtube.com', 'youtube.com'].includes(captionUrl.hostname) ||
        captionUrl.pathname !== '/api/timedtext'
      )
        continue;
      captionUrl.searchParams.delete('tlang');
    } catch {
      continue;
    }
    let cues: CaptionCue[] = [];
    for (const format of ['json3', 'vtt'] as const) {
      try {
        captionUrl.searchParams.set('fmt', format);
        const payload = await requestBoundedCaptionText(
          http,
          { url: captionUrl.toString(), method: 'GET' },
          signal,
          deadline,
          CAPTION_MAX_BYTES,
        );
        const parsedCues =
          format === 'json3' ? parseJson3Captions(payload) : parseVttCaptions(payload);
        if (parsedCues.length > 0) {
          validateCaptionCoverage(parsedCues, metadata.videoDetails?.lengthSeconds);
          cues = parsedCues;
          break;
        }
      } catch {
        if (signal.aborted) throw cancellationError(signal);
      }
    }
    if (cues.length > 0) {
      return {
        cues,
        language: selected.languageCode as string,
        source: selected.kind === 'asr' ? 'automatic_captions' : 'creator_captions',
        videoUrl: canonicalYouTubeUrl(ref.videoId),
      };
    }
  }
  throw new CaptionAcquisitionError('unavailable', t('youtube.caption.readFailed'));
}

export function selectCaptionTrack(
  tracks: readonly CaptionTrack[],
  language: DictationLanguage,
  originalLanguage: unknown,
): CaptionTrack | null {
  return selectCaptionTracks(tracks, language, originalLanguage)[0] ?? null;
}

function selectCaptionTracks(
  tracks: readonly CaptionTrack[],
  language: DictationLanguage,
  originalLanguage: unknown,
): CaptionTrack[] {
  const available = tracks.filter((track) => {
    if (
      typeof track.languageCode !== 'string' ||
      typeof track.baseUrl !== 'string' ||
      track.languageCode === 'live_chat'
    )
      return false;
    try {
      return !new URL(track.baseUrl).searchParams.has('tlang');
    } catch {
      return false;
    }
  });
  const requested =
    language === 'auto'
      ? typeof originalLanguage === 'string'
        ? originalLanguage
        : null
      : language;
  if (requested === null) {
    const languages = [...new Set(available.map((track) => track.languageCode as string))];
    if (languages.length > 1)
      throw new CaptionAcquisitionError(
        'ambiguous_language',
        t('youtube.caption.chooseLanguage'),
        languages,
      );
    if (languages.length === 0) return [];
  }
  const target = requested ?? available[0]?.languageCode;
  if (typeof target !== 'string') return [];
  const base = target.split('-')[0];
  const matching = available.filter(
    (track) =>
      track.languageCode === target || (track.languageCode as string).split('-')[0] === base,
  );
  return matching.sort((a, b) => {
    const creatorFirst = Number(a.kind === 'asr') - Number(b.kind === 'asr');
    return creatorFirst || Number(b.languageCode === target) - Number(a.languageCode === target);
  });
}

export function parseJson3Captions(payload: string): CaptionCue[] {
  if (Buffer.byteLength(payload, 'utf8') > CAPTION_MAX_BYTES)
    throw new Error('Caption response is too large.');
  const parsed = JSON.parse(payload) as { events?: unknown };
  if (!Array.isArray(parsed.events)) throw new Error('Invalid caption response.');
  const cues: CaptionCue[] = [];
  for (const item of parsed.events) {
    if (typeof item !== 'object' || item === null) continue;
    const event = item as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown };
    if (!Array.isArray(event.segs)) continue;
    const text = event.segs
      .map((segment: unknown) => {
        if (typeof segment !== 'object' || segment === null) return '';
        return typeof (segment as { utf8?: unknown }).utf8 === 'string'
          ? (segment as { utf8: string }).utf8
          : '';
      })
      .join('')
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (text.length === 0) continue;
    if (
      !Number.isSafeInteger(event.tStartMs) ||
      !Number.isSafeInteger(event.dDurationMs) ||
      (event.tStartMs as number) < 0 ||
      (event.dDurationMs as number) <= 0
    ) {
      throw new Error('Caption cue has invalid timestamps.');
    }
    const startMs = event.tStartMs as number;
    const endMs = startMs + (event.dDurationMs as number);
    if (!Number.isSafeInteger(endMs) || endMs > 24 * 60 * 60 * 1_000) {
      throw new Error('Caption cue is outside the supported duration.');
    }
    if (cues.at(-1) !== undefined && startMs < (cues.at(-1)?.startMs ?? 0)) {
      throw new Error('Caption cues are out of order.');
    }
    appendCue(cues, { startMs, endMs, text, speaker: null });
  }
  if (cues.length === 0) throw new Error('The caption response contained no timed text.');
  return cues;
}

export function parseVttCaptions(payload: string): CaptionCue[] {
  if (Buffer.byteLength(payload, 'utf8') > CAPTION_MAX_BYTES || !payload.startsWith('WEBVTT')) {
    throw new Error('Invalid WebVTT caption response.');
  }
  const cues: CaptionCue[] = [];
  for (const block of payload.replace(/\r\n?/gu, '\n').split(/\n\s*\n/u)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const match =
      /^\s*(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})\.(\d{3})/u.exec(
        lines[timingIndex] ?? '',
      );
    if (match === null) continue;
    const startMs =
      Number(match[1]?.slice(0, -1) ?? 0) * 3_600_000 +
      Number(match[2]) * 60_000 +
      Number(match[3]) * 1_000 +
      Number(match[4]);
    const endMs =
      Number(match[5]?.slice(0, -1) ?? 0) * 3_600_000 +
      Number(match[6]) * 60_000 +
      Number(match[7]) * 1_000 +
      Number(match[8]);
    if (endMs <= startMs || endMs > 24 * 60 * 60 * 1_000) continue;
    if (cues.at(-1) !== undefined && startMs < (cues.at(-1)?.startMs ?? 0)) {
      throw new Error('Caption cues are out of order.');
    }
    const raw = lines.slice(timingIndex + 1).join(' ');
    const speaker = /<v\s+([^>]+)>/iu.exec(raw)?.[1]?.trim() ?? null;
    const text = decodeCaptionEntities(raw.replace(/<[^>]*>/gu, ''))
      .replace(/\p{Cc}/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (text.length === 0) continue;
    appendCue(cues, {
      startMs,
      endMs,
      text: speaker === null ? text : `${speaker}: ${text}`,
      speaker,
    });
  }
  return cues;
}

function decodeCaptionEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (entity) => {
    const named: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    };
    if (entity in named) return named[entity] ?? entity;
    const hex = entity.startsWith('&#x');
    const value = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : entity;
  });
}

function appendCue(cues: CaptionCue[], cue: CaptionCue): void {
  const prior = cues.at(-1);
  if (prior?.text === cue.text) {
    if (Math.abs(prior.startMs - cue.startMs) > 100 || Math.abs(prior.endMs - cue.endMs) > 100)
      cues.push(cue);
    return;
  }
  const overlap =
    prior !== undefined && cue.startMs < prior.endMs ? rollingWordOverlap(prior.text, cue.text) : 0;
  if (overlap > 0) {
    const suffix = cue.text.split(/\s+/u).slice(overlap).join(' ').trim();
    if (suffix.length > 0) cues.push({ ...cue, text: suffix });
  } else {
    cues.push(cue);
  }
}

function rollingWordOverlap(previous: string, next: string): number {
  const left = previous.split(/\s+/u);
  const right = next.split(/\s+/u);
  for (let count = Math.min(left.length, right.length); count >= 2; count -= 1) {
    if (left.slice(-count).join(' ') === right.slice(0, count).join(' ')) return count;
  }
  return 0;
}

export async function requestBoundedCaptionText(
  http: CaptionHttpClient,
  request: Parameters<CaptionHttpClient['request']>[0],
  signal: AbortSignal,
  deadline: number,
  maxBytes: number,
): Promise<string> {
  if (signal.aborted) throw cancellationError(signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Caption retrieval timed out.');
  let timer: number | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('Caption retrieval timed out.')), remaining);
      abortListener = () => reject(cancellationError(signal));
      signal.addEventListener('abort', abortListener, { once: true });
    });
    const response = await Promise.race([http.request(request), timeout]);
    if (Buffer.byteLength(response, 'utf8') > maxBytes)
      throw new Error('Caption response is too large.');
    return response;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

function validateCaptionCoverage(cues: readonly CaptionCue[], duration: unknown): void {
  const seconds = typeof duration === 'string' ? Number(duration) : duration;
  const lastCue = cues.at(-1);
  if (lastCue === undefined) throw new Error('The caption response was empty.');
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
  const durationMs = seconds * 1_000;
  const permittedTailMs = Math.max(120_000, durationMs * 0.03);
  if (durationMs - lastCue.endMs > permittedTailMs) {
    throw new Error('YouTube returned an incomplete caption track.');
  }
}

function cancellationError(signal: AbortSignal): CaptionAcquisitionError {
  if (signal.reason instanceof CaptionAcquisitionError && signal.reason.code === 'cancelled') {
    return signal.reason;
  }
  return new CaptionAcquisitionError('cancelled', t('youtube.caption.cancelled'));
}

function playerReason(reason: unknown, fallback: string): string {
  return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : fallback;
}
