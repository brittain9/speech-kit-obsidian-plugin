import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rm } from 'node:fs/promises';
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
  readonly mediaPath: string;
  readonly provenance: MediaProvenance;
}

export async function createPathBackedMediaLease(
  options: PathBackedMediaLeaseOptions,
): Promise<MediaLease> {
  const jobRoot = resolve(options.jobRoot);
  const mediaPath = resolve(options.mediaPath);
  await assertSafeMediaFile(jobRoot, mediaPath, options.maxBytes);
  const encodedBytes = await getSafeFileSize(mediaPath, options.maxBytes);
  if (options.encodedBytes !== encodedBytes) {
    throw new PathMediaLeaseError('read_failed', 'The acquired media size changed unexpectedly.');
  }

  let released = false;
  let releasePromise: Promise<void> | null = null;
  const activeReaders = new Set<() => Promise<void>>();

  const release = (): Promise<void> => {
    if (releasePromise !== null) return releasePromise;
    releasePromise = (async () => {
      released = true;
      await Promise.allSettled([...activeReaders].map((close) => close()));
      await rm(jobRoot, { force: true, recursive: true });
    })();
    return releasePromise;
  };

  return {
    dispose: release,
    encodedBytes,
    mediaId: randomUUID(),
    openReadStream: async (): Promise<MediaReadStream> => {
      if (released) throw new PathMediaLeaseError('released', 'The media lease has been released.');
      const handle = await open(mediaPath, fsConstants.O_RDONLY | safeNoFollowFlag());
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > options.maxBytes) {
        await handle.close();
        throw new PathMediaLeaseError(
          'resource_limit',
          'The acquired media exceeds its safety limit.',
        );
      }
      const sourceReader = Readable.toWeb(
        handle.createReadStream({
          autoClose: false,
          highWaterMark: 64 * 1024,
        }),
      ).getReader() as ReadableStreamDefaultReader<Uint8Array>;
      let streamClosed = false;
      const closeHandle = async (): Promise<void> => {
        if (streamClosed) return;
        streamClosed = true;
        await sourceReader.cancel().catch(() => {});
        await handle.close().catch(() => {});
      };
      activeReaders.add(closeHandle);
      if (released) {
        await closeHandle();
        throw new PathMediaLeaseError('released', 'The media lease has been released.');
      }

      const stream = new ReadableStream<Uint8Array>({
        start: () => {},
        pull: async (controller) => {
          if (released) return;
          try {
            const result = await sourceReader.read();
            if (released) return;
            if (result.done) {
              controller.close();
              await closeHandle();
              return;
            }
            controller.enqueue(Uint8Array.from(result.value));
          } catch (error) {
            if (!released) controller.error(error);
            await closeHandle();
          }
        },
        cancel: async () => {
          await closeHandle();
        },
      });
      return stream;
    },
    provenance: options.provenance,
    release,
  };
}

export async function assertSafeMediaFile(
  jobRoot: string,
  mediaPath: string,
  maxBytes: number,
): Promise<void> {
  if (!isAbsolute(jobRoot) || !isAbsolute(mediaPath)) {
    throw new PathMediaLeaseError('read_failed', 'The media path is not absolute.');
  }
  const rootStat = await safeLstat(jobRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PathMediaLeaseError('read_failed', 'The media job root is not a private directory.');
  }
  const rootReal = await realpath(jobRoot);
  const pathStat = await safeLstat(mediaPath);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new PathMediaLeaseError('read_failed', 'The acquired media is not a regular file.');
  }
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
  if (pathStat.size > maxBytes) {
    throw new PathMediaLeaseError('resource_limit', 'The acquired media exceeds its safety limit.');
  }
}

export async function removeMediaJob(jobRoot: string): Promise<void> {
  await rm(resolve(jobRoot), { force: true, recursive: true });
}

async function getSafeFileSize(path: string, maxBytes: number): Promise<number> {
  const stat = await safeLstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PathMediaLeaseError('read_failed', 'The acquired media is not a regular file.');
  }
  if (stat.size > maxBytes) {
    throw new PathMediaLeaseError('resource_limit', 'The acquired media exceeds its safety limit.');
  }
  return stat.size;
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
