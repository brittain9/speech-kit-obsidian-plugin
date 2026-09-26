import {
  MEDIA_MAX_DECODED_BYTES,
  MEDIA_MAX_DURATION_MS,
  MEDIA_MAX_ENCODED_BYTES,
} from '../media/media-policy';
import type { MediaLease, MediaReadStream } from '../media/media-source';
import { PCM_BYTES_PER_FRAME } from '../shared/pcm-format';
import type { PluginLogger } from '../shared/plugin-logger';
import { clearChannels, mixChannelsToMono, PcmFrameProcessor } from './pcm-frame-processor';

export const AUDIO_FILE_MAX_ENCODED_BYTES = MEDIA_MAX_ENCODED_BYTES;
export const AUDIO_FILE_MAX_DECODED_BYTES = MEDIA_MAX_DECODED_BYTES;
export const AUDIO_FILE_MAX_DURATION_MS = MEDIA_MAX_DURATION_MS;
const DECODE_CHANNEL_SLICE_SAMPLES = 16_384;

export type AudioFileErrorCode =
  | 'cancelled'
  | 'decoded_memory'
  | 'decode_failed'
  | 'duration'
  | 'encoded_size'
  | 'empty'
  | 'invalid_decode'
  | 'model_duration'
  | 'queue_overload'
  | 'read_failed'
  | 'sidecar_failed';

export class AudioFileError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly code: AudioFileErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AudioFileError';
    this.cause = options?.cause;
  }
}

export interface DecodedAudioFile {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  dispose(): void;
  getChannelData(channel: number): Float32Array;
}

interface WebAudioAudioFileDecoderOptions {
  readonly getAudioContext?: () => typeof AudioContext;
  readonly logger?: PluginLogger;
}

interface DecodedAudioBudgetOptions {
  readonly maxModelDurationMs: number | null;
}

interface PumpDecodedAudioFramesOptions {
  readonly signal: AbortSignal;
  readonly waitForBackpressure: (signal: AbortSignal) => Promise<void>;
  readonly writeFrame: (frame: Uint8Array, signal: AbortSignal) => Promise<void>;
}

export class WebAudioAudioFileDecoder {
  private readonly getAudioContext: () => typeof AudioContext;

  constructor(private readonly options: WebAudioAudioFileDecoderOptions = {}) {
    this.getAudioContext = options.getAudioContext ?? getWindowAudioContext;
  }

  async decode(file: File, signal = new AbortController().signal): Promise<DecodedAudioFile> {
    throwIfCancelled(signal);
    assertEncodedFileSize(file.size);

    const encodedBytes = await readEncodedAudioFile(file, signal);
    return await this.decodeEncodedBytes(encodedBytes, signal);
  }

  async decodeMedia(
    lease: MediaLease,
    signal = new AbortController().signal,
  ): Promise<DecodedAudioFile> {
    throwIfCancelled(signal);
    assertEncodedFileSize(lease.encodedBytes);
    const stream = await abortable(lease.openReadStream(), signal, () => cancellationError(signal));
    const encodedBytes = await readMediaStream(stream, lease.encodedBytes, signal);
    return await this.decodeEncodedBytes(encodedBytes, signal);
  }

  private async decodeEncodedBytes(
    encodedBytes: ArrayBuffer,
    signal: AbortSignal,
  ): Promise<DecodedAudioFile> {
    throwIfCancelled(signal);

    let audioContext: AudioContext;
    try {
      const AudioContextConstructor = this.getAudioContext();
      audioContext = new AudioContextConstructor();
    } catch (error) {
      throw new AudioFileError(
        'decode_failed',
        'The local audio decoder is unavailable in this Obsidian runtime.',
        { cause: error },
      );
    }

    let decodedAudio: DecodedAudioFile | null = null;
    let operationError: AudioFileError | null = null;
    try {
      const decodedBuffer = await abortable(
        audioContext.decodeAudioData(encodedBytes),
        signal,
        () => cancellationError(signal),
      );
      throwIfCancelled(signal);
      decodedAudio = createDecodedAudioBuffer(decodedBuffer);
    } catch (error) {
      operationError = normalizeAudioFileError(error, signal);
    }

    let closeError: unknown = null;
    try {
      if (audioContext.state !== 'closed') {
        await audioContext.close();
      }
    } catch (error) {
      closeError = error;
      this.options.logger?.warn('audio', 'failed to close file-decoder AudioContext', error);
    }

    if (operationError !== null) {
      throw operationError;
    }
    if (closeError !== null) {
      throw new AudioFileError('decode_failed', 'The local audio decoder did not close cleanly.', {
        cause: closeError,
      });
    }
    if (decodedAudio === null) {
      throw new AudioFileError('decode_failed', 'The local audio decoder returned no audio.');
    }
    return decodedAudio;
  }
}

export function assertEncodedFileSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new AudioFileError('read_failed', 'The selected audio file has an invalid size.');
  }
  if (sizeBytes > AUDIO_FILE_MAX_ENCODED_BYTES) {
    throw new AudioFileError(
      'encoded_size',
      `The encoded audio file exceeds the ${AUDIO_FILE_MAX_ENCODED_BYTES}-byte safety limit.`,
    );
  }
  if (sizeBytes === 0) {
    throw new AudioFileError('empty', 'The selected audio file is empty.');
  }
}

export function assertDecodedAudioWithinBudget(
  decodedAudio: DecodedAudioFile,
  options: DecodedAudioBudgetOptions,
): void {
  try {
    if (
      !Number.isFinite(decodedAudio.sampleRate) ||
      decodedAudio.sampleRate <= 0 ||
      !Number.isInteger(decodedAudio.length) ||
      decodedAudio.length <= 0 ||
      !Number.isInteger(decodedAudio.numberOfChannels) ||
      decodedAudio.numberOfChannels <= 0
    ) {
      throw new AudioFileError(
        'invalid_decode',
        'The local audio decoder returned invalid audio metadata.',
      );
    }

    const decodedBytes =
      decodedAudio.length * decodedAudio.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > AUDIO_FILE_MAX_DECODED_BYTES) {
      throw new AudioFileError(
        'decoded_memory',
        `Decoded audio exceeds the ${AUDIO_FILE_MAX_DECODED_BYTES}-byte memory safety limit.`,
      );
    }

    const durationMs = (decodedAudio.length / decodedAudio.sampleRate) * 1_000;
    if (durationMs > AUDIO_FILE_MAX_DURATION_MS) {
      throw new AudioFileError(
        'duration',
        `Decoded audio exceeds the ${AUDIO_FILE_MAX_DURATION_MS / 60_000}-minute duration limit.`,
      );
    }
    if (options.maxModelDurationMs !== null && durationMs > options.maxModelDurationMs) {
      throw new AudioFileError(
        'model_duration',
        `Decoded audio exceeds the selected model's ${formatDurationSeconds(options.maxModelDurationMs)} limit.`,
      );
    }
  } catch (error) {
    decodedAudio.dispose();
    throw error;
  }
}

export async function pumpDecodedAudioFrames(
  decodedAudio: DecodedAudioFile,
  options: PumpDecodedAudioFramesOptions,
): Promise<void> {
  try {
    const processor = new PcmFrameProcessor({ sourceSampleRate: decodedAudio.sampleRate });
    const channelSlices = readChannelSlices(decodedAudio);
    for (const channels of channelSlices) {
      throwIfCancelled(options.signal);
      const monoSlice = mixChannelsToMono(channels);
      for (const frame of processor.push(monoSlice)) {
        throwIfCancelled(options.signal);
        await options.waitForBackpressure(options.signal);
        throwIfCancelled(options.signal);
        const frameBytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
        if (frameBytes.byteLength !== PCM_BYTES_PER_FRAME) {
          throw new AudioFileError(
            'invalid_decode',
            'Audio resampling produced a mis-sized frame.',
          );
        }
        await options.writeFrame(frameBytes, options.signal);
      }
    }
  } finally {
    decodedAudio.dispose();
  }
}

export function createAudioFileCancellationError(): AudioFileError {
  return new AudioFileError('cancelled', 'Audio-file transcription was cancelled.');
}

export function isAudioFileCancellation(error: unknown): boolean {
  return error instanceof AudioFileError && error.code === 'cancelled';
}

function createDecodedAudioBuffer(audioBuffer: AudioBuffer): DecodedAudioFile {
  const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, channel) =>
    audioBuffer.getChannelData(channel),
  );
  return {
    length: audioBuffer.length,
    numberOfChannels: audioBuffer.numberOfChannels,
    sampleRate: audioBuffer.sampleRate,
    dispose: () => clearChannels(channels),
    getChannelData: (channel) => {
      const samples = channels[channel];
      if (samples === undefined) {
        throw new RangeError(`Decoded audio channel ${String(channel)} does not exist.`);
      }
      return samples;
    },
  };
}

function* readChannelSlices(decodedAudio: DecodedAudioFile): Generator<Float32Array[]> {
  for (let start = 0; start < decodedAudio.length; start += DECODE_CHANNEL_SLICE_SAMPLES) {
    const end = Math.min(decodedAudio.length, start + DECODE_CHANNEL_SLICE_SAMPLES);
    yield Array.from({ length: decodedAudio.numberOfChannels }, (_, channel) =>
      decodedAudio.getChannelData(channel).subarray(start, end),
    );
  }
}

async function readMediaStream(
  stream: MediaReadStream,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const bytes = new Uint8Array(expectedBytes);
  let totalBytes = 0;
  const abortReader = (): void => {
    void reader.cancel(createAudioFileCancellationError()).catch(() => {});
  };
  signal.addEventListener('abort', abortReader, { once: true });

  try {
    while (true) {
      const result = await abortable(reader.read(), signal, () => cancellationError(signal));
      if (result.done) {
        break;
      }
      const chunk = result.value;
      const nextTotalBytes = totalBytes + chunk.byteLength;
      assertEncodedFileSize(nextTotalBytes);
      if (nextTotalBytes > bytes.byteLength) {
        throw new AudioFileError('read_failed', 'The media lease changed while it was being read.');
      }
      bytes.set(chunk, totalBytes);
      totalBytes = nextTotalBytes;
    }
    throwIfCancelled(signal);
    if (totalBytes !== bytes.byteLength) {
      throw new AudioFileError('read_failed', 'The media lease changed while it was being read.');
    }
    return bytes.buffer;
  } catch (error) {
    if (signal.aborted) {
      throw cancellationError(signal);
    }
    if (error instanceof AudioFileError) {
      throw error;
    }
    throw new AudioFileError('read_failed', 'The media lease could not be read.', { cause: error });
  } finally {
    signal.removeEventListener('abort', abortReader);
    try {
      reader.releaseLock();
    } catch {
      // A pending read may still be settling after cancellation.
    }
  }
}

async function readEncodedAudioFile(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  if (typeof file.stream === 'function') {
    return await readFileStream(file, signal);
  }

  try {
    return await abortable(file.arrayBuffer(), signal, () => cancellationError(signal));
  } catch (error) {
    if (signal.aborted) {
      throw cancellationError(signal);
    }
    throw new AudioFileError('read_failed', 'The selected audio file could not be read.', {
      cause: error,
    });
  }
}

async function readFileStream(file: File, signal: AbortSignal): Promise<ArrayBuffer> {
  const reader = file.stream().getReader();
  const bytes = new Uint8Array(file.size);
  let totalBytes = 0;
  const abortReader = (): void => {
    void reader.cancel(createAudioFileCancellationError()).catch(() => {});
  };
  signal.addEventListener('abort', abortReader, { once: true });

  try {
    while (true) {
      const result = await abortable(reader.read(), signal, () => cancellationError(signal));
      if (result.done) {
        break;
      }
      const chunk = result.value;
      const nextTotalBytes = totalBytes + chunk.byteLength;
      assertEncodedFileSize(nextTotalBytes);
      if (nextTotalBytes > bytes.byteLength) {
        throw new AudioFileError(
          'read_failed',
          'The selected audio file changed while it was being read.',
        );
      }
      bytes.set(chunk, totalBytes);
      totalBytes = nextTotalBytes;
    }
    throwIfCancelled(signal);
    if (totalBytes !== bytes.byteLength) {
      throw new AudioFileError(
        'read_failed',
        'The selected audio file changed while it was being read.',
      );
    }
    return bytes.buffer;
  } catch (error) {
    if (signal.aborted) {
      throw cancellationError(signal);
    }
    if (error instanceof AudioFileError) {
      throw error;
    }
    throw new AudioFileError('read_failed', 'The selected audio file could not be read.', {
      cause: error,
    });
  } finally {
    signal.removeEventListener('abort', abortReader);
  }
}

async function abortable<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
  createAbortError: () => Error,
): Promise<T> {
  if (signal.aborted) {
    throw createAbortError();
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(createAbortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancellationError(signal);
  }
}

function cancellationError(signal: AbortSignal): AudioFileError {
  if (signal.reason instanceof AudioFileError) {
    return signal.reason;
  }
  return createAudioFileCancellationError();
}

function normalizeAudioFileError(error: unknown, signal: AbortSignal): AudioFileError {
  if (signal.aborted) {
    return cancellationError(signal);
  }
  if (error instanceof AudioFileError) {
    return error;
  }
  return new AudioFileError('decode_failed', 'The selected audio file could not be decoded.', {
    cause: error,
  });
}

function getWindowAudioContext(): typeof AudioContext {
  if (typeof window !== 'undefined' && window.AudioContext !== undefined) {
    return window.AudioContext;
  }
  throw new Error('AudioContext is not available in this Obsidian runtime.');
}

function formatDurationSeconds(durationMs: number): string {
  const seconds = durationMs / 1_000;
  return Number.isInteger(seconds) ? `${String(seconds)} seconds` : `${seconds.toFixed(1)} seconds`;
}
