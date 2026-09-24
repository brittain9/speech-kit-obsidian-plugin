import { describe, expect, it } from 'vitest';

import bundledCatalog from '../native/catalog.json';
import type { CatalogModelRecord, ModelCatalogRecord } from '../src/models/model-management-types';
import {
  type FirstRunHardwareProfile,
  readFirstRunHardwareProfile,
  resolveStartingModelRecommendation,
} from '../src/setup/first-run-model-guidance';

const constrainedHardware: FirstRunHardwareProfile = {
  hardwareClass: 'constrained',
  logicalProcessorCount: 2,
  memoryGb: 4,
};

function largeMultilingualModel(): CatalogModelRecord {
  return {
    artifacts: [
      {
        artifactId: 'model',
        downloadUrl: 'https://example.com/model',
        filename: 'model.onnx',
        required: true,
        role: 'transcription_model',
        sha256: '0'.repeat(64),
        sizeBytes: 700 * 1024 * 1024,
      },
    ],
    collectionId: 'nemotron_asr_streaming',
    displayName: 'Large multilingual model',
    familyId: 'nemotron_asr',
    languageTags: ['es'],
    supportsAutomaticLanguageDetection: false,
    licenseLabel: 'OpenMDW-1.1',
    licenseUrl: 'https://example.com/license',
    modelCardUrl: null,
    modelId: 'large-multilingual',
    notes: [],
    runtimeId: 'onnx_runtime',
    sourceUrl: 'https://example.com/source',
    summary: 'Large model',
    task: 'stt',
    uxTags: ['streaming', 'accuracy'],
  };
}

describe('first-run model guidance', () => {
  it('reports only the hardware hints that are actually available', () => {
    expect(readFirstRunHardwareProfile({ hardwareConcurrency: 2 })).toMatchObject({
      hardwareClass: 'constrained',
      hardwareEvidence: 'processor',
      memoryGb: null,
    });
    expect(readFirstRunHardwareProfile({ deviceMemory: 8 })).toMatchObject({
      hardwareClass: 'standard',
      hardwareEvidence: 'memory',
      logicalProcessorCount: null,
    });
    expect(readFirstRunHardwareProfile({})).toMatchObject({
      hardwareClass: 'unknown',
      hardwareEvidence: 'none',
    });
  });

  it('does not describe a demanding multilingual model as a lower-power choice', () => {
    const model = largeMultilingualModel();
    const recommendation = resolveStartingModelRecommendation(
      {
        catalog: {
          catalogVersion: 1,
          collections: [],
          families: [],
          models: [model],
        },
        compiledAdapters: [
          {
            displayName: 'ASR',
            familyCapabilities: {
              availableVoices: [],
              maxAudioDurationSecs: null,
              outputSampleRate: null,
              producesPunctuation: true,
              supportsHardwareAcceleration: false,
              supportedLanguages: { kind: 'list', tags: ['es'] },
              supportsAutomaticLanguageDetection: false,
              supportsInitialPrompt: false,
              supportsLanguageSelection: true,
              supportsSegmentTimestamps: false,
              supportsSpeedControl: false,
              supportsStreaming: true,
              supportsWordTimestamps: false,
              task: 'stt',
            },
            familyId: 'nemotron_asr',
            runtimeId: 'onnx_runtime',
          },
        ],
      },
      'es',
      constrainedHardware,
    );

    expect(recommendation).toMatchObject({
      hardwareEvidence: 'both',
      liveChoiceIsOnly: true,
      model: { modelId: 'large-multilingual' },
      resourceClass: 'demanding',
    });
  });

  it('treats the bundled Moonshine Tiny entry as the compact live choice', () => {
    const tiny = bundledCatalog.models.find(
      (model) => model.modelId === 'moonshine_tiny_streaming_en',
    );
    if (tiny === undefined) throw new Error('Expected bundled Moonshine Tiny model');

    const recommendation = resolveStartingModelRecommendation(
      {
        catalog: bundledCatalog as unknown as ModelCatalogRecord,
        compiledAdapters: [
          {
            displayName: 'Moonshine',
            familyCapabilities: {
              availableVoices: [],
              maxAudioDurationSecs: null,
              outputSampleRate: null,
              producesPunctuation: true,
              supportsHardwareAcceleration: false,
              supportedLanguages: { kind: 'list', tags: ['en'] },
              supportsAutomaticLanguageDetection: false,
              supportsInitialPrompt: false,
              supportsLanguageSelection: true,
              supportsSegmentTimestamps: false,
              supportsSpeedControl: false,
              supportsStreaming: true,
              supportsWordTimestamps: false,
              task: 'stt',
            },
            familyId: 'moonshine',
            runtimeId: 'onnx_runtime',
          },
        ],
      },
      'en',
      constrainedHardware,
    );

    expect(tiny.uxTags).toContain('lightweight');
    expect(recommendation).toMatchObject({
      model: { modelId: 'moonshine_tiny_streaming_en' },
      mode: 'live',
      resourceClass: 'standard',
    });
  });
});
