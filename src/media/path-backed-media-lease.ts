import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, open, readFile, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import type { MediaLease, MediaProvenance, MediaReadStream } from './media-source';

declare const validatedMediaFileBrand: unique symbol;
declare const validatedRootBrand: unique symbol;
declare const jobRootCapabilityBrand: unique symbol;

const validatedMediaFiles = new WeakSet<object>();
const jobRootCapabilities = new WeakSet<object>();

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

export interface JobRootClaimOptions {
  readonly allowCorruptOwnerMarker?: boolean;
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
      await closeHandles();
      await removeValidatedRoot(validated.root);
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

export async function claimJobRoot(
  jobRoot: string,
  options: JobRootClaimOptions = {},
): Promise<JobRootCapability> {
  const root = await openValidatedRoot(resolve(jobRoot));
  try {
    if (options.allowCorruptOwnerMarker !== true) await assertOwnerMarker(root.path);
    const capability = { path: root.path, root } as JobRootCapability;
    jobRootCapabilities.add(capability);
    return capability;
  } catch (error) {
    await root.handle.close().catch(() => {});
    throw error;
  }
}

export async function removeMediaJob(capability: JobRootCapability): Promise<void> {
  if (!jobRootCapabilities.has(capability)) {
    throw new PathMediaLeaseError(
      'integrity_failed',
      'A validated job-root capability is required.',
    );
  }
  try {
    await removeValidatedRoot(capability.root);
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
      instanceId?: unknown;
      pid?: unknown;
      speechKitJob?: unknown;
    };
    if (
      marker.speechKitJob !== true ||
      typeof marker.instanceId !== 'string' ||
      marker.instanceId.length === 0 ||
      typeof marker.pid !== 'number' ||
      !Number.isInteger(marker.pid) ||
      marker.pid <= 0
    ) {
      throw new Error('invalid owner marker');
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

async function removeValidatedRoot(root: ValidatedRoot): Promise<void> {
  try {
    await assertCurrentRoot(root);
    await removeRootContentsFromHeldRoot(root);
    await assertCurrentRoot(root);
    await rmdir(root.path);
  } catch {
    // A missing or replaced root is intentionally left untouched.
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

async function removeRootContentsFromHeldRoot(root: ValidatedRoot): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const command =
    process.platform === 'win32' ? `${systemRoot}\\System32\\rmdir.exe` : '/usr/bin/find';
  const args =
    process.platform === 'win32'
      ? ['/s', '/q', root.path]
      : ['.', '-mindepth', '1', '-maxdepth', '1', '-exec', '/bin/rm', '-rf', '--', '{}', '+'];
  const cwd = root.path;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        PATH: '',
        SystemRoot: systemRoot,
      },
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('job cleanup command failed'));
    });
  });
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
