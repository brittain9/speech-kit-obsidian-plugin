import { describe, expect, it } from 'vitest';

import catalog from '../native/catalog.json';

describe('compact multilingual Whisper catalog choice', () => {
  it('provides a separate hash-pinned multilingual Small model without changing existing English choices', () => {
    const model = catalog.models.find((candidate) => candidate.modelId === 'whisper_small_q5_1');
    expect(model?.familyId).toBe('whisper');
    expect(model?.languageTags).toEqual([
      'en',
      'es',
      'de',
      'fr',
      'pt',
      'it',
      'nl',
      'ja',
      'hr',
      'sr',
    ]);
    expect(model?.supportsAutomaticLanguageDetection).toBe(true);
    expect(model?.artifacts).toEqual([
      expect.objectContaining({
        filename: 'ggml-small-q5_1.bin',
        role: 'transcription_model',
        required: true,
        sizeBytes: 190_085_487,
        sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
      }),
    ]);
    expect(
      catalog.models.find((candidate) => candidate.modelId === 'whisper_small_en_q5_1')
        ?.languageTags,
    ).toEqual(['en']);
  });
});
