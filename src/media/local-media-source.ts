import { randomUUID } from 'node:crypto';

import {
  AudioFileError,
  assertEncodedFileSize,
  createAudioFileCancellationError,
} from '../audio/audio-file-decoder';
import type {
  AcquisitionEvent,
  LocalMediaLease,
  MediaAcquireRequest,
  MediaPlan,
  MediaProvenance,
  MediaReadStream,
  MediaSource,
} from './media-source';

export interface LocalMediaSourceDependencies {
  readonly pickFile: (signal: AbortSignal) => Promise<File | null>;
}

const LOCAL_MEDIA_ADAPTER_VERSION = '1';

export class LocalMediaSource implements MediaSource {
  readonly adapterVersion = LOCAL_MEDIA_ADAPTER_VERSION;
  readonly id = 'local_file' as const;

  constructor(private readonly dependencies: LocalMediaSourceDependencies) {}

  async *acquire(request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent> {
    throwIfCancelled(request.signal);
    const file = await this.dependencies.pickFile(request.signal);
    throwIfCancelled(request.signal);
    if (file === null) return;

    assertEncodedFileSize(file.size);
    if (file.size > request.maxBytes) {
      throw new AudioFileError(
        'encoded_size',
        `The encoded audio file exceeds the ${request.maxBytes}-byte safety limit.`,
      );
    }

    const plan = this.createPlan(file.size);
    yield { plan, type: 'plan' };
    yield { bytes: 0, phase: 'read', totalBytes: file.size, type: 'progress' };
    yield {
      lease: createLocalMediaLease({
        acquiredAt: new Date().toISOString(),
        adapterVersion: this.adapterVersion,
        encodedBytes: file.size,
        file,
        sourceId: this.id,
      }),
      type: 'ready',
    };
  }

  private createPlan(estimatedBytes: number): MediaPlan {
    return {
      displayName: 'Local audio file',
      estimatedBytes,
      sourceId: this.id,
    };
  }
}

function createLocalMediaLease(args: {
  acquiredAt: string;
  adapterVersion: string;
  encodedBytes: number;
  file: File;
  sourceId: LocalMediaSource['id'];
}): LocalMediaLease {
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const activeStreams = new Set<TrackedMediaStream>();
  const provenance: MediaProvenance = {
    acquiredAt: args.acquiredAt,
    adapterVersion: args.adapterVersion,
    rights: { kind: 'user_supplied_file' },
    sourceId: args.sourceId,
    temporaryMedia: true,
  };

  const release = (): Promise<void> => {
    if (releasePromise !== null) return releasePromise;
    releasePromise = (async () => {
      released = true;
      const streams = [...activeStreams];
      activeStreams.clear();
      await Promise.allSettled(streams.map((stream) => stream.cancel(releaseCancellationError())));
    })();
    return releasePromise;
  };

  return {
    encodedBytes: args.encodedBytes,
    mediaId: randomUUID(),
    provenance,
    async openReadStream(): Promise<MediaReadStream> {
      if (released) {
        throw new AudioFileError('read_failed', 'The local media lease has been released.');
      }
      const tracked = openTrackedFileStream(args.file, () => activeStreams.delete(tracked));
      activeStreams.add(tracked);
      if (released) {
        activeStreams.delete(tracked);
        await tracked.cancel(releaseCancellationError());
        throw new AudioFileError('read_failed', 'The local media lease has been released.');
      }
      return tracked.stream;
    },
    release,
    dispose: release,
  };
}

interface TrackedMediaStream {
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly stream: MediaReadStream;
}

/**
 * A single-reader, pull-driven view over File.stream(). No read is started until
 * the consumer asks for data, so a slow decoder cannot accumulate an encoded
 * copy in the adapter queue.
 */
function openTrackedFileStream(file: File, onClose: () => void): TrackedMediaStream {
  if (typeof file.stream !== 'function') {
    throw new AudioFileError('read_failed', 'The local file does not expose a readable stream.');
  }

  const sourceReader = file.stream().getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let sourceCancelled = false;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const cancel = async (reason?: unknown): Promise<void> => {
    if (sourceCancelled) return;
    sourceCancelled = true;
    close();
    try {
      controller?.error(reason instanceof Error ? reason : releaseCancellationError());
    } catch {
      // The stream may already be closed by its consumer.
    }
    await sourceReader.cancel(reason).catch(() => {});
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      controller = streamController;
    },
    pull: async (pullController) => {
      if (sourceCancelled) return;
      if (pullController.desiredSize !== null && pullController.desiredSize <= 0) return;
      try {
        const result = await sourceReader.read();
        if (sourceCancelled) return;
        if (result.done) {
          pullController.close();
          close();
          return;
        }
        pullController.enqueue(result.value);
      } catch (error) {
        if (sourceCancelled) return;
        pullController.error(error);
        close();
      }
    },
    cancel,
  });
  return { cancel, stream };
}

function releaseCancellationError(): Error {
  return new AudioFileError('read_failed', 'The local media lease has been released.');
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof AudioFileError
      ? signal.reason
      : createAudioFileCancellationError();
  }
}
