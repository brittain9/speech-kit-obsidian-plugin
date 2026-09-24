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
  MediaInspection,
  MediaInspectRequest,
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
  private readonly inspectedFiles = new Map<string, File>();

  constructor(private readonly dependencies: LocalMediaSourceDependencies) {}

  async inspect(request: MediaInspectRequest): Promise<MediaInspection | null> {
    throwIfCancelled(request.signal);
    if (request.kind === 'referenced') {
      if (request.ref.kind !== 'local_file' || !this.inspectedFiles.has(request.ref.fileToken)) {
        throw new AudioFileError(
          'read_failed',
          'The inspected local media token is no longer available.',
        );
      }
      const file = this.inspectedFiles.get(request.ref.fileToken);
      if (file === undefined) {
        throw new AudioFileError(
          'read_failed',
          'The inspected local media token is no longer available.',
        );
      }
      return { plan: this.createPlan(file.size), ref: request.ref };
    }

    const file = await this.selectInteractiveFile(request.signal);
    if (file === null) {
      return null;
    }
    const ref = this.bindInspectedFile(file);
    return { plan: this.createPlan(file.size), ref };
  }

  async *acquire(request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent> {
    throwIfCancelled(request.signal);
    const selected =
      request.kind === 'interactive_local'
        ? await this.selectInteractiveSelection(request.signal)
        : this.takeReferencedFile(request.ref);
    if (selected === null) {
      return;
    }
    throwIfCancelled(request.signal);
    assertEncodedFileSize(selected.file.size);
    if (selected.file.size > request.maxBytes) {
      throw new AudioFileError(
        'encoded_size',
        `The encoded audio file exceeds the ${request.maxBytes}-byte safety limit.`,
      );
    }

    const plan = this.createPlan(selected.file.size);
    yield { plan, type: 'plan' };
    yield { bytes: 0, phase: 'read', totalBytes: selected.file.size, type: 'progress' };
    yield {
      lease: createLocalMediaLease({
        acquiredAt: new Date().toISOString(),
        adapterVersion: this.adapterVersion,
        encodedBytes: selected.file.size,
        file: selected.file,
        sourceId: this.id,
        sourceRef: selected.ref,
      }),
      type: 'ready',
    };
  }

  private async selectInteractiveSelection(
    signal: AbortSignal,
  ): Promise<{ file: File; ref: SourceRef } | null> {
    const file = await this.selectInteractiveFile(signal);
    return file === null ? null : { file, ref: this.createFileRef() };
  }

  private async selectInteractiveFile(signal: AbortSignal): Promise<File | null> {
    const file = await this.dependencies.pickFile(signal);
    throwIfCancelled(signal);
    return file;
  }

  private bindInspectedFile(file: File): SourceRef {
    const ref = this.createFileRef();
    this.inspectedFiles.set(ref.fileToken, file);
    return ref;
  }

  private createFileRef(): Extract<SourceRef, { kind: 'local_file' }> {
    return { fileToken: randomUUID(), kind: 'local_file' };
  }

  private takeReferencedFile(ref: SourceRef): { file: File; ref: SourceRef } | null {
    if (ref.kind !== 'local_file') {
      throw new AudioFileError('read_failed', 'The selected media source is not a local file.');
    }
    const file = this.inspectedFiles.get(ref.fileToken);
    if (file === undefined) {
      throw new AudioFileError(
        'read_failed',
        'The inspected local media token is no longer available.',
      );
    }
    this.inspectedFiles.delete(ref.fileToken);
    return { file, ref };
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
  sourceRef: SourceRef;
}): LocalMediaLease {
  let released = false;
  let releasePromise: Promise<void> | null = null;
  const activeStreams = new Set<TrackedMediaStream>();
  const provenance: MediaProvenance = {
    acquiredAt: args.acquiredAt,
    adapterVersion: args.adapterVersion,
    rights: { kind: 'user_supplied_file' },
    sourceId: args.sourceId,
    sourceRef: args.sourceRef,
    temporaryMedia: true,
  };

  const release = (): Promise<void> => {
    if (releasePromise !== null) {
      return releasePromise;
    }
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
      const tracked = openTrackedFileStream(args.file, () => {
        activeStreams.delete(tracked);
      });
      activeStreams.add(tracked);
      if (released) {
        activeStreams.delete(tracked);
        await tracked.cancel(releaseCancellationError());
        throw new AudioFileError('read_failed', 'The local media lease has been released.');
      }
      return tracked.stream;
    },
    release,
  };
}

interface TrackedMediaStream {
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly stream: MediaReadStream;
}

function openTrackedFileStream(file: File, onClose: () => void): TrackedMediaStream {
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
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
    await sourceReader?.cancel(reason);
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      if (typeof file.stream === 'function') {
        sourceReader = file.stream().getReader();
        void pumpFileReader(sourceReader, controller, close, () => sourceCancelled);
        return;
      }
      void file.arrayBuffer().then(
        (buffer) => {
          if (sourceCancelled) return;
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
          close();
        },
        (error: unknown) => {
          if (sourceCancelled) return;
          controller.error(error);
          close();
        },
      );
    },
    cancel,
  });
  return { cancel, stream };
}

async function pumpFileReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  close: () => void,
  isCancelled: () => boolean,
): Promise<void> {
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        controller.close();
        close();
        return;
      }
      if (isCancelled()) return;
      controller.enqueue(result.value);
    }
  } catch (error) {
    if (isCancelled()) return;
    controller.error(error);
    close();
  }
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
