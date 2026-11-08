import { describe, expect, it } from 'vitest';
import { formatYouTubeCaptions } from '../src/media/youtube-caption-format';
import { parseJson3Captions, parseVttCaptions } from '../src/media/youtube-captions';

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

  it('keeps parser text literal for AI and escapes HTML only in rendered Markdown', () => {
    const json3Cues = parseJson3Captions(
      JSON.stringify({
        events: [
          {
            tStartMs: 0,
            dDurationMs: 1_000,
            segs: [{ utf8: '<script>alert(1)</script>' }],
          },
        ],
      }),
    );
    const vttCues = parseVttCaptions(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Alice>&lt;script&gt;alert(1)&lt;/script&gt;</v>',
    );

    expect(json3Cues[0]?.text).toBe('<script>alert(1)</script>');
    expect(vttCues[0]?.text).toBe('Alice: <script>alert(1)</script>');
    expect(formatYouTubeCaptions(json3Cues, { showTimestamps: false, videoUrl })).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(formatYouTubeCaptions(vttCues, { showTimestamps: false, videoUrl })).toBe(
      'Alice: &lt;script&gt;alert(1)&lt;/script&gt;',
    );
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
