import { describe, expect, it } from 'vitest';

import {
  chooseDefaultMediaTranscriptionModel,
  getMediaTranscriptionModelOptions,
  type MediaTranscriptionModelOption,
} from '../src/media/media-transcription-options';
import type { ModelManagerState } from '../src/models/model-install-manager';
import type { CatalogModelRecord } from '../src/models/model-management-types';

function model(familyId: 'moonshine' | 'whisper', modelId: string): MediaTranscriptionModelOption {
  return {
    capabilities: {
      family: {
        availableVoices: [],
        maxAudioDurationSecs: null,
        outputSampleRate: null,
        producesPunctuation: true,
        supportedLanguages: { kind: 'all' },
        supportsAutomaticLanguageDetection: true,
        supportsHardwareAcceleration: false,
        supportsInitialPrompt: false,
        supportsLanguageSelection: true,
        supportsSegmentTimestamps: true,
        supportsSpeedControl: false,
        supportsStreaming: false,
        supportsWordTimestamps: true,
        task: 'stt',
      },
      familyId,
      runtime: {
        acceleratorDetails: {},
        availableAccelerators: ['cpu'],
        supportedModelFormats: ['ggml'],
      },
      runtimeId: familyId === 'whisper' ? 'whisper_cpp' : 'onnx_runtime',
    },
    label: modelId,
    selection: {
      familyId,
      kind: 'catalog_model',
      modelId,
      runtimeId: familyId === 'whisper' ? 'whisper_cpp' : 'onnx_runtime',
    },
  };
}

describe('media transcription model defaults', () => {
  it('keeps the selected model when it supports batch transcription', () => {
    const selected = model('moonshine', 'moonshine-small');
    const whisper = model('whisper', 'whisper-large-v3-turbo');

    expect(chooseDefaultMediaTranscriptionModel([whisper, selected], selected.selection)).toBe(
      selected,
    );
  });

  it('prefers Whisper when the selected dictation model is unavailable for batch work', () => {
    const whisper = model('whisper', 'whisper-large-v3-turbo');

    expect(
      chooseDefaultMediaTranscriptionModel([model('moonshine', 'moonshine-small'), whisper], null),
    ).toBe(whisper);
  });

  it('returns no model when no installed compatible batch model exists', () => {
    expect(chooseDefaultMediaTranscriptionModel([], null)).toBeNull();
  });

  it('filters catalog models by their exact language support', () => {
    const base = catalogModel('whisper_base_en_q8_0', ['en'], false, 'Whisper Base');
    const large = catalogModel(
      'whisper_large_v3_turbo_q8_0',
      ['en', 'ja'],
      true,
      'Whisper Large V3 Turbo',
    );
    const state = modelManagerState([base, large]);

    expect(getMediaTranscriptionModelOptions(state, 'auto').map((option) => option.label)).toEqual([
      'Whisper Large V3 Turbo',
    ]);
    expect(getMediaTranscriptionModelOptions(state, 'en').map((option) => option.label)).toEqual([
      'Whisper Base',
      'Whisper Large V3 Turbo',
    ]);
  });
});

function catalogModel(
  modelId: string,
  languageTags: string[],
  supportsAutomaticLanguageDetection: boolean,
  displayName: string,
): CatalogModelRecord {
  return {
    artifacts: [],
    collectionId: 'test',
    displayName,
    familyId: 'whisper',
    languageTags,
    supportsAutomaticLanguageDetection,
    licenseLabel: 'MIT',
    licenseUrl: 'https://example.test/license',
    modelCardUrl: null,
    modelId,
    notes: [],
    runtimeId: 'whisper_cpp',
    task: 'stt',
    sourceUrl: 'https://example.test/model',
    summary: '',
    uxTags: [],
  };
}

function modelManagerState(models: CatalogModelRecord[]): ModelManagerState {
  const familyCapabilities = model('whisper', 'family-capabilities').capabilities.family;
  const installedModels = models.map(({ modelId }) => ({
    catalogVersion: 1,
    familyId: 'whisper' as const,
    installPath: `/models/${modelId}`,
    installedAtUnixMs: 0,
    installedArtifactIds: ['transcription'],
    modelId,
    runtimeId: 'whisper_cpp' as const,
    runtimePath: null,
    totalSizeBytes: 1,
    installedVoiceIds: [],
  }));

  return {
    activeInstall: null,
    catalog: { catalogVersion: 1, collections: [], families: [], models },
    compiledAdapters: [
      {
        displayName: 'Whisper',
        familyCapabilities,
        familyId: 'whisper',
        runtimeId: 'whisper_cpp',
      },
    ],
    compiledRuntimes: [
      {
        displayName: 'Whisper.cpp',
        runtimeCapabilities: {
          acceleratorDetails: {},
          availableAccelerators: ['cpu'],
          supportedModelFormats: ['ggml'],
        },
        runtimeId: 'whisper_cpp',
      },
    ],
    failedInstall: null,
    installedModels,
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: null,
    selectedModelCapabilities: { status: 'none' },
    selectedTtsModel: null,
    selectedTtsModelCapabilities: { status: 'none' },
    selectedTranslationModel: null,
  };
}
