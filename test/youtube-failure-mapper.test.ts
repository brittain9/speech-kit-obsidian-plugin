import { describe, expect, it, vi } from 'vitest';

import { AudioFileFailureMapper } from '../src/dictation/audio-file-failure';
import { youtubeMediaFailureAdapter } from '../src/media/youtube-failure-mapper';
import { YouTubeHelperError } from '../src/media/youtube-helper';
import { YouTubeAcquisitionError } from '../src/media/youtube-media-source';

describe('YouTube media failure adapter', () => {
  it.each([
    ['helper_unavailable', 'youtube.error.helper_unavailable'],
    ['helper_version_unsupported', 'youtube.error.helper_version_unsupported'],
    ['resource_limit', 'youtube.error.resource_limit'],
    ['tool_failed', 'youtube.error.helper_probe_failed'],
    ['unsupported_platform', 'youtube.error.unsupported_platform'],
  ] as const)('maps helper %s to actionable copy', (code, expectedKey) => {
    const feedback = { show: vi.fn() };
    const mapper = new AudioFileFailureMapper({
      feedback,
      mediaFailureAdapters: [youtubeMediaFailureAdapter],
    });

    mapper.reportFailure(new YouTubeHelperError(code, 'internal helper detail'));

    expect(feedback.show).toHaveBeenCalledWith(expect.objectContaining({ key: expectedKey }));
  });

  it('maps acquisition integrity failures without coupling the local mapper', () => {
    const feedback = { show: vi.fn() };
    const mapper = new AudioFileFailureMapper({
      feedback,
      mediaFailureAdapters: [youtubeMediaFailureAdapter],
    });

    mapper.reportFailure(new YouTubeAcquisitionError('integrity_failed', 'internal detail'));

    expect(feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'youtube.error.integrity_failed' }),
    );
  });

  it('sanitizes filesystem causes before feedback or logging', () => {
    const feedback = { show: vi.fn() };
    const mapper = new AudioFileFailureMapper({
      feedback,
      mediaFailureAdapters: [youtubeMediaFailureAdapter],
    });
    const error = new YouTubeAcquisitionError('tool_failed', 'safe diagnostic');
    Object.defineProperty(error, 'cause', { value: new Error('/private/tmp/secret-job') });

    mapper.reportFailure(error);

    const output = JSON.stringify(feedback.show.mock.calls[0]?.[0]);
    expect(output).toContain('youtube:tool_failed');
    expect(output).not.toContain('/private/tmp/secret-job');
  });

  it('recognizes provider cancellation', () => {
    const mapper = new AudioFileFailureMapper({
      feedback: { show: vi.fn() },
      mediaFailureAdapters: [youtubeMediaFailureAdapter],
    });
    expect(mapper.isCancellation(new YouTubeAcquisitionError('cancelled', 'internal detail'))).toBe(
      true,
    );
  });
});
