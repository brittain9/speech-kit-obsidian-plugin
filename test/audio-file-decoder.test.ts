import { access } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_FILE_MAX_DECODED_BYTES,
  AUDIO_FILE_MAX_DURATION_MS,
  AUDIO_FILE_MAX_ENCODED_BYTES,
  assertDecodedAudioWithinBudget,
  type DecodedAudioFile,
  FfmpegAudioFileDecoder,
  type FfmpegProcessRunner,
  pumpDecodedAudioFrames,
} from '../src/audio/audio-file-decoder';
import type { MediaLease } from '../src/media/media-source';
import type { ManagedProcessResult } from '../src/media/process-runner';
import { PCM_BYTES_PER_FRAME } from '../src/shared/pcm-format';

const PROBE_METADATA = JSON.stringify({
  format: { duration: '1.000' },
  streams: [{ codec_type: 'audio', duration: '1.000' }],
});

function processResult(overrides: Partial<ManagedProcessResult> = {}): ManagedProcessResult {
  return {
    cancelled: false,
    cleanupFailed: false,
    exitCode: 0,
    failed: false,
    outputLimitExceeded: false,
    stderr: '',
    stdout: PROBE_METADATA,
    timedOut: false,
    ...overrides,
  };
}

function mediaLease(bytes: Uint8Array, streamedBytes = bytes): MediaLease {
  return {
    encodedBytes: bytes.byteLength,
    mediaId: 'test-media',
    provenance: {
      acquiredAt: new Date(0).toISOString(),
      adapterVersion: 'test',
      sourceId: 'test',
      temporaryMedia: true,
    },
    async openReadStream() {
      let emitted = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted) {
            controller.close();
          } else {
            emitted = true;
            controller.enqueue(streamedBytes);
          }
        },
      });
    },
    release: async () => {},
  };
}

function decoderWithRunner(
  runProcess: FfmpegProcessRunner,
  temporaryDirectory?: string,
): FfmpegAudioFileDecoder {
  return new FfmpegAudioFileDecoder({
    getExecutables: () => ({ ffmpegPath: '/fake/ffmpeg', ffprobePath: '/fake/ffprobe' }),
    runProcess,
    ...(temporaryDirectory === undefined ? {} : { temporaryDirectory }),
  });
}

describe('FfmpegAudioFileDecoder', () => {
  it('probes local media and streams fixed 16 kHz mono PCM frames with backpressure', async () => {
    const chunks = [Buffer.alloc(400, 1), Buffer.alloc(880, 2)];
    const runProcess: FfmpegProcessRunner = vi.fn(async (command, args, _spawnOptions, limits) => {
      if (command === '/fake/ffprobe') return processResult();
      expect(args).toContain('-map');
      expect(args).toContain('0:a:0');
      expect(args).toContain('-ac');
      expect(args).toContain('1');
      expect(args).toContain('-ar');
      expect(args).toContain('16000');
      expect(args).toContain('pipe:1');
      expect(_spawnOptions.shell).toBe(false);
      for (const chunk of chunks) await limits.onStdoutChunk?.(chunk);
      return processResult({ stdout: '' });
    });
    const decoder = decoderWithRunner(runProcess);
    const decoded = await decoder.decodeMedia(
      mediaLease(Uint8Array.from([1, 2, 3])),
      new AbortController().signal,
    );
    const frames: Uint8Array[] = [];
    const waitForBackpressure = vi.fn(async () => {});

    await pumpDecodedAudioFrames(decoded, {
      signal: new AbortController().signal,
      waitForBackpressure,
      writeFrame: async (frame) => {
        frames.push(frame.slice());
      },
    });

    expect(decoded.length).toBe(16_000);
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.numberOfChannels).toBe(1);
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.byteLength === PCM_BYTES_PER_FRAME)).toBe(true);
    expect(waitForBackpressure).toHaveBeenCalledTimes(2);
    expect(runProcess).toHaveBeenCalledTimes(2);
  });

  it('keeps only the encoded source on disk and removes it when frame pumping completes', async () => {
    let inputPath = '';
    const runProcess: FfmpegProcessRunner = vi.fn(async (command, args, _spawnOptions, limits) => {
      if (command === '/fake/ffprobe') {
        inputPath = args[args.indexOf('-i') + 1] ?? '';
        return processResult();
      }
      await limits.onStdoutChunk?.(Buffer.alloc(PCM_BYTES_PER_FRAME));
      return processResult({ stdout: '' });
    });
    const decoder = decoderWithRunner(runProcess);
    const decoded = await decoder.decodeMedia(
      mediaLease(Uint8Array.from([3, 4, 5])),
      new AbortController().signal,
    );
    await expect(access(inputPath)).resolves.toBeUndefined();
    await pumpDecodedAudioFrames(decoded, {
      signal: new AbortController().signal,
      waitForBackpressure: async () => {},
      writeFrame: async () => {},
    });
    await expect(access(inputPath)).rejects.toThrow();
  });

  it('rejects media without an audio stream and removes its temporary source', async () => {
    let inputPath = '';
    const runProcess: FfmpegProcessRunner = vi.fn(async (_command, args) => {
      inputPath = args[args.indexOf('-i') + 1] ?? '';
      return processResult({ stdout: JSON.stringify({ streams: [{ codec_type: 'video' }] }) });
    });
    const decoder = decoderWithRunner(runProcess);

    await expect(
      decoder.decodeMedia(mediaLease(Uint8Array.from([3, 4, 5])), new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'decode_failed',
      message: 'The selected video or audio file has no audio track.',
    });
    await expect(access(inputPath)).rejects.toThrow();
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it('rejects a media lease that streams a different byte count', async () => {
    const runProcess: FfmpegProcessRunner = vi.fn(async () => processResult());
    const decoder = decoderWithRunner(runProcess);

    await expect(
      decoder.decodeMedia(
        mediaLease(Uint8Array.from([1, 2, 3, 4]), Uint8Array.from([1, 2])),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'read_failed' });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('aborts and disposes temporary media if a downstream frame write fails', async () => {
    let inputPath = '';
    const runProcess: FfmpegProcessRunner = vi.fn(async (command, args, _spawnOptions, limits) => {
      if (command === '/fake/ffprobe') {
        inputPath = args[args.indexOf('-i') + 1] ?? '';
        return processResult();
      }
      await limits.onStdoutChunk?.(Buffer.alloc(PCM_BYTES_PER_FRAME));
      return processResult();
    });
    const decoder = decoderWithRunner(runProcess);
    const abortController = new AbortController();
    const decoded = await decoder.decodeMedia(
      mediaLease(Uint8Array.from([1, 2, 3])),
      abortController.signal,
    );
    const writeError = new Error('sidecar write failed');

    await expect(
      pumpDecodedAudioFrames(decoded, {
        signal: abortController.signal,
        waitForBackpressure: async () => {},
        writeFrame: async () => {
          abortController.abort(writeError);
          throw writeError;
        },
      }),
    ).rejects.toBe(writeError);
    await expect(access(inputPath)).rejects.toThrow();
  });

  it('enforces the duration and model budgets from probed metadata', async () => {
    const metadata: DecodedAudioFile = {
      length: 16_000 * 36,
      numberOfChannels: 1,
      sampleRate: 16_000,
      dispose: vi.fn(),
    };
    expect(() => assertDecodedAudioWithinBudget(metadata, { maxModelDurationMs: 35_000 })).toThrow(
      expect.objectContaining({ code: 'model_duration' }),
    );
    expect(() =>
      assertDecodedAudioWithinBudget(metadata, { maxModelDurationMs: null }),
    ).not.toThrow();
    expect(AUDIO_FILE_MAX_DURATION_MS).toBeGreaterThan(10_237_000);
    expect(AUDIO_FILE_MAX_DECODED_BYTES).toBe(192 * 1024 * 1024);
    expect(AUDIO_FILE_MAX_ENCODED_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it('allows a long file-backed recording without treating its streamed PCM as heap memory', () => {
    expect(() =>
      assertDecodedAudioWithinBudget(
        {
          length: 10_237 * 16_000,
          numberOfChannels: 1,
          sampleRate: 16_000,
          dispose: vi.fn(),
          pumpFrames: async () => {},
        },
        { maxModelDurationMs: null },
      ),
    ).not.toThrow();
  });
});
