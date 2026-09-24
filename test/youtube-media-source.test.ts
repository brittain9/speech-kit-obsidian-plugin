import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AcquisitionEvent } from '../src/media/media-source';
import { createPathBackedMediaLease } from '../src/media/path-backed-media-lease';
import {
  discoverYtDlpCandidates,
  isCompatibleYtDlpVersion,
  parseYtDlpVersion,
} from '../src/media/youtube-helper';
import {
  buildYouTubeAcquisitionArgs,
  explicitYouTubeRightsConfirmation,
  hasYouTubeRightsConfirmation,
  sanitizedAcquisitionEnvironment,
  YOUTUBE_POLICY_VERSION,
  YouTubeMediaSource,
} from '../src/media/youtube-media-source';
import { parseYouTubeVideoUrl } from '../src/media/youtube-url';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('YouTube URL inspection', () => {
  it('canonicalizes one watch, youtu.be, or Shorts VOD URL', () => {
    for (const input of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      expect(parseYouTubeVideoUrl(input)).toMatchObject({
        canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        kind: 'youtube_video_id',
        videoId: 'dQw4w9WgXcQ',
      });
    }
  });

  it.each([
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/playlist?list=PL123',
    'https://www.youtube.com/channel/UC123',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
  ])('rejects %s', (input) => {
    expect(() => parseYouTubeVideoUrl(input)).toThrow();
  });
});

describe('yt-dlp helper policy', () => {
  it('creates a policy record only from the explicit confirmation operation', () => {
    expect(hasYouTubeRightsConfirmation(null)).toBe(false);
    expect(hasYouTubeRightsConfirmation('old-policy')).toBe(false);
    expect(hasYouTubeRightsConfirmation(YOUTUBE_POLICY_VERSION)).toBe(true);
    expect(explicitYouTubeRightsConfirmation()).toEqual({
      kind: 'declared_by_source',
      policyVersion: YOUTUBE_POLICY_VERSION,
    });
  });

  it('discovers existing absolute PATH candidates without executing them', () => {
    const calls: string[] = [];
    const candidates = discoverYtDlpCandidates({
      isExistingFile: (path) => {
        calls.push(path);
        return path.endsWith('/yt-dlp');
      },
      pathEntries: ['/one', 'relative/two', '/one'],
      platform: 'linux',
    });
    expect(candidates).toEqual(['/one/yt-dlp']);
    expect(calls).toEqual(['/one/yt-dlp', '/one/yt-dlp_linux', '/one/yt-dlp_macos']);
  });

  it('parses and accepts only the pinned-compatible version floor', () => {
    expect(parseYtDlpVersion('yt-dlp 2026.08.19')).toBe('2026.08.19');
    expect(parseYtDlpVersion('2026.09.01')).toBe('2026.09.01');
    expect(isCompatibleYtDlpVersion('2025.12.31')).toBe(false);
    expect(isCompatibleYtDlpVersion('2026.08.19')).toBe(true);
  });

  it('uses a fixed safe command boundary and sanitized environment', () => {
    const video = parseYouTubeVideoUrl('https://youtu.be/dQw4w9WgXcQ');
    const args = buildYouTubeAcquisitionArgs({
      jobRoot: '/private/job',
      maxBytes: 1234,
      maxDurationSeconds: 1_800,
      video,
    });
    expect(args.at(-1)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(args).toEqual(
      expect.arrayContaining([
        '--ignore-config',
        '--no-config-locations',
        '--no-plugin-dirs',
        '--no-remote-components',
        '--no-cookies',
        '--no-playlist',
        '--no-mark-watched',
        '--no-live-from-start',
        '--use-extractors',
        'youtube',
        '--format',
        'bestaudio',
        '--concurrent-fragments',
        '1',
        '--retries',
        '0',
        '--max-filesize',
        '1234',
      ]),
    );
    expect(args.join(' ')).not.toMatch(
      /cookie-from-browser|--write-info-json|--write-thumbnail|--postprocessor|proxy|--playlist|--archive/i,
    );
    const env = sanitizedAcquisitionEnvironment('/private/job');
    expect(env).toMatchObject({ HOME: '/private/job/home', TMPDIR: '/private/job/tmp' });
    expect(Object.keys(env).some((key) => /proxy|cookie|token/i.test(key))).toBe(false);
    expect(env.PATH).toBeUndefined();
  });
});

describe('YouTube path-backed MediaLease', () => {
  it('reads a validated regular file, supports concurrent release, and removes the job root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-test-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(mediaPath, 'audio');
    const lease = await createPathBackedMediaLease({
      encodedBytes: 5,
      jobRoot,
      maxBytes: 10,
      mediaPath,
      provenance: {
        acquiredAt: new Date().toISOString(),
        adapterVersion: 'test',
        rights: { kind: 'user_supplied_file' },
        sourceId: 'local_file',
        temporaryMedia: true,
      },
    });
    const stream = await lease.openReadStream();
    const reader = stream.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('audio');
    const firstRelease = lease.release();
    expect(lease.release()).toBe(firstRelease);
    await firstRelease;
    await expect(readdir(jobRoot)).rejects.toThrow();
  });

  it('rejects a symlink before exposing bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-test-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const target = join(root, 'outside');
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(target, 'audio');
    await symlink(target, mediaPath);
    await expect(
      createPathBackedMediaLease({
        encodedBytes: 5,
        jobRoot,
        maxBytes: 10,
        mediaPath,
        provenance: {
          acquiredAt: new Date().toISOString(),
          adapterVersion: 'test',
          rights: { kind: 'user_supplied_file' },
          sourceId: 'local_file',
          temporaryMedia: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'read_failed' });
  });
});

describe('YouTubeMediaSource with a local fake helper', () => {
  it('acquires bounded metadata into the same temporary lease boundary', async () => {
    const helper = await makeHelper(false);
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-test-'));
    temporaryPaths.push(root);
    const source = new YouTubeMediaSource({ getHelperPath: () => helper, tempRoot: root });
    const events: AcquisitionEvent[] = [];
    for await (const event of source.acquire({
      kind: 'interactive',
      maxBytes: 1_000,
      maxDurationMs: 30_000,
      ref: { kind: 'youtube_video_id', videoId: 'dQw4w9WgXcQ' },
      rights: { kind: 'declared_by_source', policyVersion: YOUTUBE_POLICY_VERSION },
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(['plan', 'progress', 'ready']);
    const ready = events.at(-1);
    if (ready?.type !== 'ready') throw new Error('Expected ready event');
    expect(ready.lease.provenance).toMatchObject({
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      helperVersion: '2026.08.19',
      sourceId: 'youtube_yt_dlp',
      temporaryMedia: true,
    });
    expect(JSON.stringify(ready.lease.provenance)).not.toContain(root);
    const stream = await ready.lease.openReadStream();
    expect((await stream.getReader().read()).done).toBe(false);
    await ready.lease.release();
  });

  it('kills a real child on cancellation and does not leave a job directory', async () => {
    const helper = await makeHelper(true);
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-cancel-'));
    temporaryPaths.push(root);
    const controller = new AbortController();
    const source = new YouTubeMediaSource({ getHelperPath: () => helper, tempRoot: root });
    const acquisition = (async () => {
      for await (const _event of source.acquire({
        kind: 'interactive',
        maxBytes: 1_000,
        maxDurationMs: 30_000,
        ref: { kind: 'youtube_video_id', videoId: 'dQw4w9WgXcQ' },
        rights: { kind: 'declared_by_source', policyVersion: YOUTUBE_POLICY_VERSION },
        signal: controller.signal,
      })) {
        // The source owns the child until it exits or cancellation is observed.
      }
    })();
    setTimeout(() => controller.abort(), 300);
    await expect(acquisition).rejects.toMatchObject({ code: 'cancelled' });
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('speech-kit-youtube-')),
    ).toEqual([]);
  });
});

async function makeHelper(slow: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-helper-'));
  temporaryPaths.push(root);
  const helper = join(root, 'yt-dlp');
  await writeFile(
    helper,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'yt-dlp 2026.08.19'
  exit 0
fi
printf '%s\\n' 'before_dl:{"id":"dQw4w9WgXcQ","title":"Fixture","channel":"Channel","channel_id":"channel-1","duration":1}'
${slow ? 'sleep 10' : "printf '%s' audio > source.webm"}
`,
    { mode: 0o700 },
  );
  await chmod(helper, 0o700);
  return helper;
}
