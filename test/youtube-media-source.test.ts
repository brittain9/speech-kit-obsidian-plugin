import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcquisitionEvent } from '../src/media/media-source';
import {
  claimJobRoot,
  createPathBackedMediaLease,
  type JobCleanupOptions,
  openValidatedMediaFile,
  readOwnerMarker,
  releaseJobRootCapability,
  removeMediaJob,
  writeOwnerMarkerAtomically,
} from '../src/media/path-backed-media-lease';
import {
  discoverYtDlpCandidates,
  interpretVersionResult,
  isCompatibleYtDlpVersion,
  isYouTubeSupportedPlatform,
  parseYtDlpVersion,
  probeYtDlpVersion,
} from '../src/media/youtube-helper';
import {
  buildYouTubeAcquisitionArgs,
  classifyYouTubeHelperFailure,
  createPrivateJobRoot,
  explicitYouTubeRightsConfirmation,
  hasYouTubeRightsConfirmation,
  isYouTubeOwnerHeartbeatFresh,
  parseYouTubeHelperMetadata,
  sanitizedAcquisitionEnvironment,
  sweepAbandonedYouTubeJobs,
  YOUTUBE_POLICY_VERSION,
  type YouTubeMediaAcquireRequest,
  type YouTubeMediaLease,
  YouTubeMediaSource,
} from '../src/media/youtube-media-source';
import { parseYouTubeVideoUrl } from '../src/media/youtube-url';

const temporaryPaths: string[] = [];

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function successfulCleanupSpawn(
  parentRoot?: string,
  retainedEntryNames?: ReadonlySet<string>,
): typeof spawn {
  return vi.fn((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      pid: number | undefined;
      stderr: null;
      stdout: null;
    };
    child.pid = undefined;
    child.stdout = null;
    child.stderr = null;
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (parentRoot !== undefined && String(args[1] ?? '').includes('readdirSync')) {
        for (const entry of readdirSync(parentRoot, { withFileTypes: true })) {
          if (retainedEntryNames?.has(entry.name)) continue;
          const entryPath = join(parentRoot, entry.name);
          if (entry.isDirectory()) rmSync(entryPath, { force: true, recursive: true });
          else rmSync(entryPath, { force: true });
        }
      }
      child.emit('exit', 0);
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
}

async function expectSafeCleanupOutcome(root: string): Promise<void> {
  const jobs = (await readdir(root)).filter((entry) => entry.startsWith('speech-kit-youtube-'));
  expect(jobs).toEqual([]);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('cleanup timeout')), timeoutMs),
    ),
  ]);
}

function validOwnerMarker(pid = 424_242): Record<string, unknown> {
  return {
    createdAt: 1,
    heartbeatAt: Date.now(),
    instanceId: '123e4567-e89b-42d3-a456-426614174000',
    pid,
    processStartedAt: 1,
    speechKitJob: true,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      consentId: 'youtube-policy-confirmation',
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

  it('rejects Windows before spawning the helper', async () => {
    const spawnProcess = vi.fn();
    expect(isYouTubeSupportedPlatform('win32')).toBe(false);
    expect(isYouTubeSupportedPlatform('darwin')).toBe(true);
    expect(isYouTubeSupportedPlatform('linux', 'arm64')).toBe(false);
    await expect(
      probeYtDlpVersion('/private/yt-dlp', {
        platform: 'win32',
        spawnProcess: spawnProcess as unknown as typeof spawn,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('parses and accepts only the pinned-compatible version floor', () => {
    expect(parseYtDlpVersion('yt-dlp 2026.08.19')).toBe('2026.08.19');
    expect(parseYtDlpVersion('2026.09.01')).toBe('2026.09.01');
    expect(isCompatibleYtDlpVersion('2025.12.31')).toBe(false);
    expect(isCompatibleYtDlpVersion('2026.08.19')).toBe(true);
  });

  it('rejects missing and unsupported helper versions', () => {
    const base = {
      cancelled: false,
      cleanupFailed: false,
      exitCode: 0,
      failed: false,
      outputLimitExceeded: false,
      stderr: '',
      timedOut: false,
    };
    expect(() => interpretVersionResult('/private/helper', { ...base, stdout: '' })).toThrow();
    expect(() =>
      interpretVersionResult('/private/helper', { ...base, stdout: 'yt-dlp 2025.01.01' }),
    ).toThrow();
  });
  it('maps helper failures to typed YouTube codes', () => {
    for (const [message, code] of [
      ['ERROR: Private video', 'not_found_or_private'],
      ['Sign in to confirm your age', 'age_restricted'],
      ['members-only content', 'membership_required'],
      ['This video requires a purchase', 'purchase_required'],
      ['This video is DRM protected', 'drm_protected'],
      ['Video unavailable in your region', 'region_restricted'],
      ['HTTP Error 429: Too Many Requests', 'rate_limited'],
      ['Unable to download webpage: network error', 'network_failed'],
      ['Unsupported URL extractor changed', 'extractor_changed'],
      ['login required', 'authentication_required'],
      ['fatal helper crash', 'tool_failed'],
    ] as const) {
      expect(classifyYouTubeHelperFailure(message)).toBe(code);
    }
  });

  it('redacts signed URLs, tokens, and unallowlisted metadata from parsed output', () => {
    const metadata = parseYouTubeHelperMetadata(
      'before_dl:{"id":"dQw4w9WgXcQ","title":"Fixture","channel":"Channel","channel_id":"channel-1","duration":1,"ext":"webm","is_live":false,"live_status":"not_live","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=SECRET"}',
    );
    expect(metadata).toMatchObject({ title: 'Fixture', videoId: 'dQw4w9WgXcQ' });
    expect(JSON.stringify(metadata)).not.toContain('SECRET');
  });
  it('rejects malformed, future, stale, and unbound owner heartbeats', () => {
    const now = 20_000;
    const valid = {
      createdAt: 1,
      heartbeatAt: now,
      instanceId: '123e4567-e89b-42d3-a456-426614174000',
      pid: 424_242,
      processStartedAt: 1,
      speechKitJob: true,
    };
    expect(isYouTubeOwnerHeartbeatFresh(valid, now)).toBe(true);
    expect(isYouTubeOwnerHeartbeatFresh({ ...valid, heartbeatAt: now + 10_000 }, now)).toBe(false);
    expect(isYouTubeOwnerHeartbeatFresh({ ...valid, heartbeatAt: now - 180_000 }, now)).toBe(false);
    expect(isYouTubeOwnerHeartbeatFresh({ ...valid, instanceId: 'not-bound' }, now)).toBe(false);
    expect(isYouTubeOwnerHeartbeatFresh({ ...valid, speechKitJob: false }, now)).toBe(false);
    expect(
      isYouTubeOwnerHeartbeatFresh({ ...valid, pid: process.pid, processStartedAt: 1 }, now),
    ).toBe(false);
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
    const lease = await createLease(jobRoot, mediaPath);
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
    await expect(openValidatedMediaFile(jobRoot, mediaPath, 10)).rejects.toMatchObject({
      code: 'integrity_failed',
    });
  });

  it('rejects hard-linked media and keeps the validated descriptor after path replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-test-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const outside = join(root, 'outside');
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(outside, 'outside');
    await link(outside, mediaPath);
    await expect(openValidatedMediaFile(jobRoot, mediaPath, 10)).rejects.toMatchObject({
      code: 'integrity_failed',
    });

    await rm(mediaPath);
    await writeFile(mediaPath, 'original');
    const lease = await createLease(jobRoot, mediaPath);
    const replacement = join(root, 'replacement');
    await writeFile(replacement, 'replaced');
    await rename(replacement, mediaPath);
    const reader = (await lease.openReadStream()).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('original');
    await reader.cancel();
    await lease.release();
    await expect(lease.openReadStream()).rejects.toMatchObject({ code: 'released' });
  });

  it('rejects arbitrary handles and preserves a replacement job root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-misuse-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(mediaPath, 'audio');
    await expect(
      createPathBackedMediaLease({
        provenance: {
          acquiredAt: new Date().toISOString(),
          adapterVersion: 'test',
          sourceId: 'local_file',
          temporaryMedia: true,
        },
        validatedMediaFile: {
          handle: {} as never,
          path: mediaPath,
          size: 5,
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'integrity_failed' });

    await expect(removeMediaJob(jobRoot as never)).rejects.toMatchObject({
      code: 'integrity_failed',
    });

    const lease = await createLease(jobRoot, mediaPath);
    const movedRoot = join(root, 'job-original');
    await rename(jobRoot, movedRoot);
    await (await import('node:fs/promises')).mkdir(jobRoot);
    const replacementMarker = join(jobRoot, 'replacement.txt');
    await writeFile(replacementMarker, 'keep');
    await lease.release();
    await expect(readFile(replacementMarker)).resolves.toEqual(Buffer.from('keep'));
  });

  it('does not delete a replacement after the final cleanup capability is claimed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-final-race-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    await writeFile(join(jobRoot, 'owner.json'), JSON.stringify(validOwnerMarker()));
    const capability = await claimJobRoot(jobRoot);
    const movedRoot = join(root, 'job-original');
    await rename(jobRoot, movedRoot);
    await (await import('node:fs/promises')).mkdir(jobRoot);
    const marker = join(jobRoot, 'replacement.txt');
    await writeFile(marker, 'keep');
    await removeMediaJob(capability);
    await expect(readFile(marker)).resolves.toEqual(Buffer.from('keep'));
  });

  it('keeps a replacement made during descriptor cleanup finalization', async () => {
    class ImmediateChild extends EventEmitter {
      pid = 424_244;
      stdout = null;
      stderr = null;
      kill = vi.fn();
    }

    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-startup-race-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    await writeFile(join(jobRoot, 'owner.json'), JSON.stringify(validOwnerMarker()));
    const capability = await claimJobRoot(jobRoot);
    const movedRoot = join(root, 'job-original');
    const spawnMock = vi.fn(
      (_command: string, _args: readonly string[], options?: { cwd?: string }) => {
        expect(options?.cwd).toBe('/dev/fd/3');
        expect(options?.cwd).not.toContain(root);
        const child = new ImmediateChild();
        child.once('close', () => {
          renameSync(jobRoot, movedRoot);
          mkdirSync(jobRoot);
          writeFileSync(join(jobRoot, 'replacement.txt'), 'keep');
        });
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
    );
    await removeMediaJob(capability, {
      platform: 'linux',
      spawnProcess: spawnMock as unknown as NonNullable<JobCleanupOptions['spawnProcess']>,
      timeoutMs: 100,
    });
    await expect(readFile(join(jobRoot, 'replacement.txt'))).resolves.toEqual(Buffer.from('keep'));
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('does not spawn a cleanup child on Windows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-win-cleanup-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const marker = validOwnerMarker();
    await writeFile(join(jobRoot, 'owner.json'), JSON.stringify(marker));
    const capability = await claimJobRoot(jobRoot);
    const spawnMock = vi.fn();
    await removeMediaJob(capability, {
      platform: 'win32',
      spawnProcess: spawnMock as unknown as NonNullable<JobCleanupOptions['spawnProcess']>,
      timeoutMs: 100,
    });
    expect(spawnMock).not.toHaveBeenCalled();
    await expect(readFile(join(jobRoot, 'owner.json'))).resolves.toEqual(
      Buffer.from(JSON.stringify(marker)),
    );
  });

  it('keeps marker reads on the held descriptor after root replacement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-marker-replacement-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const ownerPath = join(jobRoot, 'owner.json');
    const originalOwner = validOwnerMarker();
    await writeFile(ownerPath, JSON.stringify(originalOwner));
    const capability = await claimJobRoot(jobRoot);
    const movedRoot = join(root, 'job-original');
    await rename(jobRoot, movedRoot);
    await (await import('node:fs/promises')).mkdir(jobRoot);
    const replacementOwner = {
      ...originalOwner,
      instanceId: '123e4567-e89b-42d3-a456-426614174099',
    };
    await writeFile(join(jobRoot, 'owner.json'), JSON.stringify(replacementOwner));
    await expect(readOwnerMarker(capability)).resolves.toEqual(originalOwner);
    await expect(
      writeOwnerMarkerAtomically(capability, JSON.stringify({ sequence: 9 })),
    ).rejects.toThrow();
    await expect(readFile(join(jobRoot, 'owner.json'))).resolves.toEqual(
      Buffer.from(JSON.stringify(replacementOwner)),
    );
    await removeMediaJob(capability, { spawnProcess: successfulCleanupSpawn(root) });
    await expect(readFile(join(jobRoot, 'owner.json'))).resolves.toEqual(
      Buffer.from(JSON.stringify(replacementOwner)),
    );
  });

  it('serializes atomic owner publications while readers observe complete JSON', async () => {
    class PublishChild extends EventEmitter {
      pid: number | undefined;
      stdout = null;
      stderr = null;
      kill = vi.fn();
    }

    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-heartbeat-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    const ownerPath = join(jobRoot, 'owner.json');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    await writeFile(ownerPath, JSON.stringify(validOwnerMarker()));
    const spawnProcess = vi.fn((_command: string, args: readonly string[]): PublishChild => {
      const child = new PublishChild();
      child.pid = undefined;
      setTimeout(() => {
        const temporaryPath = join(jobRoot, args[2] ?? '');
        writeFileSync(temporaryPath, args[3] ?? '');
        renameSync(temporaryPath, ownerPath);
        child.emit('exit', 0);
        child.emit('close', 0);
      }, 3);
      return child;
    });
    const capability = await claimJobRoot(jobRoot, {
      platform: 'darwin',
      spawnProcess: spawnProcess as unknown as typeof spawn,
      timeoutMs: 100,
    });
    const writes = [
      writeOwnerMarkerAtomically(capability, JSON.stringify({ sequence: 1 })),
      writeOwnerMarkerAtomically(capability, JSON.stringify({ sequence: 2 })),
    ];
    const reads = Array.from(
      { length: 10 },
      async () => JSON.parse(await readFile(ownerPath, 'utf8')) as { sequence: number },
    );
    await Promise.all([...writes, ...reads]);
    expect(JSON.parse(await readFile(ownerPath, 'utf8'))).toEqual({ sequence: 2 });
    await releaseJobRootCapability(capability);
  });

  it('retains the previous owner marker when atomic publication fails', async () => {
    class FailingPublishChild extends EventEmitter {
      pid: number | undefined;
      stdout = null;
      stderr = null;
      kill = vi.fn();
    }

    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-heartbeat-failure-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    const ownerPath = join(jobRoot, 'owner.json');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const original = validOwnerMarker();
    await writeFile(ownerPath, JSON.stringify(original));
    const spawnProcess = vi.fn((): FailingPublishChild => {
      const child = new FailingPublishChild();
      child.pid = undefined;
      queueMicrotask(() => {
        child.emit('exit', 1);
        child.emit('close', 1);
      });
      return child;
    });
    const capability = await claimJobRoot(jobRoot, {
      platform: 'darwin',
      spawnProcess: spawnProcess as unknown as typeof spawn,
      timeoutMs: 100,
    });
    await expect(
      writeOwnerMarkerAtomically(capability, JSON.stringify({ sequence: 3 })),
    ).rejects.toThrow();
    await expect(readFile(ownerPath, 'utf8')).resolves.toBe(JSON.stringify(original));
    await releaseJobRootCapability(capability);
  });

  it('rejects an oversized owner marker before allocating a read buffer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-marker-growth-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    const ownerPath = join(jobRoot, 'owner.json');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    await writeFile(ownerPath, JSON.stringify(validOwnerMarker()));
    const capability = await claimJobRoot(jobRoot);
    await writeFile(ownerPath, 'x'.repeat(20_000));
    await expect(readOwnerMarker(capability)).rejects.toMatchObject({
      code: 'integrity_failed',
    });
    await releaseJobRootCapability(capability);
  });

  it('fails closed on an injected macOS child identity mismatch', async () => {
    class IdentityMismatchChild extends EventEmitter {
      pid: number | undefined;
      stdout = null;
      stderr = null;
      kill = vi.fn();
    }

    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-macos-identity-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    await writeFile(join(jobRoot, 'owner.json'), JSON.stringify(validOwnerMarker()));
    const sourcePath = join(jobRoot, 'source.webm');
    await writeFile(sourcePath, 'keep');
    const capability = await claimJobRoot(jobRoot);
    const calls: string[] = [];
    const spawnMock = vi.fn(
      (
        command: string,
        args: readonly string[],
        options?: { cwd?: string; stdio?: readonly unknown[] },
      ) => {
        calls.push(command);
        expect(args[1]).toContain('fstatSync(3)');
        expect(args[1]).toContain("statSync('.')");
        expect(options?.cwd).toBe('/dev/fd/3');
        expect(options?.stdio?.[3]).toEqual(expect.any(Number));
        const child = new IdentityMismatchChild();
        queueMicrotask(() => {
          child.emit('exit', 75);
          child.emit('close', 75);
        });
        return child;
      },
    );
    await removeMediaJob(capability, {
      platform: 'darwin',
      spawnProcess: spawnMock as unknown as NonNullable<JobCleanupOptions['spawnProcess']>,
      timeoutMs: 100,
    });
    expect(calls).toEqual([process.execPath]);
    await expect(readFile(sourcePath)).resolves.toEqual(Buffer.from('keep'));
  });

  it('never removes a symlink replacement during cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-symlink-root-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    const outside = join(root, 'outside');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    await writeFile(join(jobRoot, 'owner.json'), JSON.stringify(validOwnerMarker()));
    await writeFile(outside, 'keep');
    const capability = await claimJobRoot(jobRoot);
    const movedRoot = join(root, 'job-original');
    await rename(jobRoot, movedRoot);
    await symlink(outside, jobRoot, 'dir');
    await removeMediaJob(capability);
    await expect(readFile(outside)).resolves.toEqual(Buffer.from('keep'));
    await expect(readlink(jobRoot)).resolves.toBe(outside);
  });

  it('settles a pending outer read when the lease is released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-pending-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(mediaPath, Buffer.alloc(512 * 1024, 1));
    const lease = await createLease(jobRoot, mediaPath, 600_000);
    const reader = (await lease.openReadStream()).getReader();
    await reader.read();
    const pendingRead = reader.read();
    const pendingResult = expect(pendingRead).rejects.toMatchObject({ code: 'released' });
    await lease.release();
    await pendingResult;
  });

  it('rejects containment violations and keeps release errors contained', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-containment-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const outside = join(root, 'outside');
    await writeFile(outside, 'outside');
    await expect(openValidatedMediaFile(jobRoot, outside, 10)).rejects.toMatchObject({
      code: 'integrity_failed',
    });
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(mediaPath, 'audio');
    const lease = await createLease(jobRoot, mediaPath);
    await expect(lease.release()).resolves.toBeUndefined();
  });
  it('bounds a hanging descriptor cleanup child with a fresh signal', async () => {
    class HangingChild extends EventEmitter {
      pid = 424242;
      stdout = null;
      stderr = null;
      kill = vi.fn(() => {
        queueMicrotask(() => this.emit('close', null));
        return true;
      });
    }

    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-cleanup-hang-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(mediaPath, 'audio');
    const child = new HangingChild();
    const spawnMock = vi.fn(
      (_command: string, _args: readonly string[], _options?: unknown) => child,
    );
    const spawnProcess = spawnMock as unknown as NonNullable<JobCleanupOptions['spawnProcess']>;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('group unavailable'), { code: 'EACCES' });
    });
    const lease = await createLease(jobRoot, mediaPath, 10, {
      platform: 'linux',
      spawnProcess,
      timeoutMs: 20,
    });
    const release = lease.release();
    await expect(withTimeout(release, 500)).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['-e', expect.stringContaining('fstatSync(3)')],
      expect.objectContaining({
        cwd: '/dev/fd/3',
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        stdio: ['ignore', 'ignore', 'ignore', expect.any(Number)],
      }),
    );
    expect(spawnMock.mock.calls[0]?.[1]?.[1]).toContain("statSync('.')");
    expect(spawnMock.mock.calls[0]?.[2]).not.toHaveProperty('cwd', root);
    expect(child.kill).toHaveBeenCalled();
    kill.mockRestore();
  });

  it('removes active reader registrations at EOF and on cancel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-lease-test-'));
    temporaryPaths.push(root);
    const jobRoot = join(root, 'job');
    await (await import('node:fs/promises')).mkdir(jobRoot, { mode: 0o700 });
    const mediaPath = join(jobRoot, 'source.webm');
    await writeFile(mediaPath, 'eof');
    const lease = await createLease(jobRoot, mediaPath);
    const eofReader = (await lease.openReadStream()).getReader();
    expect((await eofReader.read()).done).toBe(false);
    expect((await eofReader.read()).done).toBe(true);
    const eofRelease = lease.release();
    expect(lease.release()).toBe(eofRelease);
    await eofRelease;
  });
});

describe('YouTubeMediaSource with a local fake helper', () => {
  it('rejects Windows before spawning the helper or cleanup child', async () => {
    const helperSpawn = vi.fn();
    const cleanupSpawn = vi.fn();
    const source = new YouTubeMediaSource({
      cleanupSpawnProcess: cleanupSpawn as unknown as typeof spawn,
      getHelperPath: () => '/private/yt-dlp',
      platform: 'win32',
      spawnProcess: helperSpawn as unknown as typeof spawn,
    });
    await expect(
      collect(source.acquire(youtubeRequest(new AbortController().signal))),
    ).rejects.toMatchObject({
      code: 'unsupported_platform',
    });
    expect(helperSpawn).not.toHaveBeenCalled();
    expect(cleanupSpawn).not.toHaveBeenCalled();
  });

  it('acquires bounded metadata into the same temporary lease boundary', async () => {
    const helper = await makeHelper(false);
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-test-'));
    temporaryPaths.push(root);
    const source = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(root),
      getHelperPath: () => helper,
      tempRoot: root,
    });
    const events: AcquisitionEvent<YouTubeMediaLease>[] = [];
    for await (const event of source.acquire(youtubeRequest(new AbortController().signal))) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(['plan', 'progress', 'ready']);
    const ready = events.at(-1);
    if (ready?.type !== 'ready') throw new Error('Expected ready event');
    expect(ready.lease.provenance).toMatchObject({
      sourceId: 'youtube_yt_dlp',
      temporaryMedia: true,
    });
    expect(ready.lease.youtubeProvenance).toMatchObject({
      helperVersion: '2026.08.19',
      publicUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Fixture',
      videoId: 'dQw4w9WgXcQ',
    });
    expect(Object.keys(ready.lease.provenance)).toEqual([
      'acquiredAt',
      'adapterVersion',
      'sourceId',
      'temporaryMedia',
    ]);
    expect(JSON.stringify(ready.lease.provenance)).not.toMatch(
      /yt-dlp|Fixture|Channel|root|watch\?v=/i,
    );
    const stream = await ready.lease.openReadStream();
    expect((await stream.getReader().read()).done).toBe(false);
    await ready.lease.release();
  });

  it('rejects live metadata and missing consent before accepting media', async () => {
    const invalidRequest = {
      ...youtubeRequest(new AbortController().signal),
      provider: {
        ...youtubeRequest(new AbortController().signal).provider,
        ref: { videoId: 'bad' },
      },
    } as unknown as YouTubeMediaAcquireRequest;
    const validationHelper = await makeHelper(false);
    const validationRoot = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-validation-'));
    temporaryPaths.push(validationRoot);
    const validationSource = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(validationRoot),
      getHelperPath: () => validationHelper,
      tempRoot: validationRoot,
    });
    await expect(collect(validationSource.acquire(invalidRequest))).rejects.toMatchObject({
      code: 'invalid_or_unsupported_url',
    });
    for (const [field, value] of [
      ['canonicalUrl', 'https://evil.example/watch?v=dQw4w9WgXcQ'],
      ['host', 'evil.example'],
      ['inputUrl', 'https://evil.example/'],
      ['kind', 'attacker_kind'],
    ] as const) {
      const forgedRequest = {
        ...youtubeRequest(new AbortController().signal),
        provider: {
          ...youtubeRequest(new AbortController().signal).provider,
          ref: {
            ...youtubeRequest(new AbortController().signal).provider.ref,
            [field]: value,
          },
        },
      } as unknown as YouTubeMediaAcquireRequest;
      await expect(collect(validationSource.acquire(forgedRequest))).rejects.toMatchObject({
        code: 'invalid_or_unsupported_url',
      });
    }

    const liveHelper = await makeHelper(false, { is_live: true, live_status: 'is_live' });
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-live-'));
    temporaryPaths.push(root);
    const source = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(root),
      getHelperPath: () => liveHelper,
      tempRoot: root,
    });
    await expect(
      collect(source.acquire(youtubeRequest(new AbortController().signal))),
    ).rejects.toMatchObject({
      code: 'live_stream',
    });
    await expectSafeCleanupOutcome(root);

    const mismatchedHelper = await makeHelper(false, { id: 'aaaaaaaaaaa' });
    const mismatchedSource = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(root),
      getHelperPath: () => mismatchedHelper,
      tempRoot: root,
    });
    await expect(
      collect(mismatchedSource.acquire(youtubeRequest(new AbortController().signal))),
    ).rejects.toMatchObject({
      code: 'extractor_changed',
    });

    const staleHelperVersion = {
      ...youtubeRequest(new AbortController().signal),
      provider: {
        ...youtubeRequest(new AbortController().signal).provider,
        helperVersion: '2025.01.01',
      },
    };
    await expect(collect(source.acquire(staleHelperVersion))).rejects.toMatchObject({
      code: 'helper_version_unsupported',
    });

    const missingConsent = {
      ...youtubeRequest(new AbortController().signal),
      provider: {
        helperVersion: '2026.08.19',
        inputUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        ref: parseYouTubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      },
    } as unknown as YouTubeMediaAcquireRequest;
    await expect(collect(source.acquire(missingConsent))).rejects.toMatchObject({
      code: 'rights_not_established',
    });
  });

  it('sweeps only old clearly abandoned jobs and preserves recent jobs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-sweep-'));
    temporaryPaths.push(root);
    const recent = join(root, 'speech-kit-youtube-recent');
    const old = join(root, 'speech-kit-youtube-old');
    await mkdir(recent);
    await mkdir(old);
    await writeFile(join(recent, 'owner.json'), JSON.stringify({ pid: process.pid }));
    await utimes(recent, new Date(20_000), new Date(20_000));
    await utimes(old, new Date(0), new Date(0));
    await sweepAbandonedYouTubeJobs(root, {
      cleanupSpawnProcess: successfulCleanupSpawn(root),
      minAgeMs: 10,
      now: () => 200_000,
    });
    await expect(readdir(root)).resolves.toEqual([
      'speech-kit-youtube-old',
      'speech-kit-youtube-recent',
    ]);
    const current = join(root, 'speech-kit-youtube-current');
    await mkdir(current);
    await writeFile(join(current, 'owner.json'), JSON.stringify({ pid: process.pid }));
    await utimes(current, new Date(0), new Date(0));
    const validStale = join(root, 'speech-kit-youtube-valid-stale');
    await mkdir(validStale);
    await writeFile(
      join(validStale, 'owner.json'),
      JSON.stringify({
        createdAt: 1,
        heartbeatAt: 1,
        instanceId: '123e4567-e89b-42d3-a456-426614174003',
        pid: 424_242,
        processStartedAt: 1,
        speechKitJob: true,
      }),
    );
    await utimes(validStale, new Date(0), new Date(0));
    const activeOld = join(root, 'speech-kit-youtube-active-old');
    await mkdir(activeOld);
    await writeFile(
      join(activeOld, 'owner.json'),
      JSON.stringify({
        createdAt: 1,
        heartbeatAt: 200_000,
        instanceId: '123e4567-e89b-42d3-a456-426614174000',
        pid: 424_242,
        processStartedAt: 1,
        speechKitJob: true,
      }),
    );
    await utimes(activeOld, new Date(0), new Date(0));
    const corrupt = join(root, 'speech-kit-youtube-corrupt');
    await mkdir(corrupt);
    await writeFile(join(corrupt, 'owner.json'), '{not-json');
    await utimes(corrupt, new Date(0), new Date(0));
    const foreign = join(root, 'speech-kit-youtube-foreign');
    await mkdir(foreign);
    await writeFile(
      join(foreign, 'owner.json'),
      JSON.stringify({ instanceId: 'foreign-instance', pid: process.pid, speechKitJob: false }),
    );
    await utimes(foreign, new Date(0), new Date(0));
    const future = join(root, 'speech-kit-youtube-future');
    await mkdir(future);
    await writeFile(
      join(future, 'owner.json'),
      JSON.stringify({
        createdAt: 1,
        heartbeatAt: Date.now() + 10_000_000,
        instanceId: '123e4567-e89b-42d3-a456-426614174001',
        pid: 424_243,
        processStartedAt: 1,
        speechKitJob: true,
      }),
    );
    await utimes(future, new Date(0), new Date(0));
    const unrelatedLive = join(root, 'speech-kit-youtube-unrelated');
    await mkdir(unrelatedLive);
    await writeFile(
      join(unrelatedLive, 'owner.json'),
      JSON.stringify({
        createdAt: 1,
        heartbeatAt: 200_000,
        instanceId: '123e4567-e89b-42d3-a456-426614174002',
        pid: process.pid,
        processStartedAt: 1,
        speechKitJob: true,
      }),
    );
    await utimes(unrelatedLive, new Date(0), new Date(0));
    await sweepAbandonedYouTubeJobs(root, {
      cleanupSpawnProcess: successfulCleanupSpawn(
        root,
        new Set([
          'speech-kit-youtube-active-old',
          'speech-kit-youtube-corrupt',
          'speech-kit-youtube-current',
          'speech-kit-youtube-foreign',
          'speech-kit-youtube-future',
          'speech-kit-youtube-old',
          'speech-kit-youtube-recent',
          'speech-kit-youtube-unrelated',
        ]),
      ),
      minAgeMs: 10,
      now: () => 200_000,
    });
    const remaining = await readdir(root);
    expect(remaining).toEqual([
      'speech-kit-youtube-active-old',
      'speech-kit-youtube-corrupt',
      'speech-kit-youtube-current',
      'speech-kit-youtube-foreign',
      'speech-kit-youtube-future',
      'speech-kit-youtube-old',
      'speech-kit-youtube-recent',
      'speech-kit-youtube-unrelated',
    ]);
  });
  it('retains a partial private job root safely when directory setup fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-partial-'));
    temporaryPaths.push(root);
    await expect(
      createPrivateJobRoot(root, {
        cleanupSpawnProcess: successfulCleanupSpawn(root),
        subdirectories: ['owner.json'],
      }),
    ).rejects.toMatchObject({ code: 'tool_failed' });
    await expectSafeCleanupOutcome(root);
  });

  it('enforces wall, output, size, and tool limits with local fake helpers', async () => {
    const wallHelper = await makeHelper(true);
    const wallRoot = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-wall-'));
    temporaryPaths.push(wallRoot);
    const wallSource = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(wallRoot),
      getHelperPath: () => wallHelper,
      tempRoot: wallRoot,
      wallTimeMs: 50,
    });
    await expect(
      collect(wallSource.acquire(youtubeRequest(new AbortController().signal))),
    ).rejects.toMatchObject({
      code: 'resource_limit',
    });

    const outputHelper = await makeHelper(false, { title: 'x'.repeat(200) });
    const outputRoot = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-output-'));
    temporaryPaths.push(outputRoot);
    const outputSource = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(outputRoot),
      getHelperPath: () => outputHelper,
      maxOutputBytes: 100,
      tempRoot: outputRoot,
    });
    await expect(
      collect(outputSource.acquire(youtubeRequest(new AbortController().signal))),
    ).rejects.toMatchObject({
      code: 'resource_limit',
    });

    const sizeHelper = await makeHelper(false, {}, 20);
    const sizeRoot = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-size-'));
    temporaryPaths.push(sizeRoot);
    const sizeSource = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(sizeRoot),
      getHelperPath: () => sizeHelper,
      tempRoot: sizeRoot,
    });
    await expect(
      collect(
        sizeSource.acquire({ ...youtubeRequest(new AbortController().signal), maxBytes: 10 }),
      ),
    ).rejects.toMatchObject({ code: 'resource_limit' });

    const failHelper = await makeHelper(false, {}, 5, true);
    const failRoot = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-tool-'));
    temporaryPaths.push(failRoot);
    const failSource = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(failRoot),
      getHelperPath: () => failHelper,
      tempRoot: failRoot,
    });
    await expect(
      collect(failSource.acquire(youtubeRequest(new AbortController().signal))),
    ).rejects.toMatchObject({
      code: 'tool_failed',
    });
  });

  it('cancels an active source when the source-specific disable path calls cancel()', async () => {
    const helper = await makeHelper(true);
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-cancel-source-'));
    temporaryPaths.push(root);
    const source = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(root),
      getHelperPath: () => helper,
      tempRoot: root,
    });
    const acquisition = collect(source.acquire(youtubeRequest(new AbortController().signal)));
    setTimeout(() => source.cancel(), 300);
    await expect(acquisition).rejects.toMatchObject({ code: 'cancelled' });
    await expectSafeCleanupOutcome(root);
  });

  it('kills a real child on cancellation and does not leave a job directory', async () => {
    const helper = await makeHelper(true);
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-cancel-'));
    temporaryPaths.push(root);
    const controller = new AbortController();
    const source = new YouTubeMediaSource({
      cleanupSpawnProcess: successfulCleanupSpawn(root),
      getHelperPath: () => helper,
      tempRoot: root,
    });
    const acquisition = (async () => {
      for await (const _event of source.acquire(youtubeRequest(controller.signal))) {
        // The source owns the child until it exits or cancellation is observed.
      }
    })();
    setTimeout(() => controller.abort(), 300);
    await expect(acquisition).rejects.toMatchObject({ code: 'cancelled' });
    await expectSafeCleanupOutcome(root);
  });
});

async function createLease(
  jobRoot: string,
  mediaPath: string,
  maxBytes = 10,
  cleanup?: JobCleanupOptions,
) {
  const validatedMediaFile = await openValidatedMediaFile(jobRoot, mediaPath, maxBytes);
  return await createPathBackedMediaLease({
    cleanup: {
      ...(cleanup === undefined ? {} : cleanup),
      spawnProcess: cleanup?.spawnProcess ?? successfulCleanupSpawn(jobRoot),
    },
    provenance: {
      acquiredAt: new Date().toISOString(),
      adapterVersion: 'test',
      sourceId: 'local_file',
      temporaryMedia: true,
    },
    validatedMediaFile,
  });
}

function youtubeRequest(signal: AbortSignal): YouTubeMediaAcquireRequest {
  return {
    kind: 'interactive',
    maxBytes: 1_000,
    maxDurationMs: 30_000,
    provider: {
      consent: explicitYouTubeRightsConfirmation(),
      helperVersion: '2026.08.19',
      inputUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      ref: parseYouTubeVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    },
    signal,
  };
}

async function makeHelper(
  slow: boolean,
  metadata: Record<string, unknown> = {},
  outputBytes = 5,
  fail = false,
  descendant = false,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-helper-'));
  temporaryPaths.push(root);
  const helper = join(root, 'yt-dlp');
  const metadataJson = JSON.stringify({
    channel: 'Channel',
    channel_id: 'channel-1',
    duration: 1,
    ext: 'webm',
    id: 'dQw4w9WgXcQ',
    is_live: false,
    live_status: 'not_live',
    title: 'Fixture',
    webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ...metadata,
  });
  await writeFile(
    helper,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'yt-dlp 2026.08.19'
  exit 0
fi
printf '%s\\n' 'before_dl:${metadataJson}'
${descendant ? '(sleep 1; printf alive > descendant.txt) & sleep 0.05' : ''}
${fail ? 'exit 1' : slow ? 'sleep 10' : `printf '%${outputBytes}s' audio > source.webm`}
`,
    { mode: 0o700 },
  );
  await chmod(helper, 0o700);
  return helper;
}
