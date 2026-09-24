import { describe, expect, it, vi } from 'vitest';
import { pumpDecodedAudioFrames, WebAudioAudioFileDecoder } from '../src/audio/audio-file-decoder';
import type { LocalMediaLease } from '../src/media/media-source';
import { createGeneratedWavBytes, decodeGeneratedPcm16Wav } from './fixtures/audio-file';

class GeneratedWavAudioContext {
  public readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  public readonly decodeAudioData = vi.fn(async (data: ArrayBuffer) => {
    const decoded = decodeGeneratedPcm16Wav(new Uint8Array(data));
    return {
      getChannelData: (channel: number) => decoded.channels[channel] as Float32Array,
      length: decoded.channels[0]?.length ?? 0,
      numberOfChannels: decoded.channelCount,
      sampleRate: decoded.sampleRate,
    } as unknown as AudioBuffer;
  });
  public state: AudioContextState = 'running';
}

describe('media lease decoding', () => {
  it('decodes opaque lease bytes through the existing local decoder and frame pump', async () => {
    const bytes = createGeneratedWavBytes({
      channelCount: 1,
      sampleRate: 16_000,
      samples: [new Float32Array(640)],
    });
    const context = new GeneratedWavAudioContext();
    const AudioContextConstructor = new Proxy(function AudioContextFactory() {}, {
      construct: () => context,
    }) as unknown as typeof AudioContext;
    const decoder = new WebAudioAudioFileDecoder({
      getAudioContext: () => AudioContextConstructor,
    });
    const lease: LocalMediaLease = {
      encodedBytes: bytes.byteLength,
      mediaId: 'lease-1',
      openReadStream: async () => new Blob([bytes]).stream(),
      provenance: {
        access: 'local',
        acquiredAt: new Date(0).toISOString(),
        adapterVersion: '1',
        rights: { kind: 'user_supplied_file' },
        sourceId: 'local_file',
        sourceRef: { fileToken: 'opaque', kind: 'local_file' },
        temporaryMedia: true,
      },
      release: vi.fn(async () => {}),
    };

    const decoded = await decoder.decodeMedia(lease);
    const frames: Uint8Array[] = [];
    await pumpDecodedAudioFrames(decoded, {
      signal: new AbortController().signal,
      waitForBackpressure: async () => {},
      writeFrame: async (frame) => {
        frames.push(frame);
      },
    });

    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.byteLength === 640)).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
  });
});
