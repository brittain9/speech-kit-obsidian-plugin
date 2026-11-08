export interface GeneratedWavOptions {
  readonly channelCount: number;
  readonly sampleRate: number;
  readonly samples: readonly ArrayLike<number>[];
}

export function createGeneratedWavBytes(options: GeneratedWavOptions): Uint8Array<ArrayBuffer> {
  const { channelCount, sampleRate, samples } = options;
  if (
    channelCount < 1 ||
    samples.length === 0 ||
    samples.some((channel) => channel.length !== samples[0]?.length)
  ) {
    throw new Error('Invalid generated WAV fixture.');
  }

  const frameCount = samples[0]?.length ?? 0;
  const dataBytes = frameCount * channelCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let sampleIndex = 0; sampleIndex < frameCount; sampleIndex += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, samples[channel]?.[sampleIndex] ?? 0));
      const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(offset, pcm, true);
      offset += 2;
    }
  }
  return bytes;
}

export function createGeneratedWavFile(name: string, options: GeneratedWavOptions): File {
  return new File([createGeneratedWavBytes(options)], name, { type: 'audio/wav' });
}

export function decodeGeneratedPcm16Wav(bytes: Uint8Array): {
  readonly channelCount: number;
  readonly channels: Float32Array[];
  readonly sampleRate: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expectAscii(bytes, 0, 'RIFF');
  expectAscii(bytes, 8, 'WAVE');
  expectAscii(bytes, 12, 'fmt ');
  expectAscii(bytes, 36, 'data');
  const channelCount = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  if (channelCount < 1 || bitsPerSample !== 16) {
    throw new Error('Unsupported generated WAV fixture.');
  }
  const dataLength = view.getUint32(40, true);
  const frameCount = Math.floor(dataLength / (channelCount * 2));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frameCount));
  let offset = 44;
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const pcm = view.getInt16(offset, true);
      const output = channels[channel];
      if (output === undefined) {
        throw new Error('Missing generated WAV output channel.');
      }
      output[frame] = pcm < 0 ? pcm / 0x8000 : pcm / 0x7fff;
      offset += 2;
    }
  }
  return { channelCount, channels, sampleRate };
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

function expectAscii(bytes: Uint8Array, offset: number, value: string): void {
  const actual = String.fromCharCode(...bytes.subarray(offset, offset + value.length));
  if (actual !== value) {
    throw new Error(`Expected ${value} at byte ${offset}, received ${actual}.`);
  }
}
