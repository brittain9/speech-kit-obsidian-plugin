import type { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, open, readFile, realpath, rename, rmdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import type { MediaLease, MediaProvenance, MediaReadStream } from './media-source';
import { runManagedProcess } from './process-runner';

declare const validatedMediaFileBrand: unique symbol;
declare const validatedRootBrand: unique symbol;
declare const jobRootCapabilityBrand: unique symbol;

const validatedMediaFiles = new WeakSet<object>();
const jobRootCapabilities = new WeakSet<object>();

const JOB_CLEANUP_TIMEOUT_MS = 5_000;
const OWNER_CLOCK_SKEW_MS = 5_000;

export interface JobCleanupOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly timeoutMs?: number;
}

export function supportsDescriptorRelativeCleanup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Linux exposes a parent's held directory descriptor through procfs. macOS
  // and Windows do not provide a portable Node descriptor-relative cwd.
  return platform === 'linux';
}

export class PathMediaLeaseError extends Error {
  constructor(
    readonly code: 'integrity_failed' | 'resource_limit' | 'read_failed' | 'released',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PathMediaLeaseError';
  }
}

export interface PathBackedMediaLeaseOptions {
  readonly cleanup?: JobCleanupOptions;
  readonly provenance: MediaProvenance;
  readonly validatedMediaFile: ValidatedMediaFile;
}

export interface ValidatedRoot {
  readonly [validatedRootBrand]: true;
  readonly dev: number;
  readonly handle: FileHandle;
  readonly ino: number;
  readonly path: string;
  readonly realPath: string;
}

export interface JobRootCapability {
  readonly [jobRootCapabilityBrand]: true;
  readonly path: string;
  readonly root: ValidatedRoot;
}

export interface ValidatedMediaFile {
  readonly [validatedMediaFileBrand]: true;
  readonly handle: FileHandle;
  readonly path: string;
  readonly root: ValidatedRoot;
  readonly size: number;
}

export async function createPathBackedMediaLease(
  options: PathBackedMediaLeaseOptions,
): Promise<MediaLease> {
  const validated = options.validatedMediaFile;
  if (!isValidatedMediaFile(validated)) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'The media lease requires a validator-created media descriptor.',
    );
  }

  let released = false;
  let handleClosed = false;
  let streamOpened = false;
  let releasePromise: Promise<void> | null = null;
  const activeReaders = new Set<() => Promise<void>>();

  const closeHandles = async (): Promise<void> => {
    if (handleClosed) return;
    handleClosed = true;
    await validated.handle.close().catch(() => {});
    await validated.root.handle.close().catch(() => {});
  };
  const release = (): Promise<void> => {
    if (releasePromise !== null) return releasePromise;
    releasePromise = (async () => {
      released = true;
      await Promise.allSettled([...activeReaders].map((close) => close()));
      try {
        await removeValidatedRoot(validated.root, options.cleanup);
      } finally {
        await closeHandles();
      }
    })().catch(() => {
      // Media cleanup is best effort. The lease must still settle so the
      // owning transcription session cannot remain wedged.
    });
    return releasePromise;
  };

  return {
    encodedBytes: validated.size,
    mediaId: randomUUID(),
    openReadStream: async (): Promise<MediaReadStream> => {
      if (released) throw new PathMediaLeaseError('released', 'The media lease has been released.');
      if (streamOpened) {
        throw new PathMediaLeaseError(
          'read_failed',
          'The media lease already has an active reader.',
        );
      }
      streamOpened = true;
      const sourceReader = Readable.toWeb(
        validated.handle.createReadStream({
          autoClose: false,
          highWaterMark: 64 * 1024,
        }),
      ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      let outerController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let outerClosed = false;
      let streamClosed = false;
      const closeOuter = (error?: unknown): void => {
        if (outerClosed || outerController === null) return;
        outerClosed = true;
        if (error === undefined) outerController.close();
        else outerController.error(error);
      };
      const closeReader = async (): Promise<void> => {
        if (streamClosed) return;
        streamClosed = true;
        activeReaders.delete(closeReader);
        if (released) {
          closeOuter(new PathMediaLeaseError('released', 'The media lease has been released.'));
        }
        await sourceReader.cancel().catch(() => {});
        await closeHandles();
      };
      activeReaders.add(closeReader);
      if (released) {
        await closeReader();
        throw new PathMediaLeaseError('released', 'The media lease has been released.');
      }

      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          outerController = controller;
          if (released) {
            closeOuter(new PathMediaLeaseError('released', 'The media lease has been released.'));
            return;
          }
          try {
            const result = await sourceReader.read();
            if (released) {
              closeOuter(new PathMediaLeaseError('released', 'The media lease has been released.'));
              return;
            }
            if (result.done) {
              closeOuter();
              await closeReader();
              return;
            }
            controller.enqueue(Uint8Array.from(result.value));
          } catch (error) {
            if (!released) closeOuter(error);
            await closeReader();
          }
        },
        cancel: async () => {
          outerClosed = true;
          await closeReader();
        },
      });
    },
    provenance: options.provenance,
    release,
  };
}

export async function openValidatedMediaFile(
  jobRoot: string,
  mediaPath: string,
  maxBytes: number,
): Promise<ValidatedMediaFile> {
  const root = await openValidatedRoot(jobRoot);
  let mediaHandle: FileHandle | null = null;
  try {
    if (!isAbsolute(mediaPath)) {
      throw new PathMediaLeaseError('integrity_failed', 'The media path is not absolute.');
    }
    const rootStat = await safeLstat(root.path);
    assertDirectoryIdentity(rootStat, root);
    const rootReal = await realpath(root.path);
    if (rootReal !== root.realPath) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The media job root changed during validation.',
      );
    }
    const pathStat = await safeLstat(mediaPath);
    assertRegularMediaStat(pathStat, maxBytes);
    const mediaReal = await assertPathContained(root.realPath, mediaPath);

    mediaHandle = await open(mediaPath, fsConstants.O_RDONLY | safeNoFollowFlag());
    const descriptorStat = await mediaHandle.stat();
    assertRegularMediaStat(descriptorStat, maxBytes);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The acquired media changed during validation.',
      );
    }
    const afterPathStat = await safeLstat(mediaPath);
    assertRegularMediaStat(afterPathStat, maxBytes);
    if (afterPathStat.dev !== descriptorStat.dev || afterPathStat.ino !== descriptorStat.ino) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The acquired media changed during validation.',
      );
    }
    const afterReal = await assertPathContained(root.realPath, mediaPath);
    if (afterReal !== mediaReal) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The acquired media changed during validation.',
      );
    }
    await mediaHandle.chmod(0o600);
    const validated: ValidatedMediaFile = {
      handle: mediaHandle,
      path: mediaPath,
      root,
      size: descriptorStat.size,
    } as ValidatedMediaFile;
    validatedMediaFiles.add(validated);
    return validated;
  } catch (error) {
    await mediaHandle?.close().catch(() => {});
    await root.handle.close().catch(() => {});
    if (error instanceof PathMediaLeaseError) throw error;
    throw new PathMediaLeaseError(
      'integrity_failed',
      'The acquired media could not be validated.',
      {
        cause: error,
      },
    );
  }
}

export async function claimJobRoot(jobRoot: string): Promise<JobRootCapability> {
  const root = await openValidatedRoot(resolve(jobRoot));
  try {
    await assertOwnerMarker(root.path);
    const capability = { path: root.path, root } as JobRootCapability;
    jobRootCapabilities.add(capability);
    return capability;
  } catch (error) {
    await root.handle.close().catch(() => {});
    throw error;
  }
}

export async function removeMediaJob(
  capability: JobRootCapability,
  cleanup: JobCleanupOptions = {},
): Promise<void> {
  if (!jobRootCapabilities.has(capability)) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'A validated job-root capability is required.',
    );
  }
  try {
    await removeValidatedRoot(capability.root, cleanup);
  } finally {
    await capability.root.handle.close().catch(() => {});
  }
}

function isValidatedMediaFile(value: unknown): value is ValidatedMediaFile {
  return typeof value === 'object' && value !== null && validatedMediaFiles.has(value);
}

async function assertOwnerMarker(jobRoot: string): Promise<void> {
  try {
    const marker = JSON.parse(await readFile(join(jobRoot, 'owner.json'), 'utf8')) as {
      createdAt?: unknown;
      heartbeatAt?: unknown;
      instanceId?: unknown;
      pid?: unknown;
      processStartedAt?: unknown;
      speechKitJob?: unknown;
    };
    const now = Date.now();
    const validTimestamp = (value: unknown): value is number =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= now + OWNER_CLOCK_SKEW_MS;
    const pid = marker.pid;
    if (
      marker.speechKitJob !== true ||
      !validTimestamp(marker.createdAt) ||
      !validTimestamp(marker.heartbeatAt) ||
      !validTimestamp(marker.processStartedAt) ||
      typeof marker.instanceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        marker.instanceId,
      ) ||
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      marker.createdAt < marker.processStartedAt - OWNER_CLOCK_SKEW_MS ||
      marker.heartbeatAt < marker.createdAt - OWNER_CLOCK_SKEW_MS
    ) {
      throw new Error('invalid owner marker');
    }
    if (pid === process.pid) {
      const currentProcessStartedAt = Date.now() - process.uptime() * 1_000;
      if (Math.abs(currentProcessStartedAt - marker.processStartedAt) > OWNER_CLOCK_SKEW_MS) {
        throw new Error('owner process identity does not match');
      }
    }
  } catch (error) {
    throw new PathMediaLeaseError('integrity_failed', 'The job-root owner marker is invalid.', {
      cause: error,
    });
  }
}

async function openValidatedRoot(jobRoot: string): Promise<ValidatedRoot> {
  if (!isAbsolute(jobRoot)) {
    throw new PathMediaLeaseError('integrity_failed', 'The media job root is not absolute.');
  }
  const rootStat = await safeLstat(jobRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'The media job root is not a private directory.',
    );
  }
  const rootReal = await realpath(jobRoot);
  let handle: FileHandle | null = null;
  try {
    handle = await open(jobRoot, fsConstants.O_RDONLY | safeDirectoryFlag());
    const descriptorStat = await handle.stat();
    if (
      !descriptorStat.isDirectory() ||
      descriptorStat.dev !== rootStat.dev ||
      descriptorStat.ino !== rootStat.ino
    ) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The media job root changed during validation.',
      );
    }
    return {
      dev: descriptorStat.dev,
      handle,
      ino: descriptorStat.ino,
      path: jobRoot,
      realPath: rootReal,
    } as ValidatedRoot;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof PathMediaLeaseError) throw error;
    throw new PathMediaLeaseError(
      'integrity_failed',
      'The media job root could not be validated.',
      {
        cause: error,
      },
    );
  }
}

async function removeValidatedRoot(
  root: ValidatedRoot,
  cleanup: JobCleanupOptions = {},
): Promise<void> {
  try {
    await assertCurrentRoot(root);
    const platform = cleanup.platform ?? process.platform;
    if (supportsDescriptorRelativeCleanup(platform)) {
      await removeRootContentsFromHeldRoot(root, cleanup, platform);
      await assertCurrentRoot(root);
      await rmdir(root.path);
      return;
    }
    await removeViaPrivateTombstone(root, cleanup, platform);
  } catch {
    // A missing, replaced, or failed-cleanup root is intentionally quarantined.
  }
}

async function assertCurrentRoot(root: ValidatedRoot): Promise<void> {
  const current = await safeLstat(root.path);
  assertDirectoryIdentity(current, root);
  const currentReal = await realpath(root.path);
  if (currentReal !== root.realPath) {
    throw new PathMediaLeaseError('integrity_failed', 'The media job root was replaced.');
  }
}

async function removeRootContentsFromHeldRoot(
  root: ValidatedRoot,
  cleanup: JobCleanupOptions,
  platform: NodeJS.Platform,
): Promise<void> {
  await runCleanupProcess(
    '/usr/bin/find',
    ['.', '-mindepth', '1', '-maxdepth', '1', '-exec', '/bin/rm', '-rf', '--', '{}', '+'],
    cleanup,
    platform,
    `/proc/${process.pid}/fd/${root.handle.fd}`,
  );
}

async function removeViaPrivateTombstone(
  root: ValidatedRoot,
  cleanup: JobCleanupOptions,
  platform: NodeJS.Platform,
): Promise<void> {
  const tombstonePath = join(
    dirname(root.path),
    `.speech-kit-quarantine-${basename(root.path)}-${randomUUID()}`,
  );
  await assertCurrentRoot(root);
  await rename(root.path, tombstonePath);

  let tombstoneRoot: ValidatedRoot | null = null;
  try {
    tombstoneRoot = await openValidatedRoot(tombstonePath);
    if (tombstoneRoot.dev !== root.dev || tombstoneRoot.ino !== root.ino) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The quarantined job root no longer matches the held descriptor.',
      );
    }
    await assertCurrentRoot(tombstoneRoot);
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const command = platform === 'win32' ? `${systemRoot}\\System32\\rmdir.exe` : '/bin/rm';
    const args = platform === 'win32' ? ['/s', '/q', tombstonePath] : ['-rf', '--', tombstonePath];
    await runCleanupProcess(command, args, cleanup, platform);
    await assertCurrentRoot(tombstoneRoot);
    await rmdir(tombstonePath);
  } finally {
    await tombstoneRoot?.handle.close().catch(() => {});
  }
}

async function runCleanupProcess(
  command: string,
  args: readonly string[],
  cleanup: JobCleanupOptions,
  platform: NodeJS.Platform,
  cwd?: string,
): Promise<void> {
  const controller = new AbortController();
  const timeoutMs = Math.min(
    JOB_CLEANUP_TIMEOUT_MS,
    Math.max(1, cleanup.timeoutMs ?? JOB_CLEANUP_TIMEOUT_MS),
  );
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const spawnOptions = {
    ...(cwd === undefined ? {} : { cwd }),
    env: {
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '',
      ...(platform === 'win32' ? { SystemRoot: systemRoot } : {}),
    },
    platform,
    shell: false,
    stdio: 'ignore' as const,
    windowsHide: true,
    ...(cleanup.spawnProcess === undefined ? {} : { spawnProcess: cleanup.spawnProcess }),
  };
  try {
    const result = await runManagedProcess(command, args, spawnOptions, {
      maxOutputBytes: 1,
      signal: controller.signal,
      timeoutMs,
    });
    if (
      result.cancelled ||
      result.cleanupFailed ||
      result.failed ||
      result.outputLimitExceeded ||
      result.timedOut ||
      result.exitCode !== 0
    ) {
      throw new Error('job cleanup command failed');
    }
  } finally {
    window.clearTimeout(timer);
  }
}

function assertDirectoryIdentity(
  stat: { dev: number; ino: number; isDirectory(): boolean; isSymbolicLink(): boolean },
  root: ValidatedRoot,
): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== root.dev ||
    stat.ino !== root.ino
  ) {
    throw new PathMediaLeaseError('integrity_failed', 'The media job root was replaced.');
  }
}

function assertRegularMediaStat(
  stat: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number; size: number },
  maxBytes: number,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'The acquired media is not a private regular file.',
    );
  }
  if (stat.size > maxBytes) {
    throw new PathMediaLeaseError('resource_limit', 'The acquired media exceeds its safety limit.');
  }
}

async function assertPathContained(rootReal: string, mediaPath: string): Promise<string> {
  const mediaReal = await realpath(mediaPath);
  const relativePath = relative(rootReal, mediaReal);
  if (
    relativePath === '' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  ) {
    throw new PathMediaLeaseError('integrity_failed', 'The acquired media escaped its job root.');
  }
  return mediaReal;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'The acquired media could not be inspected.',
      {
        cause: error,
      },
    );
  }
}

function safeNoFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

function safeDirectoryFlag(): number {
  return typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
}
