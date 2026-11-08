import { describe, expect, it } from 'vitest';

import catalog from '../native/catalog.json';

describe('Moonshine Tiny catalog artifacts', () => {
  it('installs the verified per-channel export through the existing streaming entry point', () => {
    const model = catalog.models.find(
      (candidate) => candidate.modelId === 'moonshine_tiny_streaming_en',
    );
    const artifactRoot =
      'https://huggingface.co/moonshine-ai/moonshine-voice-assets/resolve/015f7269048251aff164cb60df02bfea76884c8f/model/tiny-streaming-en/quantized_26_07_30/';

    expect(model?.runtimeId).toBe('onnx_runtime');
    expect(model?.familyId).toBe('moonshine');
    expect(model?.languageTags).toEqual(['en']);
    expect(model?.licenseLabel).toBe('MIT');
    expect(model?.artifacts.map((artifact) => artifact.filename).sort()).toEqual([
      'adapter.ort',
      'cross_kv.ort',
      'decoder_kv.ort',
      'encoder.ort',
      'frontend.ort',
      'streaming_config.json',
      'tokenizer.bin',
    ]);
    expect(model?.artifacts.every((artifact) => artifact.required)).toBe(true);
    expect(
      model?.artifacts.every(
        (artifact) => artifact.downloadUrl === `${artifactRoot}${artifact.filename}`,
      ),
    ).toBe(true);
    expect(model?.artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0)).toBe(
      51_441_771,
    );
    expect(
      model?.artifacts.find((artifact) => artifact.role === 'transcription_model'),
    ).toMatchObject({
      filename: 'frontend.ort',
      sha256: '271a563251f11e6311949530f8025ed4d345c5d69d4ac1efa74093779927d636',
    });
  });
});
