import { describe, expect, it } from 'vitest';

import catalog from '../native/catalog.json';

describe('Nemotron streaming catalog profiles', () => {
  it('offers the pinned April English export with English-only capabilities', () => {
    const model = catalog.models.find(
      (item) => item.modelId === 'nemotron_speech_streaming_en_0_6b_int8_560ms',
    );
    expect(model).toMatchObject({
      runtimeId: 'onnx_runtime',
      familyId: 'nemotron_asr',
      languageTags: ['en'],
      supportsAutomaticLanguageDetection: false,
      licenseLabel: 'NVIDIA Open Model License',
    });
    expect(model?.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)).toBe(
      661_919_416,
    );
    expect(model?.uxTags).toContain('requires-terms-review');
    expect(
      model?.artifacts.every((artifact) =>
        artifact.downloadUrl.includes('/52056fdc070914a48dcd68b31b44d6a6f5b85902/'),
      ),
    ).toBe(true);
    expect(
      model?.artifacts.find((artifact) => artifact.role === 'transcription_model'),
    ).toMatchObject({
      filename: 'encoder.int8.onnx',
      sha256: '7d932213491ad355c6e5576705dc3494731a52af87d7a1b954559340147909d8',
    });
  });

  it('adds the 160 ms multilingual profile while retaining the existing 560 ms install identity', () => {
    const previous = catalog.models.find(
      (item) => item.modelId === 'nemotron_asr_0_6b_int8_streaming_560ms',
    );
    const lowLatency = catalog.models.find(
      (item) => item.modelId === 'nemotron_asr_0_6b_int8_streaming_160ms',
    );
    expect(lowLatency).toMatchObject({
      familyId: 'nemotron_asr',
      supportsAutomaticLanguageDetection: true,
      languageTags: previous?.languageTags,
      licenseLabel: 'OpenMDW-1.1',
    });
    expect(
      lowLatency?.artifacts.find((artifact) => artifact.role === 'transcription_model'),
    ).toMatchObject({
      filename: 'encoder.int8.onnx',
      sha256: 'e1b39e5e16bef578a54ed2fba5f031438e000cc36c3ea2ca49d55699d5baebd4',
    });
    expect(
      previous?.artifacts.find((artifact) => artifact.role === 'transcription_model')?.sha256,
    ).toBe('012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68');
    for (const artifact of lowLatency?.artifacts.filter(
      (item) => item.role !== 'transcription_model',
    ) ?? []) {
      expect(artifact.sha256).toBe(
        previous?.artifacts.find((item) => item.filename === artifact.filename)?.sha256,
      );
    }
  });
});
