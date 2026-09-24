import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { t } from '../shared/i18n';
import type {
  AcquisitionEvent,
  MediaAcquireRequest,
  MediaAcquireRequestBase,
  MediaLease,
  MediaPlan,
  MediaSource,
} from './media-source';
import {
  claimJobRoot,
  createPathBackedMediaLease,
  type JobRootCapability,
  openValidatedMediaFile,
  type PathBackedMediaLeaseOptions,
  PathMediaLeaseError,
  removeMediaJob,
} from './path-backed-media-lease';
import { runManagedProcess } from './process-runner';
import {
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
  YouTubeHelperError,
} from './youtube-helper';
import {
  canonicalYouTubeUrl,
  isYouTubeVideoId,
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
export const YOUTUBE_CONSENT_ID = 'youtube-policy-confirmation';
export const YOUTUBE_ABANDONED_JOB_MIN_AGE_MS = 6 * 60 * 60 * 1_000;
export const YOUTUBE_OWNER_HEARTBEAT_INTERVAL_MS = 30_000;
export const YOUTUBE_OWNER_HEARTBEAT_FRESH_MS = 2 * 60 * 1_000;
const YOUTUBE_OWNER_CLOCK_SKEW_MS = 5_000;

export type YouTubeFailureCode =
  | 'invalid_or_unsupported_url'
  | 'not_found_or_private'
  | 'region_restricted'
  | 'age_restricted'
  | 'membership_required'
  | 'purchase_required'
  | 'drm_protected'
  | 'authentication_required'
  | 'rate_limited'
  | 'network_failed'
  | 'extractor_changed'
  | 'live_stream'
  | 'integrity_failed'
  | 'rights_not_established'
  | 'helper_unavailable'
  | 'helper_version_unsupported'
  | 'resource_limit'
  | 'tool_failed'
  | 'cancelled';

export interface YouTubeConsentGrant {
  readonly consentId: typeof YOUTUBE_CONSENT_ID;
  readonly policyVersion: typeof YOUTUBE_POLICY_VERSION;
}

export interface YouTubeAcquisitionContext {
  readonly consent: YouTubeConsentGrant;
  readonly helperVersion: string;
  readonly ref: YouTubeVideoRef;
}

export type YouTubeMediaAcquireRequest = MediaAcquireRequest<YouTubeAcquisitionContext>;

export interface YouTubeMediaPlan extends MediaPlan {
  readonly canonicalUrl: string;
  readonly host: string;
  readonly videoId: string;
}

export interface YouTubeMediaLease extends MediaLease {
  readonly youtubeProvenance: YouTubeMediaProvenance;
}

export interface YouTubeMediaProvenance {
  readonly channel: { readonly id: string; readonly name: string };
  readonly container: string;
  readonly durationMs: number;
  readonly helperVersion: string;
  readonly publicUrl: string;
  readonly title: string;
  readonly videoId: string;
}

export function hasYouTubeRightsConfirmation(storedPolicyVersion: string | null): boolean {
  return storedPolicyVersion === YOUTUBE_POLICY_VERSION;
}

export function explicitYouTubeRightsConfirmation(): YouTubeConsentGrant {
  return { consentId: YOUTUBE_CONSENT_ID, policyVersion: YOUTUBE_POLICY_VERSION };
}

export class YouTubeAcquisitionError extends Error {
  override readonly cause?: undefined;

  constructor(
    readonly code: YouTubeFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeAcquisitionError';
    this.cause = undefined;
  }
}

export interface YouTubeMediaSourceDependencies {
  readonly getHelperPath: () => string;
  readonly tempRoot?: string;
  readonly spawnProcess?: typeof spawn;
  readonly wallTimeMs?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

export interface YouTubeHelperMetadata {
  readonly channel?: { readonly id?: string; readonly name?: string };
  readonly container?: string;
  readonly durationMs?: number;
  readonly isLive?: boolean;
  readonly liveStatus?: string;
  readonly publicUrl?: string;
  readonly title?: string;
  readonly videoId?: string;
}

export class YouTubeMediaSource implements MediaSource<YouTubeMediaAcquireRequest> {
  readonly adapterVersion = YOUTUBE_MEDIA_ADAPTER_VERSION;
  readonly id = 'youtube_yt_dlp' as const;
  private readonly tempRoot: string;
  private readonly spawnProcess: typeof spawn;
  private readonly wallTimeMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private jobInUse = false;
  private activeAbortController: AbortController | null = null;

  constructor(private readonly dependencies: YouTubeMediaSourceDependencies) {
    this.tempRoot = resolve(dependencies.tempRoot ?? tmpdir());
    this.spawnProcess = dependencies.spawnProcess ?? spawn;
    this.wallTimeMs = dependencies.wallTimeMs ?? YOUTUBE_MAX_WALL_TIME_MS;
    this.maxOutputBytes = dependencies.maxOutputBytes ?? YOUTUBE_MAX_STDOUT_BYTES;
    this.now = dependencies.now ?? Date.now;
    this.platform = dependencies.platform ?? process.platform;
  }

  cancel(): void {
    this.activeAbortController?.abort(
      new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.'),
    );
  }

  createRequest(
    context: YouTubeAcquisitionContext,
    request: MediaAcquireRequestBase,
  ): YouTubeMediaAcquireRequest {
    return { ...request, provider: context };
  }

  async *acquire(
    request: YouTubeMediaAcquireRequest,
  ): AsyncIterable<AcquisitionEvent<YouTubeMediaLease>> {
    if (!isYouTubeMediaAcquireRequest(request)) {
      throw new YouTubeAcquisitionError('invalid_or_unsupported_url', 'Enter one YouTube VOD URL.');
    }
    throwIfCancelled(request.signal);
    const video = request.provider.ref;
    assertConsent(request.provider.consent);
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
    const activeController = new AbortController();
    this.activeAbortController = activeController;
    const forwardAbort = (): void => {
      activeController.abort(request.signal.reason);
    };
    request.signal.addEventListener('abort', forwardAbort, { once: true });
    let jobRoot: JobRootCapability | null = null;
    let heartbeat: OwnerHeartbeat | null = null;
    let handedOff = false;
    try {
      const version = await probeYtDlpVersion(helperPath, {
        platform: this.platform,
        signal: activeController.signal,
        spawnProcess: this.spawnProcess,
      });
      const helperVersion = version.version;
      if (helperVersion !== request.provider.helperVersion) {
        throw new YouTubeAcquisitionError(
          'helper_version_unsupported',
          'The selected yt-dlp version no longer matches the probed helper.',
        );
      }
      jobRoot = await createPrivateJobRoot(this.tempRoot);
      const jobPath = jobRoot.path;
      heartbeat = startOwnerHeartbeat(jobPath);
      const plan = createPlan(video, this.id);
      yield { plan, type: 'plan' };
      yield { bytes: 0, phase: 'read', totalBytes: request.maxBytes, type: 'progress' };

      const args = buildYouTubeAcquisitionArgs({
        jobRoot: jobPath,
        maxBytes: request.maxBytes,
        maxDurationSeconds: request.maxDurationMs / 1_000,
        video,
      });
      const execution = await runHelper({
        args,
        command: helperPath,
        cwd: jobPath,
        env: sanitizedAcquisitionEnvironment(jobPath),
        maxOutputBytes: this.maxOutputBytes,
        platform: this.platform,
        signal: activeController.signal,
        spawnProcess: this.spawnProcess,
        wallTimeMs: this.wallTimeMs,
      });
      for (const event of execution.events) yield event;
      if (activeController.signal.aborted || execution.cancelled) {
        throw new YouTubeAcquisitionError('cancelled', 'The YouTube acquisition was cancelled.');
      }
      if (execution.timedOut || execution.outputLimitExceeded) {
        throw new YouTubeAcquisitionError(
          'resource_limit',
          'The YouTube acquisition exceeded a safety limit.',
        );
      }
      if (execution.cleanupFailed) {
        throw new YouTubeAcquisitionError(
          'tool_failed',
          'The YouTube helper process tree could not be cleaned up safely.',
        );
      }
      if (execution.exitCode !== 0) throw mapHelperFailure(execution.stderr);

      const metadata = validateYouTubeMetadata(execution.metadata, video);
      if (metadata.durationMs > request.maxDurationMs) {
        throw new YouTubeAcquisitionError(
          'resource_limit',
          'The YouTube video is longer than the safety limit.',
        );
      }
      const media = await findAcquiredMedia(jobPath);
      const validated = await openValidatedMediaFile(jobPath, media.path, request.maxBytes);
      let baseLease: MediaLease;
      try {
        baseLease = await createLease({
          provenance: {
            acquiredAt: new Date(this.now()).toISOString(),
            adapterVersion: this.adapterVersion,
            sourceId: this.id,
            temporaryMedia: true,
          },
          validatedMediaFile: validated,
        });
      } catch (error) {
        await validated.handle.close().catch(() => {});
        await validated.root.handle.close().catch(() => {});
        throw error;
      }
      const rootCapability = jobRoot;
      let releasePromise: Promise<void> | null = null;
      const releaseLease = (): Promise<void> => {
        if (releasePromise === null) {
          releasePromise = baseLease
            .release()
            .then(async () => {
              await stopOwnerHeartbeat(heartbeat);
              await removeMediaJob(rootCapability);
            })
            .catch(() => {})
            .finally(() => {
              this.jobInUse = false;
              this.activeAbortController = null;
            });
        }
        return releasePromise;
      };
      const lease: YouTubeMediaLease = {
        ...baseLease,
        release: releaseLease,
        youtubeProvenance: {
          channel: metadata.channel,
          container: metadata.container,
          durationMs: metadata.durationMs,
          helperVersion,
          publicUrl: metadata.publicUrl,
          title: metadata.title,
          videoId: metadata.videoId,
        },
      };
      handedOff = true;
      yield { lease, type: 'ready' };
    } catch (error) {
      throw normalizeAcquisitionError(error, activeController.signal);
    } finally {
      request.signal.removeEventListener('abort', forwardAbort);
      if (!handedOff) {
        await stopOwnerHeartbeat(heartbeat);
        heartbeat = null;
        this.jobInUse = false;
        this.activeAbortController = null;
        if (jobRoot !== null) {
          await removeJobBestEffort(jobRoot);
        }
      }
    }
  }
}

export async function sweepAbandonedYouTubeJobs(
  tempRoot = tmpdir(),
  options: { readonly minAgeMs?: number; readonly now?: () => number } = {},
): Promise<void> {
  const root = resolve(tempRoot);
  const now = options.now ?? Date.now;
  const minAgeMs = options.minAgeMs ?? YOUTUBE_ABANDONED_JOB_MIN_AGE_MS;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    await Promise.allSettled(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(YOUTUBE_JOB_PREFIX))
        .map(async (entry) => {
          const jobRoot = join(root, entry.name);
          const jobStat = await stat(jobRoot);
          if (now() - jobStat.mtimeMs < minAgeMs) return;
          if (await hasFreshOwnerHeartbeat(jobRoot, now())) return;
          const capability = await claimJobRoot(jobRoot);
          await removeMediaJob(capability);
        }),
    );
  } catch {
    // Startup cleanup is best effort and must not prevent plugin loading.
  }
}

export function isYouTubeOwnerHeartbeatFresh(value: unknown, now: number): boolean {
  if (!isValidOwnerMarker(value, now)) return false;
  return now - value.heartbeatAt < YOUTUBE_OWNER_HEARTBEAT_FRESH_MS;
}

async function hasFreshOwnerHeartbeat(jobRoot: string, now: number): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(jobRoot, 'owner.json'), 'utf8')) as unknown;
    return isYouTubeOwnerHeartbeatFresh(marker, now);
  } catch {
    return false;
  }
}

interface OwnerMarker {
  readonly createdAt: number;
  readonly heartbeatAt: number;
  readonly instanceId: string;
  readonly pid: number;
  readonly processStartedAt: number;
  readonly speechKitJob: true;
}

function isValidOwnerMarker(value: unknown, now: number): value is OwnerMarker {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Partial<OwnerMarker>;
  const pid = marker.pid;
  if (
    marker.speechKitJob !== true ||
    !isValidOwnerTimestamp(marker.createdAt, now) ||
    !isValidOwnerTimestamp(marker.heartbeatAt, now) ||
    !isValidOwnerTimestamp(marker.processStartedAt, now) ||
    typeof marker.instanceId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      marker.instanceId,
    ) ||
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    marker.createdAt < marker.processStartedAt - YOUTUBE_OWNER_CLOCK_SKEW_MS ||
    marker.heartbeatAt < marker.createdAt - YOUTUBE_OWNER_CLOCK_SKEW_MS
  ) {
    return false;
  }
  if (pid === process.pid) {
    const currentProcessStartedAt = Date.now() - process.uptime() * 1_000;
    if (Math.abs(currentProcessStartedAt - marker.processStartedAt) > YOUTUBE_OWNER_CLOCK_SKEW_MS) {
      return false;
    }
  }
  return true;
}

function isValidOwnerTimestamp(value: unknown, now: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= now + YOUTUBE_OWNER_CLOCK_SKEW_MS
  );
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
    'before_dl:%(.{id,title,channel,channel_id,duration,ext,is_live,live_status,webpage_url})j',
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
  const isLive = typeof parsed.is_live === 'boolean' ? parsed.is_live : undefined;
  const liveStatus = safeString(parsed.live_status, 32);
  const publicUrl = sanitizePublicUrl(safeString(parsed.webpage_url, 512));
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
    ...(isLive === undefined ? {} : { isLive }),
    ...(liveStatus === undefined ? {} : { liveStatus }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

function validateYouTubeMetadata(
  metadata: YouTubeHelperMetadata,
  requested: YouTubeVideoRef,
): {
  readonly channel: { readonly id: string; readonly name: string };
  readonly container: string;
  readonly durationMs: number;
  readonly publicUrl: string;
  readonly title: string;
  readonly videoId: string;
} {
  if (
    metadata.isLive === true ||
    metadata.liveStatus === 'is_live' ||
    metadata.liveStatus === 'is_upcoming'
  ) {
    throw new YouTubeAcquisitionError('live_stream', 'This YouTube video is not a completed VOD.');
  }
  if (
    metadata.videoId !== requested.videoId ||
    metadata.title === undefined ||
    metadata.channel?.id === undefined ||
    metadata.channel.name === undefined ||
    metadata.durationMs === undefined ||
    metadata.container === undefined ||
    metadata.isLive !== false ||
    metadata.liveStatus !== 'not_live' ||
    metadata.publicUrl === undefined
  ) {
    throw new YouTubeAcquisitionError(
      'extractor_changed',
      'The YouTube helper returned incomplete or changed metadata.',
    );
  }
  let publicVideo: YouTubeVideoRef;
  try {
    publicVideo = parseYouTubeVideoUrl(metadata.publicUrl);
  } catch {
    throw new YouTubeAcquisitionError(
      'extractor_changed',
      'The YouTube helper returned an invalid public URL.',
    );
  }
  if (publicVideo.videoId !== requested.videoId) {
    throw new YouTubeAcquisitionError(
      'extractor_changed',
      'The YouTube helper returned a different video than requested.',
    );
  }
  return {
    channel: { id: metadata.channel.id, name: metadata.channel.name },
    container: metadata.container,
    durationMs: metadata.durationMs,
    publicUrl: publicVideo.canonicalUrl,
    title: metadata.title,
    videoId: metadata.videoId,
  };
}

interface OwnerHeartbeat {
  readonly stop: () => Promise<void>;
}

interface OwnerIdentity {
  readonly createdAt: number;
  readonly instanceId: string;
  readonly pid: number;
  readonly processStartedAt: number;
}

function startOwnerHeartbeat(jobRoot: string): OwnerHeartbeat {
  let stopped = false;
  let pending = Promise.resolve();
  const identity = readOwnerIdentity(jobRoot);
  const update = (): void => {
    if (stopped) return;
    pending = pending
      .then(async () => {
        if (stopped) return;
        await writeOwnerHeartbeat(jobRoot, await identity);
      })
      .catch(() => {});
  };
  update();
  const timer = window.setInterval(update, YOUTUBE_OWNER_HEARTBEAT_INTERVAL_MS);
  return {
    stop: async () => {
      stopped = true;
      window.clearInterval(timer);
      await pending;
    },
  };
}

async function stopOwnerHeartbeat(heartbeat: OwnerHeartbeat | null): Promise<void> {
  await heartbeat?.stop();
}

async function readOwnerIdentity(jobRoot: string): Promise<OwnerIdentity> {
  const marker = JSON.parse(
    await readFile(join(jobRoot, 'owner.json'), 'utf8'),
  ) as Partial<OwnerIdentity>;
  if (
    typeof marker.createdAt !== 'number' ||
    typeof marker.instanceId !== 'string' ||
    typeof marker.pid !== 'number' ||
    typeof marker.processStartedAt !== 'number'
  ) {
    throw new Error('invalid owner identity');
  }
  return {
    createdAt: marker.createdAt,
    instanceId: marker.instanceId,
    pid: marker.pid,
    processStartedAt: marker.processStartedAt,
  };
}

async function writeOwnerHeartbeat(jobRoot: string, identity: OwnerIdentity): Promise<void> {
  const ownerPath = join(jobRoot, 'owner.json');
  const temporaryPath = `${ownerPath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify({ ...identity, heartbeatAt: Date.now(), speechKitJob: true }),
    { mode: 0o600 },
  );
  await rename(temporaryPath, ownerPath);
}

export async function createPrivateJobRoot(
  tempRoot: string,
  options: { readonly subdirectories?: readonly string[] } = {},
): Promise<JobRootCapability> {
  await mkdir(tempRoot, { recursive: true });
  const jobRoot = await mkdtemp(join(tempRoot, YOUTUBE_JOB_PREFIX));
  try {
    await writeFile(
      join(jobRoot, 'owner.json'),
      JSON.stringify({
        createdAt: Date.now(),
        heartbeatAt: Date.now(),
        instanceId: randomUUID(),
        pid: process.pid,
        processStartedAt: Date.now() - process.uptime() * 1_000,
        speechKitJob: true,
      }),
      { mode: 0o600 },
    );
    await chmod(jobRoot, 0o700);
    for (const directory of options.subdirectories ?? ['home', 'tmp', 'cache', 'config', 'data']) {
      await mkdir(join(jobRoot, directory), { recursive: true, mode: 0o700 });
    }
    return await claimJobRoot(jobRoot);
  } catch {
    try {
      const capability = await claimJobRoot(jobRoot);
      await removeMediaJob(capability);
    } catch {
      // Partial-root cleanup remains best effort.
    }
    throw new YouTubeAcquisitionError(
      'tool_failed',
      'The private YouTube job directory could not be created.',
    );
  }
}

async function createLease(options: PathBackedMediaLeaseOptions) {
  try {
    return await createPathBackedMediaLease(options);
  } catch (error) {
    if (error instanceof PathMediaLeaseError) {
      throw new YouTubeAcquisitionError(
        error.code === 'resource_limit' ? 'resource_limit' : 'integrity_failed',
        'The acquired YouTube media failed validation.',
      );
    }
    throw error;
  }
}

async function findAcquiredMedia(jobRoot: string): Promise<{ path: string }> {
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
  return { path: join(jobRoot, candidates[0]?.name ?? '') };
}

async function removeJobBestEffort(jobRoot: JobRootCapability): Promise<void> {
  try {
    await removeMediaJob(jobRoot);
  } catch {
    // Cleanup is best effort across supported operating systems.
  }
}

function createPlan(video: YouTubeVideoRef, sourceId: string): YouTubeMediaPlan {
  return {
    canonicalUrl: video.canonicalUrl,
    displayName: t('youtube.modal.displayName', { videoId: video.videoId }),
    host: video.host,
    sourceId,
    videoId: video.videoId,
  };
}

function isYouTubeMediaAcquireRequest(value: unknown): value is YouTubeMediaAcquireRequest {
  if (!isRecord(value) || !isRecord(value.provider) || !isRecord(value.provider.ref)) return false;
  return (
    value.kind === 'interactive' &&
    typeof value.maxBytes === 'number' &&
    Number.isFinite(value.maxBytes) &&
    typeof value.maxDurationMs === 'number' &&
    Number.isFinite(value.maxDurationMs) &&
    isRecord(value.signal) &&
    typeof value.signal.aborted === 'boolean' &&
    typeof value.signal.addEventListener === 'function' &&
    typeof value.signal.removeEventListener === 'function' &&
    typeof value.provider.helperVersion === 'string' &&
    typeof value.provider.ref.videoId === 'string' &&
    isYouTubeVideoId(value.provider.ref.videoId)
  );
}

function assertConsent(consent: YouTubeConsentGrant | undefined): void {
  if (
    consent?.consentId !== YOUTUBE_CONSENT_ID ||
    consent?.policyVersion !== YOUTUBE_POLICY_VERSION
  ) {
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
  if (error instanceof PathMediaLeaseError) {
    return new YouTubeAcquisitionError(
      error.code === 'resource_limit' ? 'resource_limit' : 'integrity_failed',
      'The acquired YouTube media failed validation.',
    );
  }
  return new YouTubeAcquisitionError(
    'tool_failed',
    'The YouTube helper could not complete the acquisition.',
  );
}

export function classifyYouTubeHelperFailure(stderr: string): YouTubeFailureCode {
  const text = stderr.toLowerCase();
  if (text.includes('429') || text.includes('rate limit')) return 'rate_limited';
  if (text.includes('region') || text.includes('geo')) return 'region_restricted';
  if (text.includes('private') || text.includes('not found') || text.includes('unavailable'))
    return 'not_found_or_private';
  if (text.includes('age restricted') || text.includes('confirm your age')) return 'age_restricted';
  if (text.includes('member')) return 'membership_required';
  if (text.includes('purchase') || text.includes('rent')) return 'purchase_required';
  if (text.includes('drm')) return 'drm_protected';
  if (text.includes('login') || text.includes('sign in') || text.includes('cookie'))
    return 'authentication_required';
  if (
    text.includes('http error') ||
    text.includes('timed out') ||
    text.includes('connection') ||
    text.includes('network') ||
    text.includes('unable to download webpage')
  )
    return 'network_failed';
  if (text.includes('extract') || text.includes('unsupported url')) return 'extractor_changed';
  return 'tool_failed';
}

function mapHelperFailure(stderr: string): YouTubeAcquisitionError {
  const code = classifyYouTubeHelperFailure(stderr);
  return new YouTubeAcquisitionError(code, 'The yt-dlp helper could not complete the acquisition.');
}

interface HelperExecution {
  readonly cancelled: boolean;
  readonly cleanupFailed: boolean;
  readonly events: AcquisitionEvent<YouTubeMediaLease>[];
  readonly exitCode: number | null;
  readonly metadata: YouTubeHelperMetadata;
  readonly outputLimitExceeded: boolean;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function runHelper(options: {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly maxOutputBytes: number;
  readonly platform: NodeJS.Platform;
  readonly signal: AbortSignal;
  readonly spawnProcess: typeof spawn;
  readonly wallTimeMs: number;
}): Promise<HelperExecution> {
  const events: AcquisitionEvent<YouTubeMediaLease>[] = [];
  let lastProgressBytes: number | undefined;
  const result = await runManagedProcess(
    options.command,
    options.args,
    {
      cwd: options.cwd,
      env: options.env,
      platform: options.platform,
      shell: false,
      spawnProcess: options.spawnProcess,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
    {
      maxOutputBytes: options.maxOutputBytes,
      onStdout: (stdout) => {
        const progress = parseYouTubeProgress(stdout);
        if (progress !== null && progress.bytes !== lastProgressBytes && events.length < 256) {
          lastProgressBytes = progress.bytes;
          events.push({ ...progress, type: 'progress' });
        }
      },
      signal: options.signal,
      stderrLimitBytes: YOUTUBE_MAX_STDERR_BYTES,
      timeoutMs: options.wallTimeMs,
    },
  );
  return {
    cancelled: result.cancelled,
    cleanupFailed: result.cleanupFailed,
    events,
    exitCode: result.exitCode,
    metadata: parseYouTubeHelperMetadata(result.stdout),
    outputLimitExceeded: result.outputLimitExceeded,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
}

export function parseYouTubeProgress(
  output: string,
): { bytes?: number; phase: string; totalBytes?: number } | null {
  const match = /(?:\[download\]\s+)?(\d+(?:\.\d+)?)(?:MiB|KiB|GiB|B|KB|MB|GB)/iu.exec(output);
  if (match === null) return null;
  const bytes = parseProgressBytes(match[0]);
  if (bytes === undefined) return null;
  return { bytes, phase: 'download' };
}

function parseProgressBytes(value: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(MiB|KiB|GiB|B|KB|MB|GB)$/iu.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === 'b'
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

function sanitizePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return parseYouTubeVideoUrl(value).canonicalUrl;
  } catch {
    return undefined;
  }
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
