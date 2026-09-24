import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type {
  AcquisitionEvent,
  AcquisitionFailureCode,
  MediaAcquireRequest,
  MediaLease,
  MediaPlan,
  MediaProvenance,
  MediaRights,
  MediaSource,
  SourceRef,
} from './media-source';
import {
  createPathBackedMediaLease,
  type PathBackedMediaLeaseOptions,
  PathMediaLeaseError,
} from './path-backed-media-lease';
import {
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
  YouTubeHelperError,
} from './youtube-helper';
import {
  canonicalYouTubeUrl,
  InvalidYouTubeUrlError,
  isYouTubeSourceRef,
  parseYouTubeVideoUrl,
  type YouTubeVideoRef,
} from './youtube-url';

export const YOUTUBE_MEDIA_ADAPTER_VERSION = '1';
export const YOUTUBE_POLICY_VERSION = '2026-09-24.experimental-v1';
export const YOUTUBE_MAX_WALL_TIME_MS = 10 * 60 * 1_000;
export const YOUTUBE_MAX_STDOUT_BYTES = 256 * 1024;
export const YOUTUBE_MAX_STDERR_BYTES = 64 * 1024;
export const YOUTUBE_MAX_RETRIES = 0;
export const YOUTUBE_RATE_LIMIT = '2M';
export const YOUTUBE_JOB_PREFIX = 'speech-kit-youtube-';

export class YouTubeAcquisitionError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly code: AcquisitionFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'YouTubeAcquisitionError';
    this.cause = options?.cause;
  }
}

export interface YouTubeMediaSourceDependencies {
  readonly getHelperPath: () => string;
  readonly tempRoot?: string;
  readonly spawnProcess?: typeof spawn;
  readonly wallTimeMs?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => number;
}

export interface YouTubeHelperMetadata {
  readonly channel?: { readonly id?: string; readonly name?: string };
  readonly container?: string;
  readonly durationMs?: number;
  readonly title?: string;
  readonly videoId?: string;
}

export class YouTubeMediaSource implements MediaSource {
  readonly adapterVersion = YOUTUBE_MEDIA_ADAPTER_VERSION;
  readonly id = 'youtube_yt_dlp' as const;
  private readonly tempRoot: string;
  private readonly spawnProcess: typeof spawn;
  private readonly wallTimeMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private jobInUse = false;

  constructor(private readonly dependencies: YouTubeMediaSourceDependencies) {
    this.tempRoot = resolve(dependencies.tempRoot ?? tmpdir());
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.wallTimeMs = dependencies.wallTimeMs ?? YOUTUBE_MAX_WALL_TIME_MS;
    this.maxOutputBytes = dependencies.maxOutputBytes ?? YOUTUBE_MAX_STDOUT_BYTES;
    this.now = dependencies.now ?? Date.now;
  }

  async inspect(ref: SourceRef, signal: AbortSignal): Promise<MediaPlan> {
    throwIfCancelled(signal);
    const video = requireYouTubeRef(ref);
    return createPlan(video, this.id);
  }

  async *acquire(request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent> {
    throwIfCancelled(request.signal);
    const video = requireYouTubeRef(request.ref);
    assertRights(request.rights);
    const helperPath = normalizeYouTubeHelperPath(this.dependencies.getHelperPath());
    if (this.jobInUse) {
      throw new YouTubeAcquisitionError(
        'resource_limit',
        'A YouTube acquisition is already running.',
      );
    }
    if (helperPath === null) {
      throw new YouTubeAcquisitionError(
        'helper_unavailable',
        'Select an absolute yt-dlp executable path.',
      );
    }
    this.jobInUse = true;

    let helperVersion: string;
    try {
      const version = await probeYtDlpVersion(helperPath, {
        signal: request.signal,
        spawnProcess: this.spawnProcess,
      });
      helperVersion = version.version;
    } catch (error) {
      this.jobInUse = false;
      throw mapHelperError(error, request.signal);
    }

    let jobRoot: string;
    try {
      jobRoot = await createPrivateJobRoot(this.tempRoot);
    } catch {
      this.jobInUse = false;
      throw new YouTubeAcquisitionError(
        'tool_failed',
        'A private YouTube job directory could not be created.',
      );
    }
    let handedOff = false;
    try {
      const plan = createPlan(video, this.id);
      yield { plan, type: 'plan' };
      yield { bytes: 0, phase: 'read', totalBytes: request.maxBytes, type: 'progress' };

      const args = buildYouTubeAcquisitionArgs({
        jobRoot,
        maxBytes: request.maxBytes,
        maxDurationSeconds: request.maxDurationMs / 1_000,
        video,
      });
      const child = this.spawnProcess(helperPath, args, {
        cwd: jobRoot,
        detached: process.platform !== 'win32',
        env: sanitizedAcquisitionEnvironment(jobRoot),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const execution = await runHelper(child, {
        maxOutputBytes: this.maxOutputBytes,
        signal: request.signal,
        wallTimeMs: this.wallTimeMs,
      });
      for (const event of execution.events) yield event;
      if (request.signal.aborted)
        throw new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.');
      if (execution.cancelled)
        throw new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.');
      if (execution.timedOut || execution.outputLimitExceeded) {
        throw new YouTubeAcquisitionError(
          'resource_limit',
          'The YouTube acquisition exceeded a safety limit.',
        );
      }
      if (execution.exitCode !== 0) {
        throw mapHelperFailure(execution.stderr);
      }

      const metadata = execution.metadata;
      if (metadata.videoId !== undefined && metadata.videoId !== video.videoId) {
        throw new YouTubeAcquisitionError(
          'extractor_changed',
          'The YouTube helper returned a different video than requested.',
        );
      }
      const durationMs = metadata.durationMs;
      if (durationMs !== undefined && durationMs > request.maxDurationMs) {
        throw new YouTubeAcquisitionError(
          'resource_limit',
          'The YouTube video is longer than the safety limit.',
        );
      }
      const media = await findAcquiredMedia(jobRoot, request.maxBytes);
      await chmod(media.path, 0o600);
      const provenance: MediaProvenance = {
        ...metadata,
        acquiredAt: new Date(this.now()).toISOString(),
        adapterVersion: this.adapterVersion,
        canonicalUrl: video.canonicalUrl,
        helperVersion,
        rights: { kind: 'declared_by_source', policyVersion: YOUTUBE_POLICY_VERSION },
        sourceId: this.id,
        sourceRef: { kind: 'youtube_video_id', videoId: video.videoId },
        temporaryMedia: true,
      };
      const baseLease = await createLease({
        encodedBytes: media.size,
        jobRoot,
        maxBytes: request.maxBytes,
        mediaPath: media.path,
        provenance,
      });
      let releasePromise: Promise<void> | null = null;
      const releaseLease = (): Promise<void> => {
        if (releasePromise === null) {
          releasePromise = baseLease.release().finally(() => {
            this.jobInUse = false;
          });
        }
        return releasePromise;
      };
      const lease: MediaLease = {
        ...baseLease,
        dispose: releaseLease,
        release: releaseLease,
      };
      handedOff = true;
      yield { lease, type: 'ready' };
    } catch (error) {
      if (!handedOff) {
        this.jobInUse = false;
        await removeJobBestEffort(jobRoot);
      }
      throw normalizeAcquisitionError(error, request.signal);
    }
  }
}

export async function sweepAbandonedYouTubeJobs(tempRoot = tmpdir()): Promise<void> {
  const root = resolve(tempRoot);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.allSettled(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(YOUTUBE_JOB_PREFIX))
        .map((entry) =>
          import('./path-backed-media-lease').then(({ removeMediaJob }) =>
            removeMediaJob(join(root, entry.name)),
          ),
        ),
    );
  } catch {
    // Startup cleanup is best effort and must not prevent plugin loading.
  }
}

export function buildYouTubeAcquisitionArgs(options: {
  readonly jobRoot: string;
  readonly maxBytes: number;
  readonly maxDurationSeconds?: number;
  readonly video: YouTubeVideoRef;
}): string[] {
  const canonicalUrl = canonicalYouTubeUrl(options.video.videoId);
  return [
    '--ignore-config',
    '--no-config-locations',
    '--no-cache-dir',
    '--no-plugin-dirs',
    '--no-remote-components',
    '--no-cookies',
    '--no-playlist',
    '--no-mark-watched',
    '--no-live-from-start',
    '--no-write-info-json',
    '--no-write-thumbnail',
    '--no-write-subs',
    '--no-write-auto-subs',
    '--no-archive',
    '--no-simulate',
    '--use-extractors',
    'youtube',
    '--format',
    'bestaudio',
    '--paths',
    options.jobRoot,
    '--output',
    'source.%(ext)s',
    '--max-filesize',
    String(options.maxBytes),
    '--concurrent-fragments',
    '1',
    '--retries',
    String(YOUTUBE_MAX_RETRIES),
    '--fragment-retries',
    String(YOUTUBE_MAX_RETRIES),
    '--extractor-retries',
    String(YOUTUBE_MAX_RETRIES),
    '--file-access-retries',
    String(YOUTUBE_MAX_RETRIES),
    '--limit-rate',
    YOUTUBE_RATE_LIMIT,
    '--socket-timeout',
    '10',
    '--match-filter',
    `duration <= ${Math.max(1, Math.floor(options.maxDurationSeconds ?? 1_800))}`,
    '--newline',
    '--print',
    'before_dl:%(.{id,title,channel,channel_id,duration,ext,webpage_url})j',
    '--',
    canonicalUrl,
  ];
}

export function sanitizedAcquisitionEnvironment(jobRoot: string): NodeJS.ProcessEnv {
  const privateHome = join(jobRoot, 'home');
  const privateTmp = join(jobRoot, 'tmp');
  const privateCache = join(jobRoot, 'cache');
  return {
    HOME: privateHome,
    LANG: 'C',
    LC_ALL: 'C',
    TEMP: privateTmp,
    TMP: privateTmp,
    TMPDIR: privateTmp,
    USERPROFILE: privateHome,
    XDG_CACHE_HOME: privateCache,
    XDG_CONFIG_HOME: join(jobRoot, 'config'),
    XDG_DATA_HOME: join(jobRoot, 'data'),
  };
}

export function parseYouTubeHelperMetadata(output: string): YouTubeHelperMetadata {
  const lines = output.split(/\r?\n/u);
  let parsed: unknown = null;
  for (const line of lines) {
    const candidate = line.startsWith('before_dl:') ? line.slice('before_dl:'.length) : line.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      parsed = JSON.parse(candidate);
      break;
    } catch {
      // Ignore progress and malformed lines; never retain or log them.
    }
  }
  if (!isRecord(parsed)) return {};
  const videoId = safeString(parsed.id, 11);
  const title = safeString(parsed.title, 512);
  const channelName = safeString(parsed.channel, 512);
  const channelId = safeString(parsed.channel_id, 128);
  const durationSeconds = typeof parsed.duration === 'number' ? parsed.duration : Number.NaN;
  const durationMs =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? Math.round(durationSeconds * 1_000)
      : undefined;
  const container = safeString(parsed.ext, 32);
  return {
    ...(videoId === undefined ? {} : { videoId }),
    ...(title === undefined ? {} : { title }),
    ...(channelName === undefined && channelId === undefined
      ? {}
      : {
          channel: {
            ...(channelId === undefined ? {} : { id: channelId }),
            ...(channelName === undefined ? {} : { name: channelName }),
          },
        }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(container === undefined ? {} : { container }),
  };
}

async function createPrivateJobRoot(tempRoot: string): Promise<string> {
  await mkdir(tempRoot, { recursive: true });
  const jobRoot = await mkdtemp(join(tempRoot, YOUTUBE_JOB_PREFIX));
  await chmod(jobRoot, 0o700);
  for (const directory of ['home', 'tmp', 'cache', 'config', 'data']) {
    await mkdir(join(jobRoot, directory), { recursive: true, mode: 0o700 });
  }
  return jobRoot;
}

async function createLease(options: PathBackedMediaLeaseOptions) {
  try {
    return await createPathBackedMediaLease(options);
  } catch (error) {
    if (error instanceof PathMediaLeaseError) {
      throw new YouTubeAcquisitionError(
        'resource_limit',
        'The acquired YouTube media failed validation.',
      );
    }
    throw error;
  }
}

async function findAcquiredMedia(
  jobRoot: string,
  maxBytes: number,
): Promise<{ path: string; size: number }> {
  const entries = await readdir(jobRoot, { withFileTypes: true });
  const candidates = entries.filter(
    (entry) => entry.isFile() && /^source\.[A-Za-z0-9_-]+$/u.test(entry.name),
  );
  if (candidates.length !== 1) {
    throw new YouTubeAcquisitionError(
      'tool_failed',
      'The YouTube helper did not produce one audio file.',
    );
  }
  const path = join(jobRoot, candidates[0]?.name ?? '');
  const fileStat = await stat(path);
  if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > maxBytes) {
    throw new YouTubeAcquisitionError(
      'resource_limit',
      'The YouTube media exceeded a safety limit.',
    );
  }
  return { path, size: fileStat.size };
}

async function removeJobBestEffort(jobRoot: string): Promise<void> {
  try {
    const { removeMediaJob } = await import('./path-backed-media-lease');
    await removeMediaJob(jobRoot);
  } catch {
    // Cleanup is best effort across supported operating systems.
  }
}

function createPlan(video: YouTubeVideoRef, sourceId: MediaSource['id']): MediaPlan {
  return {
    access: 'public_guest',
    canonicalUrl: video.canonicalUrl,
    displayName: `YouTube video ${video.videoId}`,
    host: video.host,
    restrictions: ['no_live', 'no_playlist', 'no_authentication', 'no_drm_bypass'],
    requiresConsent: true,
    sourceId,
    videoId: video.videoId,
    warnings: ['Experimental unofficial helper: yt-dlp contacts YouTube and may stop working.'],
  };
}

function requireYouTubeRef(ref: SourceRef | undefined): YouTubeVideoRef {
  if (ref === undefined || !isYouTubeSourceRef(ref)) {
    throw new YouTubeAcquisitionError('invalid_or_unsupported_url', 'Enter one YouTube VOD URL.');
  }
  try {
    return parseYouTubeVideoUrl(`https://www.youtube.com/watch?v=${ref.videoId}`);
  } catch (error) {
    if (error instanceof InvalidYouTubeUrlError) {
      throw new YouTubeAcquisitionError('invalid_or_unsupported_url', 'Enter one YouTube VOD URL.');
    }
    throw error;
  }
}

function assertRights(rights: MediaRights | undefined): void {
  if (rights?.kind !== 'declared_by_source' || rights.policyVersion !== YOUTUBE_POLICY_VERSION) {
    throw new YouTubeAcquisitionError(
      'rights_not_established',
      'Confirm that you own or are authorized to process this video.',
    );
  }
}

function normalizeAcquisitionError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted)
    return new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.');
  if (error instanceof YouTubeAcquisitionError || error instanceof YouTubeHelperError) return error;
  if (error instanceof PathMediaLeaseError)
    return new YouTubeAcquisitionError(
      'resource_limit',
      'The acquired YouTube media failed validation.',
    );
  return new YouTubeAcquisitionError(
    'tool_failed',
    'The YouTube helper could not complete the acquisition.',
  );
}

function mapHelperError(error: unknown, signal: AbortSignal): YouTubeAcquisitionError {
  if (signal.aborted)
    return new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.');
  if (error instanceof YouTubeHelperError) {
    return new YouTubeAcquisitionError(error.code, error.message);
  }
  return new YouTubeAcquisitionError('tool_failed', 'The yt-dlp helper could not be started.');
}

function mapHelperFailure(stderr: string): YouTubeAcquisitionError {
  const text = stderr.toLowerCase();
  if (text.includes('429') || text.includes('rate limit'))
    return new YouTubeAcquisitionError('rate_limited', 'YouTube rate-limited the helper request.');
  if (text.includes('private') || text.includes('not found') || text.includes('unavailable'))
    return new YouTubeAcquisitionError(
      'not_found_or_private',
      'The YouTube video is unavailable or private.',
    );
  if (text.includes('age'))
    return new YouTubeAcquisitionError('age_restricted', 'The YouTube video is age-restricted.');
  if (text.includes('member'))
    return new YouTubeAcquisitionError(
      'membership_required',
      'The YouTube video requires membership.',
    );
  if (text.includes('purchase') || text.includes('rent'))
    return new YouTubeAcquisitionError(
      'purchase_required',
      'The YouTube video requires a purchase or rental.',
    );
  if (text.includes('drm'))
    return new YouTubeAcquisitionError('drm_protected', 'The YouTube video is DRM-protected.');
  if (text.includes('region') || text.includes('geo'))
    return new YouTubeAcquisitionError(
      'region_restricted',
      'The YouTube video is unavailable in this region.',
    );
  if (text.includes('login') || text.includes('sign in') || text.includes('cookie'))
    return new YouTubeAcquisitionError(
      'authentication_required',
      'The YouTube helper would require authentication.',
    );
  if (
    text.includes('http error') ||
    text.includes('timed out') ||
    text.includes('connection') ||
    text.includes('network') ||
    text.includes('unable to download webpage')
  )
    return new YouTubeAcquisitionError(
      'network_failed',
      'The YouTube helper could not reach the video service.',
    );
  if (text.includes('extract') || text.includes('unsupported url'))
    return new YouTubeAcquisitionError(
      'extractor_changed',
      'The YouTube extractor changed or no longer supports this URL.',
    );
  return new YouTubeAcquisitionError(
    'tool_failed',
    'The yt-dlp helper could not complete the acquisition.',
  );
}

interface HelperExecution {
  readonly cancelled: boolean;
  readonly events: AcquisitionEvent[];
  readonly exitCode: number | null;
  readonly metadata: YouTubeHelperMetadata;
  readonly outputLimitExceeded: boolean;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function runHelper(
  child: ChildProcess,
  options: { maxOutputBytes: number; signal: AbortSignal; wallTimeMs: number },
): Promise<HelperExecution> {
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputLimitExceeded = false;
  let timedOut = false;
  let cancelled = false;
  let exitCode: number | null = null;
  const events: AcquisitionEvent[] = [];
  let lastProgressBytes: number | undefined;
  const started = Date.now();

  const closePromise = new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      exitCode = code;
      window.clearInterval(pollTimer);
      window.clearTimeout(wallTimer);
      options.signal.removeEventListener('abort', abort);
      resolvePromise();
    };
    const abort = (): void => {
      cancelled = true;
      killChild(child);
    };
    const pollTimer = window.setInterval(() => {
      const progress = parseProgress(stdout);
      if (progress !== null && progress.bytes !== lastProgressBytes && events.length < 256) {
        lastProgressBytes = progress.bytes;
        events.push({ ...progress, type: 'progress' });
      }
      if (Date.now() - started > options.wallTimeMs) {
        timedOut = true;
        killChild(child);
      }
    }, 100);
    const wallTimer = window.setTimeout(() => {
      timedOut = true;
      killChild(child);
    }, options.wallTimeMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutBytes += Buffer.byteLength(value);
      if (stdoutBytes > options.maxOutputBytes) {
        outputLimitExceeded = true;
        killChild(child);
        return;
      }
      stdout += value;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrBytes += Buffer.byteLength(value);
      if (stderrBytes > YOUTUBE_MAX_STDERR_BYTES) {
        outputLimitExceeded = true;
        killChild(child);
        return;
      }
      stderr += value;
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
  });

  await closePromise;
  return {
    cancelled,
    events,
    exitCode,
    metadata: parseYouTubeHelperMetadata(stdout),
    outputLimitExceeded,
    stderr,
    timedOut,
  };
}

function parseProgress(
  output: string,
): { bytes?: number; phase: string; totalBytes?: number } | null {
  const match = /(?:\[download\]\s+)?(\d+(?:\.\d+)?)(?:%|MiB|KiB|GiB|B|KB|MB|GB)/iu.exec(output);
  if (match === null) return null;
  const bytes = parseProgressBytes(match[0]);
  if (bytes === undefined) return null;
  return { bytes, phase: 'download' };
}

function parseProgressBytes(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(%|MiB|KiB|GiB|B|KB|MB|GB)$/iu.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === '%'
      ? 1
      : unit === 'b'
        ? 1
        : unit === 'kb' || unit === 'kib'
          ? 1024
          : unit === 'mb' || unit === 'mib'
            ? 1024 * 1024
            : unit === 'gb' || unit === 'gib'
              ? 1024 * 1024 * 1024
              : 1;
  return Math.round(amount * multiplier);
}

function killChild(child: ChildProcess): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      scheduleForcedKill(child);
      return;
    } catch {
      // Fall through to the direct child kill used by test doubles and Windows.
    }
  }
  child.kill('SIGTERM');
  scheduleForcedKill(child);
}

function scheduleForcedKill(child: ChildProcess): void {
  window.setTimeout(() => {
    if (child.pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
        return;
      } catch {
        // Fall through to the direct child kill.
      }
    }
    child.kill('SIGKILL');
  }, 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  })
    .join('')
    .trim();
  return cleaned.length === 0 ? undefined : cleaned.slice(0, maxLength);
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted)
    throw new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.');
}
