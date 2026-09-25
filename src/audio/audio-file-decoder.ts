import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LOCAL_MEDIA_MAX_ENCODED_BYTES,
  MEDIA_MAX_DECODED_BYTES,
  MEDIA_MAX_DURATION_MS,
} from '../media/media-policy';
import type { MediaLease, MediaReadStream } from '../media/media-source';
import { type ManagedProcessResult, runManagedProcess } from '../media/process-runner';
import { PCM_BYTES_PER_FRAME, PCM_SAMPLE_RATE_HZ } from '../shared/pcm-format';
import type { PluginLogger } from '../shared/plugin-logger';
import { mixChannelsToMono, PcmFrameProcessor } from './pcm-frame-processor';

export const AUDIO_FILE_MAX_ENCODED_BYTES = LOCAL_MEDIA_MAX_ENCODED_BYTES;
export const AUDIO_FILE_MAX_DECODED_BYTES = MEDIA_MAX_DECODED_BYTES;
export const AUDIO_FILE_MAX_DURATION_MS = MEDIA_MAX_DURATION_MS;
export const AUDIO_FILE_DECODE_TIMEOUT_MS = 30 * 60 * 1_000;
const FFMPEG_STDERR_LIMIT_BYTES = 64 * 1024;
const FFPROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
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
  dispose(): void | Promise<void>;
  getChannelData?(channel: number): Float32Array;
  pumpFrames?(options: PumpDecodedAudioFramesOptions): Promise<void>;
}

export interface AudioFileDecoder {
  decode(file: File, signal: AbortSignal): Promise<DecodedAudioFile>;
  decodeMedia(lease: MediaLease, signal: AbortSignal): Promise<DecodedAudioFile>;
}

export interface FfmpegExecutables {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
}

export type FfmpegProcessRunner = typeof runManagedProcess;

export interface FfmpegAudioFileDecoderOptions {
  readonly getExecutables: () => FfmpegExecutables | Promise<FfmpegExecutables>;
  readonly logger?: PluginLogger;
  readonly runProcess?: FfmpegProcessRunner;
  readonly temporaryDirectory?: string;
}

interface DecodedAudioBudgetOptions {
  readonly maxModelDurationMs: number | null;
}

export interface PumpDecodedAudioFramesOptions {
  readonly signal: AbortSignal;
  readonly waitForBackpressure: (signal: AbortSignal) => Promise<void>;
  readonly writeFrame: (frame: Uint8Array, signal: AbortSignal) => Promise<void>;
}

interface FfprobeOutput {
  readonly streams?: readonly { readonly codec_type?: unknown; readonly duration?: unknown }[];
  readonly format?: { readonly duration?: unknown };
}

export class FfmpegAudioFileDecoder implements AudioFileDecoder {
  private readonly runProcess: FfmpegProcessRunner;

  constructor(private readonly options: FfmpegAudioFileDecoderOptions) {
    this.runProcess = options.runProcess ?? runManagedProcess;
  }

  async decode(file: File, signal: AbortSignal): Promise<DecodedAudioFile> {
    throwIfCancelled(signal);
    assertEncodedFileSize(file.size);
    if (typeof file.stream !== 'function') {
      throw new AudioFileError(
        'read_failed',
        'This Obsidian runtime cannot stream the selected file safely.',
      );
    }
    return await this.prepareMedia(file.stream(), file.size, signal);
  }

  async decodeMedia(lease: MediaLease, signal: AbortSignal): Promise<DecodedAudioFile> {
    throwIfCancelled(signal);
    assertEncodedFileSize(lease.encodedBytes);
    let stream: MediaReadStream;
    try {
      stream = await lease.openReadStream();
    } catch (error) {
      throw normalizeReadError(error, signal);
    }
    return await this.prepareMedia(stream, lease.encodedBytes, signal);
  }

  private async prepareMedia(
    stream: MediaReadStream,
    expectedBytes: number,
    signal: AbortSignal,
  ): Promise<DecodedAudioFile> {
    const directory = await mkdtemp(
      join(this.options.temporaryDirectory ?? tmpdir(), 'speech-kit-media-'),
    );
    const inputPath = join(directory, `source-${randomUUID()}.media`);
    let keepDirectory = false;
    let cleanupPromise: Promise<void> | null = null;
    const dispose = (): Promise<void> => {
      cleanupPromise ??= removeTemporaryMedia(directory, this.options.logger);
      return cleanupPromise;
    };
    try {
      await writeMediaStream(stream, inputPath, expectedBytes, signal);
      throwIfCancelled(signal);
      const audio = await this.options.getExecutables();
      const durationMs = await this.probeDuration(audio.ffprobePath, inputPath, signal);
      const metadata: DecodedAudioFile = {
        length: Math.round((durationMs / 1_000) * PCM_SAMPLE_RATE_HZ),
        numberOfChannels: 1,
        sampleRate: PCM_SAMPLE_RATE_HZ,
        dispose,
        pumpFrames: async (pumpOptions) =>
          await this.pumpFfmpegFrames(audio.ffmpegPath, inputPath, durationMs, pumpOptions),
      };
      keepDirectory = true;
      return metadata;
    } catch (error) {
      throw normalizeDecodeError(error, signal);
    } finally {
      if (!keepDirectory) await dispose();
    }
  }

  private async probeDuration(
    ffprobePath: string,
    inputPath: string,
    signal: AbortSignal,
  ): Promise<number> {
    const result = await this.runProcess(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,duration',
        '-of',
        'json',
        '-i',
        inputPath,
      ],
      processOptions(),
      {
        maxOutputBytes: FFPROBE_OUTPUT_LIMIT_BYTES,
        signal,
        stderrLimitBytes: FFMPEG_STDERR_LIMIT_BYTES,
        timeoutMs: 30_000,
      },
    );
    assertSuccessfulProcess(result, 'The media file could not be inspected.', signal);

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(result.stdout) as FfprobeOutput;
    } catch (error) {
      throw new AudioFileError('decode_failed', 'FFprobe returned invalid media metadata.', {
        cause: error,
      });
    }
    const streams = parsed.streams ?? [];
    const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
    if (audioStreams.length === 0) {
      throw new AudioFileError(
        'decode_failed',
        'The selected video or audio file has no audio track.',
      );
    }
    const durationSeconds =
      parsePositiveSeconds(parsed.format?.duration) ??
      audioStreams
        .map((stream) => parsePositiveSeconds(stream.duration))
        .find((value) => value !== null);
    if (durationSeconds === undefined || durationSeconds === null) {
      throw new AudioFileError('decode_failed', 'The media duration could not be determined.');
    }
    const durationMs = durationSeconds * 1_000;
    if (durationMs > AUDIO_FILE_MAX_DURATION_MS) {
      throw new AudioFileError(
        'duration',
        `Audio duration exceeds the ${AUDIO_FILE_MAX_DURATION_MS / 60_000}-minute limit.`,
      );
    }
    return durationMs;
  }

  private async pumpFfmpegFrames(
    ffmpegPath: string,
    inputPath: string,
    durationMs: number,
    options: PumpDecodedAudioFramesOptions,
  ): Promise<void> {
    throwIfCancelled(options.signal);
    const maxPcmBytes = Math.ceil((AUDIO_FILE_MAX_DURATION_MS / 1_000) * PCM_SAMPLE_RATE_HZ) * 2;
    let outputBytes = 0;
    let pending = new Uint8Array(0);
    let frameCount = 0;
    let streamError: unknown;
    const result = await this.runProcess(
      ffmpegPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-i',
        inputPath,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-ar',
        String(PCM_SAMPLE_RATE_HZ),
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      { ...processOptions(), stdio: ['ignore', 'pipe', 'pipe'] },
      {
        maxOutputBytes: maxPcmBytes + PCM_BYTES_PER_FRAME,
        signal: options.signal,
        stderrLimitBytes: FFMPEG_STDERR_LIMIT_BYTES,
        timeoutMs: AUDIO_FILE_DECODE_TIMEOUT_MS,
        onStdoutChunk: async (chunk) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxPcmBytes) {
            throw new AudioFileError('duration', 'Decoded audio exceeds the 30-minute limit.');
          }
          const joined = joinBytes(pending, chunk);
          let offset = 0;
          while (offset + PCM_BYTES_PER_FRAME <= joined.byteLength) {
            throwIfCancelled(options.signal);
            await options.waitForBackpressure(options.signal);
            throwIfCancelled(options.signal);
            const frame = joined.subarray(offset, offset + PCM_BYTES_PER_FRAME);
            await options.writeFrame(frame, options.signal);
            frameCount += 1;
            offset += PCM_BYTES_PER_FRAME;
          }
          pending = joined.slice(offset);
        },
      },
    ).catch((error: unknown) => {
      streamError = error;
      throw error;
    });

    if (streamError !== undefined) throw normalizeDecodeError(streamError, options.signal);
    if (result.streamError !== undefined) {
      throw normalizeDecodeError(result.streamError, options.signal);
    }
    assertSuccessfulProcess(result, 'FFmpeg could not decode the selected media.', options.signal);
    if (durationMs > AUDIO_FILE_MAX_DURATION_MS) {
      throw new AudioFileError('duration', 'Decoded audio exceeds the 30-minute limit.');
    }
    if (frameCount === 0) {
      throw new AudioFileError('empty', 'The decoded audio is shorter than one complete frame.');
    }
  }
}

export function assertEncodedFileSize(sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    throw new AudioFileError('read_failed', 'The selected media file has an invalid size.');
  }
  if (sizeBytes > AUDIO_FILE_MAX_ENCODED_BYTES) {
    throw new AudioFileError(
      'encoded_size',
      `The encoded media file exceeds the ${AUDIO_FILE_MAX_ENCODED_BYTES}-byte safety limit.`,
    );
  }
  if (sizeBytes === 0) {
    throw new AudioFileError('empty', 'The selected media file is empty.');
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
        `Decoded audio exceeds the ${AUDIO_FILE_MAX_DECODED_BYTES}-byte safety limit.`,
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
    void decodedAudio.dispose();
    throw error;
  }
}

export async function pumpDecodedAudioFrames(
  decodedAudio: DecodedAudioFile,
  options: PumpDecodedAudioFramesOptions,
): Promise<void> {
  try {
    if (decodedAudio.pumpFrames !== undefined) {
      await decodedAudio.pumpFrames(options);
      return;
    }
    if (decodedAudio.getChannelData === undefined) {
      throw new AudioFileError('invalid_decode', 'Decoded media cannot provide audio frames.');
    }
    const processor = new PcmFrameProcessor({ sourceSampleRate: decodedAudio.sampleRate });
    for (const channels of readChannelSlices(decodedAudio)) {
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
    await decodedAudio.dispose();
  }
}

export function createAudioFileCancellationError(): AudioFileError {
  return new AudioFileError('cancelled', 'Audio-file transcription was cancelled.');
}

export function isAudioFileCancellation(error: unknown): boolean {
  return error instanceof AudioFileError && error.code === 'cancelled';
}

function* readChannelSlices(decodedAudio: DecodedAudioFile): Generator<Float32Array[]> {
  for (let start = 0; start < decodedAudio.length; start += DECODE_CHANNEL_SLICE_SAMPLES) {
    const end = Math.min(decodedAudio.length, start + DECODE_CHANNEL_SLICE_SAMPLES);
    yield Array.from({ length: decodedAudio.numberOfChannels }, (_, channel) => {
      const data = decodedAudio.getChannelData?.(channel);
      if (data === undefined) {
        throw new AudioFileError('invalid_decode', 'Decoded audio channel data is unavailable.');
      }
      return data.subarray(start, end);
    });
  }
}

async function writeMediaStream(
  stream: MediaReadStream,
  path: string,
  expectedBytes: number,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  let totalBytes = 0;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const cancelReader = (): void => {
    void reader.cancel(createAudioFileCancellationError()).catch(() => {});
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    handle = await open(path, 'wx', 0o600);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      throwIfCancelled(signal);
      totalBytes += value.byteLength;
      assertEncodedFileSize(totalBytes);
      if (totalBytes > expectedBytes) {
        throw new AudioFileError('read_failed', 'The media lease changed while it was being read.');
      }
      await writeAll(handle, value);
    }
    throwIfCancelled(signal);
    if (totalBytes !== expectedBytes) {
      throw new AudioFileError('read_failed', 'The media lease changed while it was being read.');
    }
  } catch (error) {
    if (signal.aborted) throw cancellationError(signal);
    if (error instanceof AudioFileError) throw error;
    throw new AudioFileError('read_failed', 'The selected media file could not be read.', {
      cause: error,
    });
  } finally {
    signal.removeEventListener('abort', cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // A cancelled pending read may still be settling.
    }
    await handle?.close().catch(() => {});
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  value: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
    if (bytesWritten <= 0) throw new Error('The temporary media file stopped accepting bytes.');
    offset += bytesWritten;
  }
}

function processOptions() {
  return {
    cwd: tmpdir(),
    env: {
      HOME: tmpdir(),
      LANG: 'C',
      LC_ALL: 'C',
      TEMP: tmpdir(),
      TMP: tmpdir(),
      TMPDIR: tmpdir(),
      USERPROFILE: tmpdir(),
    },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  };
}

function assertSuccessfulProcess(
  result: ManagedProcessResult,
  message: string,
  signal: AbortSignal,
): void {
  if (result.cancelled || signal.aborted) throw cancellationError(signal);
  if (result.streamError !== undefined) {
    throw normalizeDecodeError(result.streamError, signal);
  }
  if (result.timedOut) {
    throw new AudioFileError('decode_failed', 'Media decoding exceeded its time limit.');
  }
  if (result.cleanupFailed) {
    throw new AudioFileError('decode_failed', 'The media decoder did not close cleanly.');
  }
  if (result.outputLimitExceeded) {
    throw new AudioFileError('duration', 'Decoded audio exceeded the configured safety limit.');
  }
  if (result.failed || result.exitCode !== 0) {
    const noAudio = /matches no streams|does not contain any stream|no audio stream/iu.test(
      result.stderr,
    );
    throw new AudioFileError(
      'decode_failed',
      noAudio ? 'The selected video or audio file has no supported audio track.' : message,
      { cause: result.stderr.length > 0 ? new Error(result.stderr.slice(0, 500)) : undefined },
    );
  }
}

function parsePositiveSeconds(value: unknown): number | null {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

async function removeTemporaryMedia(directory: string, logger?: PluginLogger): Promise<void> {
  try {
    await rm(directory, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  } catch (error) {
    logger?.warn('audio', 'failed to remove temporary media files', error);
  }
}

function normalizeReadError(error: unknown, signal: AbortSignal): AudioFileError {
  if (signal.aborted) return cancellationError(signal);
  return error instanceof AudioFileError
    ? error
    : new AudioFileError('read_failed', 'The media lease could not be opened.', { cause: error });
}

function normalizeDecodeError(error: unknown, signal: AbortSignal): AudioFileError {
  if (signal.aborted) return cancellationError(signal);
  if (error instanceof AudioFileError) return error;
  return new AudioFileError('decode_failed', 'The selected media could not be decoded.', {
    cause: error,
  });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal);
}

function cancellationError(signal: AbortSignal): AudioFileError {
  if (signal.reason instanceof AudioFileError) return signal.reason;
  return createAudioFileCancellationError();
}

function formatDurationSeconds(durationMs: number): string {
  const seconds = durationMs / 1_000;
  return Number.isInteger(seconds) ? `${String(seconds)} seconds` : `${seconds.toFixed(1)} seconds`;
}
