import type { CaptionCue } from './youtube-captions';

const DEFAULT_GROUP_MS = 60_000;
const MAX_GROUP_CHARS = 1_800;
const SENTENCE_GRACE_MS = 15_000;

export interface YouTubeCaptionFormatOptions {
  readonly intervalMs?: number;
  readonly showTimestamps: boolean;
  readonly videoUrl: string;
}

/** Caption cues are already timed by YouTube. Group at the next cue after each
 * interval, keeping every cue intact and limiting unusually dense passages. */
export function formatYouTubeCaptions(
  cues: readonly CaptionCue[],
  options: YouTubeCaptionFormatOptions,
): string {
  if (cues.length === 0) return '';
  const intervalMs = options.showTimestamps
    ? (options.intervalMs ?? DEFAULT_GROUP_MS)
    : DEFAULT_GROUP_MS;
  const groups: Array<{ startMs: number; text: string }> = [];
  let startMs = cues[0]?.startMs ?? 0;
  let text = '';
  let previousEndedSentence = false;

  for (const cue of cues) {
    const words = escapeCaptionMarkdown(cue.text.trim());
    if (words.length === 0) continue;
    const ageMs = cue.startMs - startMs;
    const dueAtSentence = ageMs >= intervalMs && previousEndedSentence;
    const pastGrace = ageMs >= intervalMs + SENTENCE_GRACE_MS;
    const tooLong = text.length + words.length + 1 > MAX_GROUP_CHARS;
    if (text.length > 0 && (dueAtSentence || pastGrace || tooLong)) {
      groups.push({ startMs, text });
      startMs = cue.startMs;
      text = '';
    }
    text += text.length === 0 ? words : ` ${words}`;
    previousEndedSentence = /[.!?]["'”’)?\]]*$/u.test(cue.text.trim());
  }
  if (text.length > 0) groups.push({ startMs, text });

  return groups
    .map(({ startMs: groupStart, text: groupText }) => {
      if (!options.showTimestamps) return groupText;
      const seconds = Math.floor(groupStart / 1_000);
      const separator = options.videoUrl.includes('?') ? '&' : '?';
      return `[${formatVideoTime(seconds)}](${options.videoUrl}${separator}t=${seconds}s) ${groupText}`;
    })
    .join('\n\n');
}

function formatVideoTime(totalSeconds: number): string {
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`;
}

function escapeCaptionMarkdown(text: string): string {
  return text
    .replace(/\\/gu, '\\\\')
    .replace(/([*_`[\]])/gu, '\\$1')
    .replace(/^([#>+-])(?=\s)/u, '\\$1')
    .replace(/^(\d+)([.)])(?=\s)/u, '$1\\$2')
    .replace(/^(-{3,})(?=\s|$)/u, '\\$1');
}
