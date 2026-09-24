import type { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, open, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
const OWNER_MARKER_MAX_BYTES = 16 * 1024;

export interface JobCleanupOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: typeof spawn;
  readonly timeoutMs?: number;
}

export function supportsDescriptorRelativeCleanup(
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Descriptor inheritance is attempted on every supported desktop runtime;
  // the child verifies identity before it can remove anything.
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
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

export interface OwnerMarkerFile {
  readonly handle: FileHandle;
}

export interface JobRootCapability {
  readonly [jobRootCapabilityBrand]: true;
  readonly owner: OwnerMarkerFile;
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
  let owner: OwnerMarkerFile | null = null;
  try {
    await assertCurrentRoot(root);
    owner = await openOwnerMarker(root);
    await assertCurrentRoot(root);
    await assertOwnerMarker(await readHeldFile(owner.handle));
    await assertCurrentRoot(root);
    const capability = { owner, path: root.path, root } as JobRootCapability;
    jobRootCapabilities.add(capability);
    return capability;
  } catch (error) {
    await owner?.handle.close().catch(() => {});
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
    await capability.owner.handle.close().catch(() => {});
    await removeValidatedRoot(capability.root, cleanup);
  } finally {
    await capability.root.handle.close().catch(() => {});
    jobRootCapabilities.delete(capability);
  }
}

function isValidatedMediaFile(value: unknown): value is ValidatedMediaFile {
  return typeof value === 'object' && value !== null && validatedMediaFiles.has(value);
}

async function openOwnerMarker(root: ValidatedRoot): Promise<OwnerMarkerFile> {
  const ownerPath = join(root.path, 'owner.json');
  const before = await safeLstat(ownerPath);
  assertOwnerFileStat(before);
  const handle = await open(ownerPath, fsConstants.O_RDWR | safeNoFollowFlag());
  try {
    const descriptor = await handle.stat();
    assertOwnerFileStat(descriptor);
    if (descriptor.dev !== before.dev || descriptor.ino !== before.ino) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The owner marker changed during validation.',
      );
    }
    await assertCurrentRoot(root);
    const after = await safeLstat(ownerPath);
    assertOwnerFileStat(after);
    if (after.dev !== descriptor.dev || after.ino !== descriptor.ino) {
      throw new PathMediaLeaseError(
        'integrity_failed',
        'The owner marker changed during validation.',
      );
    }
    return { handle };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readHeldFile(handle: FileHandle): Promise<string> {
  const size = (await handle.stat()).size;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(buffer, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset).toString('utf8');
}

async function assertOwnerMarker(serialized: string): Promise<void> {
  try {
    const marker = JSON.parse(serialized) as {
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

function assertOwnerFileStat(stat: {
  ino: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  nlink: number;
  size: number;
}): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > OWNER_MARKER_MAX_BYTES
  ) {
    throw new PathMediaLeaseError('integrity_failed', 'The owner marker is not a private file.');
  }
}

export async function readOwnerMarker(capability: JobRootCapability): Promise<unknown> {
  if (!jobRootCapabilities.has(capability)) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'A validated job-root capability is required.',
    );
  }
  return JSON.parse(await readHeldFile(capability.owner.handle)) as unknown;
}

export async function releaseJobRootCapability(capability: JobRootCapability): Promise<void> {
  if (!jobRootCapabilities.has(capability)) return;
  jobRootCapabilities.delete(capability);
  await capability.owner.handle.close().catch(() => {});
  await capability.root.handle.close().catch(() => {});
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
    if (!supportsDescriptorRelativeCleanup(platform)) return;
    await removeRootContentsFromHeldDescriptor(root, cleanup, platform);
    await assertCurrentRoot(root);
    await rmdir(root.path);
  } catch {
    // A missing, replaced, or failed-cleanup root is intentionally left untouched.
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

const DESCRIPTOR_CLEANUP_SCRIPT = `
const fs = require('node:fs');
const root = fs.fstatSync(3);
const cwd = fs.statSync('.');
if (!root.isDirectory() || root.dev !== cwd.dev || root.ino !== cwd.ino) process.exit(75);
for (const entry of fs.readdirSync('.')) fs.rmSync(entry, { recursive: true, force: true });
`;

async function removeRootContentsFromHeldDescriptor(
  root: ValidatedRoot,
  cleanup: JobCleanupOptions,
  platform: NodeJS.Platform,
): Promise<void> {
  const controller = new AbortController();
  const timeoutMs = Math.min(
    JOB_CLEANUP_TIMEOUT_MS,
    Math.max(1, cleanup.timeoutMs ?? JOB_CLEANUP_TIMEOUT_MS),
  );
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const stdio: ['ignore', 'ignore', 'ignore', number] = [
    'ignore',
    'ignore',
    'ignore',
    root.handle.fd,
  ];
  const spawnOptions = {
    cwd: '/dev/fd/3',
    env: {
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '',
      ...(platform === 'win32' ? { SystemRoot: systemRoot } : {}),
    },
    platform,
    shell: false,
    stdio,
    windowsHide: true,
    ...(cleanup.spawnProcess === undefined ? {} : { spawnProcess: cleanup.spawnProcess }),
  };
  try {
    const result = await runManagedProcess(
      process.execPath,
      ['-e', DESCRIPTOR_CLEANUP_SCRIPT],
      spawnOptions,
      {
        closeTimeoutMs: timeoutMs,
        maxOutputBytes: 1,
        signal: controller.signal,
        timeoutMs,
      },
    );
    if (
      result.cancelled ||
      result.cleanupFailed ||
      result.failed ||
      result.outputLimitExceeded ||
      result.timedOut ||
      result.exitCode !== 0
    ) {
      throw new Error('descriptor job cleanup failed');
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
