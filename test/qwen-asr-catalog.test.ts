import { describe, expect, it } from 'vitest';
import catalog from '../native/catalog.json';
import { isModelFamilyId, isSelectedModel } from '../src/models/model-management-types';
import { resolvePluginSettings } from '../src/settings/plugin-settings';

const selection = {
  kind: 'catalog_model',
  runtimeId: 'llama_cpp',
  familyId: 'qwen3_asr',
  modelId: 'qwen3_asr_0_6b_q8_0',
} as const;

describe('managed Qwen3 ASR choice', () => {
  it('accepts the native family contract and preserves the selected optional model', () => {
    expect(isModelFamilyId(selection.familyId)).toBe(true);
    expect(isSelectedModel(selection)).toBe(true);
    expect(resolvePluginSettings({ selectedModel: selection }).selectedModel).toEqual(selection);
    expect(
      resolvePluginSettings({ selectedModel: { ...selection, familyId: 'unknown_asr' } })
        .selectedModel,
    ).toBeNull();
  });

  it('offers the reviewed required decoder/projector pair with honest batch language support', () => {
    const model = catalog.models.find((entry) => entry.modelId === selection.modelId);
    expect(model).toMatchObject({
      runtimeId: 'llama_cpp',
      familyId: 'qwen3_asr',
      task: 'stt',
      supportsAutomaticLanguageDetection: true,
      languageTags: ['en', 'es', 'de', 'fr', 'pt', 'it', 'nl', 'ja'],
    });
    expect(model?.artifacts).toEqual([
      expect.objectContaining({
        artifactId: 'transcription',
        role: 'transcription_model',
        required: true,
        filename: 'Qwen3-ASR-0.6B-Q8_0.gguf',
        sizeBytes: 804749248,
        sha256: 'bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971',
      }),
      expect.objectContaining({
        artifactId: 'audio_encoder',
        role: 'supporting_file',
        required: true,
        filename: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf',
        sizeBytes: 214392480,
        sha256: '41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d',
      }),
    ]);
    expect(model?.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)).toBe(
      1019141728,
    );
    expect(
      model?.artifacts.every((artifact) =>
        artifact.downloadUrl.includes('/resolve/928ab958557df9aa2ef1c93e0e83c7ad0933fae2/'),
      ),
    ).toBe(true);
    expect(catalog.families.find((family) => family.familyId === 'qwen3_asr')).toMatchObject({
      runtimeId: 'llama_cpp',
      task: 'stt',
    });
    expect(model?.notes.join(' ')).toContain('Batch transcription');
    expect(model?.notes.join(' ')).toContain('timestamps');
    expect(resolvePluginSettings({}).selectedModel).toBeNull();
  });
});

it('offers the larger Qwen pair without replacing the existing selection or defaults', () => {
  const largerSelection = { ...selection, modelId: 'qwen3_asr_1_7b_q8_0' };
  const model = catalog.models.find((entry) => entry.modelId === largerSelection.modelId);
  expect(model).toMatchObject({
    displayName: 'Qwen3 ASR 1.7B Q8',
    runtimeId: 'llama_cpp',
    familyId: 'qwen3_asr',
    task: 'stt',
    supportsAutomaticLanguageDetection: true,
    languageTags: ['en', 'es', 'de', 'fr', 'pt', 'it', 'nl', 'ja'],
  });
  expect(model?.artifacts).toEqual([
    expect.objectContaining({
      artifactId: 'transcription',
      role: 'transcription_model',
      required: true,
      filename: 'Qwen3-ASR-1.7B-Q8_0.gguf',
      sizeBytes: 2165034944,
      sha256: '58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57',
    }),
    expect.objectContaining({
      artifactId: 'audio_encoder',
      role: 'supporting_file',
      required: true,
      filename: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
      sizeBytes: 355709344,
      sha256: '46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d',
    }),
  ]);
  expect(model?.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)).toBe(2520744288);
  expect(
    model?.artifacts.every((artifact) =>
      artifact.downloadUrl.includes('/resolve/36a678687ba7d07a74ca70ccb0e36902e005fb80/'),
    ),
  ).toBe(true);
  expect(model?.notes.join(' ')).toContain('no live partial text or model timestamps');
  expect(resolvePluginSettings({ selectedModel: selection }).selectedModel).toEqual(selection);
  expect(resolvePluginSettings({ selectedModel: largerSelection }).selectedModel).toEqual(
    largerSelection,
  );
  expect(resolvePluginSettings({}).selectedModel).toBeNull();
});
