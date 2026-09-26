import { describe, expect, it, vi } from 'vitest';
import {
  CaptionAcquisitionError,
  fetchDirectYouTubeCaptions,
  parseJson3Captions,
  parseVttCaptions,
  selectCaptionTrack,
} from '../src/media/youtube-captions';
import { parseYouTubeVideoUrl } from '../src/media/youtube-url';

const ref = parseYouTubeVideoUrl('https://www.youtube.com/watch?v=8MxG6tOkdNY&t=407s');
const baseUrl = 'https://www.youtube.com/api/timedtext?v=8MxG6tOkdNY&lang=en';

describe('YouTube captions', () => {
  it('selects creator captions in the requested language before generated captions', () => {
    const selected = selectCaptionTrack(
      [
        { baseUrl, languageCode: 'en-US' },
        { baseUrl, languageCode: 'en', kind: 'asr' },
        { baseUrl, languageCode: 'en' },
        { baseUrl, languageCode: 'es' },
      ],
      'en',
      undefined,
    );
    expect(selected?.languageCode).toBe('en');
    expect(selected?.kind).toBeUndefined();
  });

  it('prefers a regional creator track over exact-language automatic captions', () => {
    const selected = selectCaptionTrack(
      [
        { baseUrl, languageCode: 'en', kind: 'asr' },
        { baseUrl, languageCode: 'en-US' },
      ],
      'en',
      undefined,
    );
    expect(selected?.languageCode).toBe('en-US');
    expect(selected?.kind).toBeUndefined();
  });

  it('normalizes watch URLs and ignores timestamps, playlists, and tracking parameters', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=8MxG6tOkdNY&t=407s&list=PL123&si=tracking',
      'https://youtu.be/8MxG6tOkdNY?t=407',
      'https://m.youtube.com/watch?v=8MxG6tOkdNY&index=3',
    ]) {
      expect(parseYouTubeVideoUrl(url)).toMatchObject({
        canonicalUrl: 'https://www.youtube.com/watch?v=8MxG6tOkdNY',
        videoId: '8MxG6tOkdNY',
      });
    }
  });

  it('requires a language choice when automatic selection is ambiguous', () => {
    expect(() =>
      selectCaptionTrack(
        [
          { baseUrl, languageCode: 'en' },
          { baseUrl, languageCode: 'es' },
        ],
        'auto',
        undefined,
      ),
    ).toThrow(CaptionAcquisitionError);
  });

  it('removes rolling-caption overlap while retaining separate repeated speech', () => {
    const cues = parseJson3Captions(
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] },
          { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'Hello world again' }] },
          { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'Hello world' }] },
        ],
      }),
    );
    expect(cues.map((cue) => cue.text)).toEqual(['Hello world', 'again', 'Hello world']);
  });

  it('keeps an identical repeated phrase as a distinct caption cue', () => {
    const cues = parseJson3Captions(
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 800, segs: [{ utf8: 'Yes, exactly' }] },
          { tStartMs: 900, dDurationMs: 800, segs: [{ utf8: 'Yes, exactly' }] },
        ],
      }),
    );
    expect(cues.map(({ text }) => text)).toEqual(['Yes, exactly', 'Yes, exactly']);
  });

  it('renders automatic speaker-turn markers as plain transcript punctuation', () => {
    const cues = parseJson3Captions(
      JSON.stringify({
        events: [{ tStartMs: 0, dDurationMs: 800, segs: [{ utf8: '>> Hello >> world' }] }],
      }),
    );
    expect(cues[0]?.text).toBe('— Hello — world');
    expect(parseVttCaptions('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n>> Hi')).toMatchObject([
      { text: '— Hi', speaker: null },
    ]);
  });

  it('drops an identical cue with the same timing while retaining later speech', () => {
    const cues = parseJson3Captions(
      JSON.stringify({
        events: [
          { tStartMs: 0, dDurationMs: 800, segs: [{ utf8: 'Yes, exactly' }] },
          { tStartMs: 0, dDurationMs: 800, segs: [{ utf8: 'Yes, exactly' }] },
          { tStartMs: 900, dDurationMs: 800, segs: [{ utf8: 'Yes, exactly' }] },
        ],
      }),
    );
    expect(cues.map(({ text }) => text)).toEqual(['Yes, exactly', 'Yes, exactly']);
  });

  it('parses WebVTT timestamps, entities, and explicit speaker labels', () => {
    const cues = parseVttCaptions(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<v Alice>Hi &amp; welcome</v>\n\n00:00:03.000 --> 00:00:04.000\n你好\n',
    );
    expect(cues).toEqual([
      { startMs: 1000, endMs: 2500, text: 'Alice: Hi & welcome', speaker: 'Alice' },
      { startMs: 3000, endMs: 4000, text: '你好', speaker: null },
    ]);
  });

  it('rejects malformed caption payloads instead of accepting a short transcript', () => {
    expect(() => parseJson3Captions('{"events":[')).toThrow();
    expect(() => parseVttCaptions('not captions')).toThrow();
  });

  it('rejects timed text with invalid or out-of-order timestamps', () => {
    expect(() =>
      parseJson3Captions(
        JSON.stringify({
          events: [{ tStartMs: -1, dDurationMs: 1000, segs: [{ utf8: 'invalid' }] }],
        }),
      ),
    ).toThrow(/timestamps/u);
    expect(() =>
      parseVttCaptions(
        'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nsecond\n\n00:00:01.000 --> 00:00:02.000\nfirst',
      ),
    ).toThrow(/order/u);
  });

  it('retrieves a full timed caption response without a speech model or helper', async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'POST'
        ? JSON.stringify({
            playabilityStatus: { status: 'OK' },
            videoDetails: { defaultAudioLanguage: 'en' },
            captions: {
              playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl, languageCode: 'en' }] },
            },
          })
        : JSON.stringify({
            events: [
              { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Beginning' }] },
              { tStartMs: 9000000, dDurationMs: 1000, segs: [{ utf8: 'Ending' }] },
            ],
          }),
    );
    const result = await fetchDirectYouTubeCaptions(
      ref,
      'auto',
      { request },
      new AbortController().signal,
    );
    expect(result?.cues.map((cue) => cue.text)).toEqual(['Beginning', 'Ending']);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toMatchObject({ method: 'GET' });
  });

  it('falls back to WebVTT when JSON3 captions are clearly truncated', async () => {
    const request = vi.fn(async (input: { method: string; url: string }) => {
      if (input.method === 'POST')
        return JSON.stringify({
          playabilityStatus: { status: 'OK' },
          videoDetails: { defaultAudioLanguage: 'en', lengthSeconds: '3600' },
          captions: {
            playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl, languageCode: 'en' }] },
          },
        });
      if (input.url.includes('fmt=json3'))
        return JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Only the beginning' }] }],
        });
      return 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBeginning\n\n00:59:50.000 --> 01:00:00.000\nEnding';
    });
    const result = await fetchDirectYouTubeCaptions(
      ref,
      'auto',
      { request },
      new AbortController().signal,
    );
    expect(result?.cues.at(-1)?.text).toBe('Ending');
    expect(request.mock.calls.map(([call]) => call.method)).toEqual(['POST', 'GET', 'GET']);
  });

  it('does not switch languages when the requested language has no track', async () => {
    const request = vi.fn(async ({ method }: { method: string }) =>
      method === 'POST'
        ? JSON.stringify({
            playabilityStatus: { status: 'OK' },
            videoDetails: { defaultAudioLanguage: 'es' },
            captions: {
              playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl, languageCode: 'es' }] },
            },
          })
        : JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hola' }] }],
          }),
    );
    await expect(
      fetchDirectYouTubeCaptions(ref, 'en', { request }, new AbortController().signal),
    ).rejects.toMatchObject({
      availableLanguages: ['es'],
      code: 'unavailable',
      message: expect.stringContaining('English captions'),
    });
    expect(request).toHaveBeenCalledOnce();
  });
});
