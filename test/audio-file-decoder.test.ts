import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_FILE_MAX_DECODED_BYTES,
  AUDIO_FILE_MAX_DURATION_MS,
  AUDIO_FILE_MAX_ENCODED_BYTES,
  AudioFileError,
  assertDecodedAudioWithinBudget,
  type DecodedAudioFile,
  pumpDecodedAudioFrames,
  WebAudioAudioFileDecoder,
} from '../src/audio/audio-file-decoder';
import { PCM_BYTES_PER_FRAME, PCM_SAMPLES_PER_FRAME } from '../src/shared/pcm-format';
import {
  createGeneratedWavBytes,
  createGeneratedWavFile,
  decodeGeneratedPcm16Wav,
} from './fixtures/audio-file';

class FakeDecodedAudio implements DecodedAudioFile {
  public readonly dispose = vi.fn();

  constructor(
    public readonly sampleRate: number,
    public readonly numberOfChannels: number,
    public readonly length: number,
    private readonly channels: Float32Array[],
  ) {}

  getChannelData(channel: number): Float32Array {
    const samples = this.channels[channel];
    if (samples === undefined) {
      throw new Error(`Missing fake channel ${channel}.`);
    }
    return samples;
  }
}

class GeneratedWavAudioContext {
  public readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  public readonly decodeAudioData = vi.fn(async (data: ArrayBuffer) => {
    const decoded = decodeGeneratedPcm16Wav(new Uint8Array(data));
    return {
      length: decoded.channels[0]?.length ?? 0,
      numberOfChannels: decoded.channelCount,
      sampleRate: decoded.sampleRate,
      getChannelData: (channel: number) => {
        const samples = decoded.channels[channel];
        if (samples === undefined) {
          throw new Error(`Missing generated WAV channel ${String(channel)}.`);
        }
        return samples;
      },
    } as unknown as AudioBuffer;
  });
  public state: AudioContextState = 'running';

  async closeForTest(): Promise<void> {
    await this.close();
  }
}

function decoderWithContext(audioContext: GeneratedWavAudioContext): {
  context: GeneratedWavAudioContext;
  decoder: WebAudioAudioFileDecoder;
} {
  const context = audioContext;
  const AudioContextConstructor = new Proxy(
    function AudioContextFactory() {
      // The construct trap returns the configured fake context instance.
    },
    {
      construct: () => context,
    },
  ) as unknown as typeof AudioContext;
  return {
    context,
    decoder: new WebAudioAudioFileDecoder({
      getAudioContext: () => AudioContextConstructor,
    }),
  };
}

describe('WebAudioAudioFileDecoder', () => {
  it('decodes generated WAV bytes, really resamples them, and emits fixed 16 kHz frames', async () => {
    const samples = Float32Array.from({ length: 30_720 }, (_, index) => index / 30_719);
    const bytes = createGeneratedWavBytes({
      channelCount: 1,
      sampleRate: 48_000,
      samples: [samples],
    });
    const file = new File([bytes], 'fixture.wav', { type: 'audio/wav' });
    const { context, decoder } = decoderWithContext(new GeneratedWavAudioContext());

    const decoded = await decoder.decode(file);
    const frames: Uint8Array[] = [];
    await pumpDecodedAudioFrames(decoded, {
      signal: new AbortController().signal,
      waitForBackpressure: async () => {},
      writeFrame: async (frame) => {
        frames.push(frame);
      },
    });

    expect(decoded.sampleRate).toBe(48_000);
    expect(frames).toHaveLength(32);
    expect(frames.every((frame) => frame.byteLength === PCM_BYTES_PER_FRAME)).toBe(true);
    const firstFrameBytes = frames[0];
    if (firstFrameBytes === undefined) {
      throw new Error('Expected a resampled frame.');
    }
    const firstFrame = new Int16Array(
      firstFrameBytes.buffer.slice(
        firstFrameBytes.byteOffset,
        firstFrameBytes.byteOffset + firstFrameBytes.byteLength,
      ),
    );
    expect(firstFrame).toHaveLength(PCM_SAMPLES_PER_FRAME);
    expect(firstFrame[0]).toBe(0);
    expect(firstFrame.at(-1)).toBeGreaterThan(0);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('does not read or create an AudioContext when cancelled before the source starts', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const stream = vi.fn();
    const file = { size: 44, stream } as unknown as File;
    const { context, decoder } = decoderWithContext(new GeneratedWavAudioContext());

    await expect(decoder.decode(file, abortController.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(stream).not.toHaveBeenCalled();
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it('mixes stereo generated WAV channels before real resampling and frame output', async () => {
    const left = new Float32Array(1_920);
    const right = new Float32Array(1_920);
    left.fill(0.2);
    right.fill(0.4);
    const bytes = createGeneratedWavBytes({
      channelCount: 2,
      sampleRate: 48_000,
      samples: [left, right],
    });
    const file = new File([bytes], 'stereo.wav', { type: 'audio/wav' });
    const { decoder } = decoderWithContext(new GeneratedWavAudioContext());
    const decoded = await decoder.decode(file);
    const frames: Uint8Array[] = [];

    await pumpDecodedAudioFrames(decoded, {
      signal: new AbortController().signal,
      waitForBackpressure: async () => {},
      writeFrame: async (frame) => {
        frames.push(frame);
      },
    });

    expect(decoded.numberOfChannels).toBe(2);
    expect(frames).toHaveLength(2);
    const firstBytes = frames[0];
    if (firstBytes === undefined) throw new Error('Expected a stereo resampled frame.');
    const firstFrame = new Int16Array(
      firstBytes.buffer.slice(firstBytes.byteOffset, firstBytes.byteOffset + firstBytes.byteLength),
    );
    expect(firstFrame[0]).toBeGreaterThan(9_800);
    expect(firstFrame[0]).toBeLessThan(9_850);
  });

  it('rejects oversized encoded input before reading or creating an AudioContext', async () => {
    const stream = vi.fn();
    const file = {
      size: AUDIO_FILE_MAX_ENCODED_BYTES + 1,
      stream,
    } as unknown as File;
    const { context, decoder } = decoderWithContext(new GeneratedWavAudioContext());

    await expect(decoder.decode(file)).rejects.toMatchObject({
      code: 'encoded_size',
    });
    expect(stream).not.toHaveBeenCalled();
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it('closes the AudioContext when Web Audio rejects the file', async () => {
    const context = new GeneratedWavAudioContext();
    const decodeError = new Error('codec unavailable');
    context.decodeAudioData.mockRejectedValueOnce(decodeError);
    const { decoder } = decoderWithContext(context);
    const file = createGeneratedWavFile('broken.wav', {
      channelCount: 1,
      sampleRate: 16_000,
      samples: [new Float32Array([0, 0])],
    });

    await expect(decoder.decode(file)).rejects.toMatchObject({
      cause: decodeError,
      code: 'decode_failed',
    });
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('does not create or leak an AudioContext when cancelled after the encoded read', async () => {
    const abortController = new AbortController();
    const file = {
      size: 44,
      stream: () => ({
        getReader: () => ({
          cancel: vi.fn(async () => {}),
          read: async () => {
            abortController.abort();
            return { done: true, value: undefined };
          },
        }),
      }),
    } as unknown as File;
    const { context, decoder } = decoderWithContext(new GeneratedWavAudioContext());

    await expect(decoder.decode(file, abortController.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(context.decodeAudioData).not.toHaveBeenCalled();
    expect(context.close).not.toHaveBeenCalled();
  });

  it('aborts a pending decode and always closes the AudioContext', async () => {
    const abortController = new AbortController();
    const context = new GeneratedWavAudioContext();
    let markDecodeStarted: (() => void) | undefined;
    const decodeStarted = new Promise<void>((resolve) => {
      markDecodeStarted = resolve;
    });
    context.decodeAudioData.mockImplementationOnce(async () => {
      markDecodeStarted?.();
      return await new Promise<AudioBuffer>(() => {});
    });
    const { decoder } = decoderWithContext(context);
    const file = createGeneratedWavFile('pending.wav', {
      channelCount: 1,
      sampleRate: 16_000,
      samples: [new Float32Array([0, 0])],
    });

    const decoding = decoder.decode(file, abortController.signal);
    await decodeStarted;
    abortController.abort();
    await expect(decoding).rejects.toMatchObject({ code: 'cancelled' });
    expect(context.close).toHaveBeenCalledOnce();
  });
});

describe('decoded audio budgets and frame flow', () => {
  it('rejects a decoded file over the duration cap and disposes decoded channels', () => {
    const decoded = new FakeDecodedAudio(8_000, 1, 14_400_001, [new Float32Array(0)]);

    expectAudioFileError(
      () => assertDecodedAudioWithinBudget(decoded, { maxModelDurationMs: null }),
      'duration',
    );
    expect(decoded.dispose).toHaveBeenCalledOnce();
  });

  it('rejects a decoded file over the logical PCM memory cap and disposes decoded channels', () => {
    const decoded = new FakeDecodedAudio(48_000, 8, 7_000_000, [
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
      new Float32Array(0),
    ]);

    expectAudioFileError(
      () => assertDecodedAudioWithinBudget(decoded, { maxModelDurationMs: null }),
      'decoded_memory',
    );
    expect(decoded.dispose).toHaveBeenCalledOnce();
  });

  it('enforces a model-specific decoded duration cap', () => {
    const decoded = new FakeDecodedAudio(16_000, 1, 570_001, [new Float32Array(0)]);

    expectAudioFileError(
      () => assertDecodedAudioWithinBudget(decoded, { maxModelDurationMs: 35_000 }),
      'model_duration',
    );
    expect(decoded.dispose).toHaveBeenCalledOnce();
  });

  it('bounds channel work, checks cancellation, and awaits backpressure before every frame', async () => {
    const samples = Float32Array.from({ length: 1_950 }, (_, index) => index / 1_949);
    const decoded = new FakeDecodedAudio(48_000, 1, samples.length, [samples]);
    const order: string[] = [];
    const frames: number[] = [];

    await pumpDecodedAudioFrames(decoded, {
      signal: new AbortController().signal,
      waitForBackpressure: async () => {
        order.push('gate');
      },
      writeFrame: async (frame) => {
        order.push('write');
        frames.push(frame.byteLength);
      },
    });

    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((bytes) => bytes === PCM_BYTES_PER_FRAME)).toBe(true);
    expect(order.slice(0, 4)).toEqual(['gate', 'write', 'gate', 'write']);
    decoded.dispose.mockClear();
  });

  it('stops between channel chunks when frame production is cancelled', async () => {
    const abortController = new AbortController();
    const samples = new Float32Array(1_000_000);
    const decoded = new FakeDecodedAudio(48_000, 1, samples.length, [samples]);
    const writeFrame = vi.fn(async () => {
      abortController.abort();
    });

    await expect(
      pumpDecodedAudioFrames(decoded, {
        signal: abortController.signal,
        waitForBackpressure: async () => {},
        writeFrame,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(writeFrame).toHaveBeenCalledOnce();
  });

  it('exports a 30 minute conservative cap below the raw 256 MiB boundary', () => {
    expect(AUDIO_FILE_MAX_DURATION_MS).toBe(30 * 60 * 1_000);
    expect(AUDIO_FILE_MAX_DECODED_BYTES).toBe(192 * 1024 * 1024);
  });
});

function expectAudioFileError(operation: () => void, code: AudioFileError['code']): void {
  try {
    operation();
    throw new Error('Expected AudioFileError.');
  } catch (error) {
    expect(error).toBeInstanceOf(AudioFileError);
    expect((error as AudioFileError).code).toBe(code);
  }
}
