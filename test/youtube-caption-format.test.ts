import { describe, expect, it } from 'vitest';
import { formatYouTubeCaptions } from '../src/media/youtube-caption-format';

const videoUrl = 'https://www.youtube.com/watch?v=8MxG6tOkdNY';

describe('YouTube caption formatting', () => {
  const cues = [
    { startMs: 0, endMs: 2_000, text: 'Opening words.', speaker: null },
    { startMs: 30_000, endMs: 32_000, text: 'More context.', speaker: null },
    { startMs: 61_000, endMs: 63_000, text: 'Next passage.', speaker: null },
    { startMs: 122_000, endMs: 124_000, text: 'Closing words.', speaker: null },
  ];

  it('uses the same one-minute passages without visible timestamps', () => {
    expect(formatYouTubeCaptions(cues, { showTimestamps: false, videoUrl })).toBe(
      'Opening words. More context.\n\nNext passage.\n\nClosing words.',
    );
  });

  it('links each passage to its real first caption time', () => {
    expect(
      formatYouTubeCaptions(cues, { intervalMs: 60_000, showTimestamps: true, videoUrl }),
    ).toBe(
      `[0:00](${videoUrl}&t=0s) Opening words. More context.\n\n` +
        `[1:01](${videoUrl}&t=61s) Next passage.\n\n` +
        `[2:02](${videoUrl}&t=122s) Closing words.`,
    );
  });

  it('does not render caption Markdown markers as headings or blockquotes', () => {
    expect(
      formatYouTubeCaptions(
        [{ startMs: 0, endMs: 1_000, text: '# Heading [example]', speaker: null }],
        { showTimestamps: false, videoUrl },
      ),
    ).toBe('\\# Heading \\[example\\]');
    expect(
      formatYouTubeCaptions([{ startMs: 0, endMs: 1_000, text: '1. First point', speaker: null }], {
        showTimestamps: false,
        videoUrl,
      }),
    ).toBe('1\\. First point');
  });

  it('waits briefly for a sentence ending before splitting a timed passage', () => {
    const continuous = [
      { startMs: 0, endMs: 1_000, text: 'Opening.', speaker: null },
      { startMs: 59_000, endMs: 60_000, text: 'I run a couple', speaker: null },
      { startMs: 61_000, endMs: 62_000, text: 'of times a year.', speaker: null },
      { startMs: 64_000, endMs: 65_000, text: 'Next point.', speaker: null },
    ];
    expect(formatYouTubeCaptions(continuous, { showTimestamps: true, videoUrl })).toBe(
      `[0:00](${videoUrl}&t=0s) Opening. I run a couple of times a year.\n\n` +
        `[1:04](${videoUrl}&t=64s) Next point.`,
    );
  });
});
