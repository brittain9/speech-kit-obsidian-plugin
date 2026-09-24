import { describe, expect, it } from 'vitest';

import type {
  LocalMediaAcquireRequest,
  MediaAcquireRequestBase,
  MediaSource,
  MediaTranscriptionEntry,
} from '../src/media/media-source';
import type {
  YouTubeAcquisitionContext,
  YouTubeMediaAcquireRequest,
} from '../src/media/youtube-media-source';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type LocalEntry = MediaTranscriptionEntry<undefined, LocalMediaAcquireRequest>;
type YouTubeEntry = MediaTranscriptionEntry<YouTubeAcquisitionContext, YouTubeMediaAcquireRequest>;

type _LocalRequestFlow = Assert<Equal<LocalEntry['source'], MediaSource<LocalMediaAcquireRequest>>>;
type _YouTubeRequestFlow = Assert<
  Equal<YouTubeEntry['source'], MediaSource<YouTubeMediaAcquireRequest>>
>;
type _YouTubeContextFlow = Assert<
  Equal<Parameters<YouTubeEntry['createRequest']>[0], YouTubeAcquisitionContext>
>;
type _YouTubeBaseFlow = Assert<
  Equal<Parameters<YouTubeEntry['createRequest']>[1], MediaAcquireRequestBase>
>;

declare const localEntry: LocalEntry;
declare const youtubeContext: YouTubeAcquisitionContext;
declare const requestBase: MediaAcquireRequestBase;
function assertMismatchedEntryTypes(
  entry: LocalEntry,
  context: YouTubeAcquisitionContext,
  request: MediaAcquireRequestBase,
): void {
  // @ts-expect-error A YouTube context cannot be passed to the local request factory.
  entry.createRequest(context, request);
}
void assertMismatchedEntryTypes;

describe('typed media boundaries', () => {
  it('keeps local and YouTube request/source types distinct', () => {
    expect(true).toBe(true);
  });
});
