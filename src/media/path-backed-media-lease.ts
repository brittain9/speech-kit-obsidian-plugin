import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, open, realpath, rm } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import type { MediaLease, MediaProvenance, MediaReadStream } from './media-source';

export class PathMediaLeaseError extends Error {
  constructor(
    readonly code: 'resource_limit' | 'read_failed' | 'released',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PathMediaLeaseError';
  }
}

export interface PathBackedMediaLeaseOptions {
  readonly encodedBytes: number;
  readonly jobRoot: string;
  readonly maxBytes: number;
  readonly mediaHandle?: FileHandle;
  readonly mediaPath: string;
  readonly provenance: MediaProvenance;
}

export interface ValidatedMediaFile {
  readonly handle: FileHandle;
  readonly path: string;
  readonly size: number;
}

export async function createPathBackedMediaLease(
  options: PathBackedMediaLeaseOptions,
): Promise<MediaLease> {
  const jobRoot = resolve(options.jobRoot);
  const mediaPath = resolve(options.mediaPath);
  const validated =
    options.mediaHandle === undefined
      ? await openValidatedMediaFile(jobRoot, mediaPath, options.maxBytes)
      : { handle: options.mediaHandle, path: mediaPath, size: options.encodedBytes };
  if (options.encodedBytes !== validated.size) {
    await validated.handle.close().catch(() => {});
    throw new PathMediaLeaseError('read_failed', 'The acquired media size changed unexpectedly.');
  }

  let released = false;
  let handleClosed = false;
  let streamOpened = false;
  let releasePromise: Promise<void> | null = null;
  const activeReaders = new Set<() => Promise<void>>();

  const closeHandle = async (): Promise<void> => {
    if (handleClosed) return;
    handleClosed = true;
    await validated.handle.close().catch(() => {});
  };
  const release = (): Promise<void> => {
    if (releasePromise !== null) return releasePromise;
    releasePromise = (async () => {
      released = true;
      await Promise.allSettled([...activeReaders].map((close) => close()));
      await closeHandle();
      await rm(jobRoot, { force: true, recursive: true });
    })();
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
      let streamClosed = false;
      const closeReader = async (): Promise<void> => {
        if (streamClosed) return;
        streamClosed = true;
        activeReaders.delete(closeReader);
        await sourceReader.cancel().catch(() => {});
        await closeHandle();
      };
      activeReaders.add(closeReader);
      if (released) {
        await closeReader();
        throw new PathMediaLeaseError('released', 'The media lease has been released.');
      }

      return new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          if (released) return;
          try {
            const result = await sourceReader.read();
            if (released) return;
            if (result.done) {
              controller.close();
              await closeReader();
              return;
            }
            controller.enqueue(Uint8Array.from(result.value));
          } catch (error) {
            if (!released) controller.error(error);
            await closeReader();
          }
        },
        cancel: async () => {
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
  if (!isAbsolute(jobRoot) || !isAbsolute(mediaPath)) {
    throw new PathMediaLeaseError('read_failed', 'The media path is not absolute.');
  }
  const rootStat = await safeLstat(jobRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PathMediaLeaseError('read_failed', 'The media job root is not a private directory.');
  }
  const rootReal = await realpath(jobRoot);
  const pathStat = await safeLstat(mediaPath);
  assertRegularMediaStat(pathStat, maxBytes);
  const mediaReal = await assertPathContained(rootReal, mediaPath);

  let handle: FileHandle | null = null;
  try {
    handle = await open(mediaPath, fsConstants.O_RDONLY | safeNoFollowFlag());
    const descriptorStat = await handle.stat();
    assertRegularMediaStat(descriptorStat, maxBytes);
    if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
      throw new PathMediaLeaseError('read_failed', 'The acquired media changed during validation.');
    }
    const afterPathStat = await safeLstat(mediaPath);
    assertRegularMediaStat(afterPathStat, maxBytes);
    if (afterPathStat.dev !== descriptorStat.dev || afterPathStat.ino !== descriptorStat.ino) {
      throw new PathMediaLeaseError('read_failed', 'The acquired media changed during validation.');
    }
    const afterReal = await assertPathContained(rootReal, mediaPath);
    if (afterReal !== mediaReal) {
      throw new PathMediaLeaseError('read_failed', 'The acquired media changed during validation.');
    }
    await handle.chmod(0o600);
    return { handle, path: mediaPath, size: descriptorStat.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof PathMediaLeaseError) throw error;
    throw new PathMediaLeaseError('read_failed', 'The acquired media could not be validated.', {
      cause: error,
    });
  }
}

export async function assertSafeMediaFile(
  jobRoot: string,
  mediaPath: string,
  maxBytes: number,
): Promise<void> {
  const validated = await openValidatedMediaFile(jobRoot, mediaPath, maxBytes);
  await validated.handle.close();
}

export async function removeMediaJob(jobRoot: string): Promise<void> {
  await rm(resolve(jobRoot), { force: true, recursive: true });
}

function assertRegularMediaStat(
  stat: { isFile(): boolean; isSymbolicLink(): boolean; nlink: number; size: number },
  maxBytes: number,
): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new PathMediaLeaseError(
      'read_failed',
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
    throw new PathMediaLeaseError('read_failed', 'The acquired media escaped its job root.');
  }
  return mediaReal;
}

async function safeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    throw new PathMediaLeaseError('read_failed', 'The acquired media could not be inspected.', {
      cause: error,
    });
  }
}

function safeNoFollowFlag(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

export function isFixedYouTubeMediaName(name: string): boolean {
  return basename(name).startsWith('source.') && !name.includes('/') && !name.includes('\\');
}
