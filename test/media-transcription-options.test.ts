import { describe, expect, it } from 'vitest';

import {
  chooseDefaultMediaTranscriptionModel,
  type MediaTranscriptionModelOption,
} from '../src/media/media-transcription-options';

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
});
