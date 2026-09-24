import { randomUUID } from 'node:crypto';

import {
  AudioFileError,
  assertEncodedFileSize,
  createAudioFileCancellationError,
} from '../audio/audio-file-decoder';
import type {
  AcquireRequest,
  AcquisitionEvent,
  LocalMediaLease,
  MediaPlan,
  MediaProvenance,
  MediaReadStream,
  MediaSource,
  SourceRef,
} from './media-source';

export interface LocalMediaSourceDependencies {
  readonly pickFile: (signal: AbortSignal) => Promise<File | null>;
}

const LOCAL_MEDIA_ADAPTER_VERSION = '1';

export class LocalMediaSource implements MediaSource {
  readonly adapterVersion = LOCAL_MEDIA_ADAPTER_VERSION;
  readonly id = 'local_file' as const;

  constructor(private readonly dependencies: LocalMediaSourceDependencies) {}

  async inspect(ref: SourceRef, signal: AbortSignal): Promise<MediaPlan> {
    throwIfCancelled(signal);
    if (ref.kind !== 'local_file') {
      throw new AudioFileError('read_failed', 'The selected media source is not a local file.');
    }
    return this.createPlan();
  }

  async *acquire(request: AcquireRequest): AsyncIterable<AcquisitionEvent> {
    throwIfCancelled(request.signal);
    if (request.ref.kind !== 'local_file') {
      throw new AudioFileError('read_failed', 'The selected media source is not a local file.');
    }

    const file = await this.dependencies.pickFile(request.signal);
    throwIfCancelled(request.signal);
    if (file === null) {
      return;
    }
    assertEncodedFileSize(file.size);
    if (file.size > request.maxBytes) {
      throw new AudioFileError(
        'encoded_size',
        `The encoded audio file exceeds the ${request.maxBytes}-byte safety limit.`,
      );
    }

    const sourceRef: SourceRef = { fileToken: randomUUID(), kind: 'local_file' };
    const plan = this.createPlan(file.size);
    yield { plan, type: 'plan' };
    yield { bytes: 0, phase: 'read', totalBytes: file.size, type: 'progress' };

    const lease = createLocalMediaLease({
      acquiredAt: new Date().toISOString(),
      adapterVersion: this.adapterVersion,
      encodedBytes: file.size,
      file,
      sourceId: this.id,
      sourceRef,
    });
    yield { lease, type: 'ready' };
  }

  /**
   * Picker UX is local-adapter-specific. Keeping it beside acquisition prevents
   * the future remote adapter from growing a file-input or browser-only API.
   */
  async *acquirePicked(signal: AbortSignal): AsyncIterable<AcquisitionEvent> {
    throwIfCancelled(signal);
    const file = await this.dependencies.pickFile(signal);
    if (file === null) {
      return;
    }
    throwIfCancelled(signal);
    assertEncodedFileSize(file.size);
    const sourceRef: SourceRef = { fileToken: randomUUID(), kind: 'local_file' };
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
        sourceRef,
      }),
      type: 'ready',
    };
  }

  private createPlan(estimatedBytes?: number): MediaPlan {
    return {
      access: 'local',
      displayName: 'Local audio file',
      ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
      requiresConsent: false,
      restrictions: [],
      sourceId: this.id,
      warnings: [],
    };
  }
}

function createLocalMediaLease(args: {
  acquiredAt: string;
  adapterVersion: string;
  encodedBytes: number;
  file: File;
  sourceId: LocalMediaSource['id'];
  sourceRef: SourceRef;
}): LocalMediaLease {
  let released = false;
  const openReaders = new Set<{ cancel: (reason?: unknown) => Promise<void> }>();
  const provenance: MediaProvenance = {
    acquiredAt: args.acquiredAt,
    access: 'local',
    adapterVersion: args.adapterVersion,
    rights: { kind: 'user_supplied_file' },
    sourceId: args.sourceId,
    sourceRef: args.sourceRef,
    temporaryMedia: true,
  };

  return {
    encodedBytes: args.encodedBytes,
    mediaId: randomUUID(),
    provenance,
    async openReadStream(): Promise<MediaReadStream> {
      if (released) {
        throw new AudioFileError('read_failed', 'The local media lease has been released.');
      }
      const stream = openFileReadStream(args.file);
      const reader = stream.getReader();
      openReaders.add(reader);
      return {
        getReader: () => ({
          cancel: async (reason?: unknown) => {
            openReaders.delete(reader);
            await reader.cancel(reason);
          },
          read: async () => {
            if (released) {
              openReaders.delete(reader);
              return { done: true, value: undefined };
            }
            const result = await reader.read();
            if (result.done) {
              openReaders.delete(reader);
            }
            return result;
          },
        }),
      } as unknown as MediaReadStream;
    },
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      const readers = [...openReaders];
      openReaders.clear();
      await Promise.allSettled(readers.map((reader) => reader.cancel()));
    },
  };
}

function openFileReadStream(file: File): MediaReadStream {
  if (typeof file.stream === 'function') {
    return file.stream();
  }
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      void file.arrayBuffer().then(
        (buffer) => {
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
        },
        (error: unknown) => controller.error(error),
      );
    },
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof AudioFileError
      ? signal.reason
      : createAudioFileCancellationError();
  }
}
