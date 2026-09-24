import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LLM_BUILTIN_PRESET_ID,
  getLlmBuiltinPreset,
  type LlmPreset,
} from '../src/llm/presets';
import {
  DEFAULT_PLUGIN_SETTINGS,
  DEFAULT_SMART_PARAGRAPH_LINE_BREAK_PAUSE_MS,
  DEFAULT_SMART_PARAGRAPH_PARAGRAPH_PAUSE_MS,
  LLM_USER_PRESET_MAX_COUNT,
  LLM_USER_PRESET_MAX_DESCRIPTION_CHARS,
  LLM_USER_PRESET_MAX_LABEL_CHARS,
  MAX_SMART_PARAGRAPH_PAUSE_MS,
  MIN_SMART_PARAGRAPH_PAUSE_MS,
  resetLlmPostprocessDefaults,
  resolvePluginSettings,
  resolveTranslationStyleInstruction,
  TRANSLATION_STYLE_INSTRUCTION_MAX_CHARS,
  validateTimestampIntervalSeconds,
} from '../src/settings/plugin-settings';

function makeUserPreset(overrides: Partial<LlmPreset> & { id: string }): LlmPreset {
  return {
    label: `Style ${overrides.id}`,
    output: 'replace',
    prompt: 'Clean it my way.',
    ...overrides,
  };
}

describe('resolvePluginSettings', () => {
  it('returns defaults when persisted data is missing', () => {
    expect(resolvePluginSettings(undefined)).toEqual(DEFAULT_PLUGIN_SETTINGS);
  });

  it('enables read-aloud follow-along highlighting by default and normalizes invalid values', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.highlightSpokenText).toBe(true);
    expect(resolvePluginSettings({}).highlightSpokenText).toBe(true);
    expect(resolvePluginSettings({ highlightSpokenText: false }).highlightSpokenText).toBe(false);
    expect(resolvePluginSettings({ highlightSpokenText: 'no' }).highlightSpokenText).toBe(true);
  });

  it('distinguishes a fresh install from an existing vault with missing routing data', () => {
    expect(resolvePluginSettings(null).llmRoutingPolicy).toBeNull();
    expect(resolvePluginSettings({}).llmRoutingPolicy).toEqual({
      kind: 'fixed',
      providerId: 'ollama',
    });
    expect(
      resolvePluginSettings({ llmRoutingPolicy: null, schemaVersion: 7 }).llmRoutingPolicy,
    ).toBeNull();
  });

  it('migrates every supported prior schema to schema 12', () => {
    for (let schemaVersion = 1; schemaVersion < 12; schemaVersion += 1) {
      const settings = resolvePluginSettings({ schemaVersion });
      expect(settings.schemaVersion).toBe(12);
      expect(settings.personalCorrectionRules).toEqual([]);
    }
    expect(resolvePluginSettings({ schemaVersion: 11 }).schemaVersion).toBe(12);
    expect(resolvePluginSettings({ schemaVersion: 12 }).schemaVersion).toBe(12);
    expect(resolvePluginSettings({ schemaVersion: 99 }).schemaVersion).toBe(99);
  });

  it('defaults and normalizes HY-MT2 translation styles', () => {
    expect(resolvePluginSettings({}).translationStyle).toBe('default');
    expect(resolvePluginSettings({}).translationStyleInstruction).toBe('');
    expect(resolvePluginSettings({ translationStyle: 'formal' }).translationStyle).toBe('formal');
    expect(resolvePluginSettings({ translationStyle: 'unexpected' }).translationStyle).toBe(
      'default',
    );
    expect(
      resolvePluginSettings({ translationStyleInstruction: '  formal\n  use usted  ' })
        .translationStyle,
    ).toBe('custom');
    expect(
      resolvePluginSettings({ translationStyleInstruction: '  formal\n  use usted  ' })
        .translationStyleInstruction,
    ).toBe('formal\n  use usted');
    expect(
      resolvePluginSettings({ translationStyleInstruction: 42 }).translationStyleInstruction,
    ).toBe('');
    expect(
      resolvePluginSettings({ translationStyleInstruction: 'x'.repeat(600) })
        .translationStyleInstruction,
    ).toHaveLength(TRANSLATION_STYLE_INSTRUCTION_MAX_CHARS);
    expect(resolveTranslationStyleInstruction('default', 'ignored')).toBe('');
    expect(resolveTranslationStyleInstruction('formal', '')).toContain('formal register');
    expect(resolveTranslationStyleInstruction('casual', '')).toContain('casual, conversational');
    expect(resolveTranslationStyleInstruction('custom', '  use European Portuguese  ')).toBe(
      'use European Portuguese',
    );
  });

  it('migrates missing or invalid dictation language to English', () => {
    expect(resolvePluginSettings({}).dictationLanguage).toBe('en');
    expect(resolvePluginSettings({ dictationLanguage: 'ja' }).dictationLanguage).toBe('ja');
    expect(resolvePluginSettings({ dictationLanguage: 'xx' }).dictationLanguage).toBe('en');
  });

  it('keeps the reading language independent and defaults it to the model', () => {
    expect(resolvePluginSettings({ dictationLanguage: 'es' }).readAloudLanguage).toBe('auto');
    expect(resolvePluginSettings({ readAloudLanguage: 'fr' }).readAloudLanguage).toBe('fr');
    expect(resolvePluginSettings({ readAloudLanguage: 'xx' }).readAloudLanguage).toBe('auto');
  });

  it('tolerantly reads supported translation language preferences', () => {
    expect(
      resolvePluginSettings({
        translationSourceLanguage: ' FR ',
        translationTargetLanguage: 'en',
      }),
    ).toMatchObject({
      translationSourceLanguage: 'fr',
      translationTargetLanguage: 'en',
    });
    expect(
      resolvePluginSettings({
        translationSourceLanguage: 'xx',
        translationTargetLanguage: 42,
      }),
    ).toMatchObject({
      translationSourceLanguage: null,
      translationTargetLanguage: null,
    });
  });

  it('does not infer a translation model from obsolete persisted engine preferences', () => {
    expect(resolvePluginSettings({}).selectedTranslationModel).toBeNull();
    expect(
      resolvePluginSettings({ translationEngineId: 'tencent_hy_mt' }).selectedTranslationModel,
    ).toBeNull();
  });

  it('normalizes a remembered Obsidian language to its base tag', () => {
    expect(resolvePluginSettings({ lastObsidianLanguage: ' PT_br ' }).lastObsidianLanguage).toBe(
      'pt',
    );
    expect(resolvePluginSettings({ lastObsidianLanguage: '' }).lastObsidianLanguage).toBeNull();
    expect(resolvePluginSettings({ lastObsidianLanguage: 42 }).lastObsidianLanguage).toBeNull();
  });

  it('enables LLM capabilities but keeps transformation off by default', () => {
    expect(DEFAULT_PLUGIN_SETTINGS).toMatchObject({
      llmFeaturesEnabled: true,
      llmPostprocessActivePresetRef: `builtin:${DEFAULT_LLM_BUILTIN_PRESET_ID}`,
      llmPostprocessMode: 'off',
      llmPostprocessUserPresets: [],
      llmRoutingPolicy: null,
    });
  });

  it('defaults speaker diarization off and honors a persisted boolean', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.diarizationEnabled).toBe(false);
    expect(DEFAULT_PLUGIN_SETTINGS.diarizationMaxSpeakers).toBeNull();
    expect(resolvePluginSettings({ diarizationEnabled: true }).diarizationEnabled).toBe(true);
    expect(resolvePluginSettings({ diarizationEnabled: 'yes' }).diarizationEnabled).toBe(false);
  });

  it('accepts automatic or bounded maximum speaker counts', () => {
    expect(
      resolvePluginSettings({ diarizationMaxSpeakers: null }).diarizationMaxSpeakers,
    ).toBeNull();
    expect(resolvePluginSettings({ diarizationMaxSpeakers: 2 }).diarizationMaxSpeakers).toBe(2);
    expect(resolvePluginSettings({ diarizationMaxSpeakers: 0 }).diarizationMaxSpeakers).toBeNull();
    expect(resolvePluginSettings({ diarizationMaxSpeakers: 99 }).diarizationMaxSpeakers).toBeNull();
    expect(
      resolvePluginSettings({ diarizationMaxSpeakers: '2' }).diarizationMaxSpeakers,
    ).toBeNull();
  });

  it('retains the last utterance by default and honors only a persisted boolean opt-out', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.retainLastUtterance).toBe(true);
    expect(resolvePluginSettings({ retainLastUtterance: false }).retainLastUtterance).toBe(false);
    expect(resolvePluginSettings({ retainLastUtterance: 'no' }).retainLastUtterance).toBe(true);
  });

  it('defaults finalized-utterance auto-copy off and honors only a persisted boolean opt-in', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.autoCopyFinalizedUtterances).toBe(false);
    expect(resolvePluginSettings({}).autoCopyFinalizedUtterances).toBe(false);
    expect(
      resolvePluginSettings({ autoCopyFinalizedUtterances: true }).autoCopyFinalizedUtterances,
    ).toBe(true);
    expect(
      resolvePluginSettings({ autoCopyFinalizedUtterances: 'yes' }).autoCopyFinalizedUtterances,
    ).toBe(false);
    expect(resolvePluginSettings({ autoCopyFinalizedUtterances: true }).schemaVersion).toBe(12);
  });

  it('migrates personal correction rules without resetting other settings', () => {
    const rules = [{ enabled: true, find: 'Speech Kit', id: 'rule-1', replace: 'Speech Kit' }];
    const settings = resolvePluginSettings({
      autoCopyFinalizedUtterances: true,
      personalCorrectionRules: rules,
      schemaVersion: 10,
      selectedModel: {
        familyId: 'whisper',
        filePath: '/tmp/model.bin',
        kind: 'external_file',
        runtimeId: 'whisper_cpp',
      },
    });

    expect(settings.schemaVersion).toBe(12);
    expect(settings.personalCorrectionRules).toEqual(rules);
    expect(settings.autoCopyFinalizedUtterances).toBe(true);
    expect(settings.selectedModel).toEqual({
      familyId: 'whisper',
      filePath: '/tmp/model.bin',
      kind: 'external_file',
      runtimeId: 'whisper_cpp',
    });
  });

  it('preserves unknown top-level and rule fields while migrating supported schemas', () => {
    const settings = resolvePluginSettings({
      schemaVersion: 4,
      futureTopLevel: { keep: true },
      personalCorrectionRules: [
        {
          enabled: true,
          find: 'cat',
          futureRuleField: 'keep',
          id: 'rule-1',
          replace: 'dog',
        },
      ],
    });
    expect((settings as unknown as Record<string, unknown>).futureTopLevel).toEqual({ keep: true });
    expect(
      (settings.personalCorrectionRules[0] as unknown as Record<string, unknown>).futureRuleField,
    ).toBe('keep');
  });

  it('omits malformed persisted correction rules but preserves repair diagnostics', () => {
    const settings = resolvePluginSettings({
      personalCorrectionRules: [
        { enabled: true, find: 'ok', id: 'valid', replace: 'yes' },
        { enabled: true, find: ' ', id: 'blank', replace: 'yes' },
        { enabled: true, find: 'ok', id: 'duplicate', replace: 'no' },
      ],
    });

    expect(settings.personalCorrectionRules).toEqual([
      { enabled: true, find: 'ok', id: 'valid', replace: 'yes' },
    ]);
    expect(settings.personalCorrectionRuleDiagnostics).toMatchObject([
      { code: 'blank_find', field: 'find', index: 1 },
      { code: 'duplicate_find', field: 'find', index: 2 },
    ]);
  });

  it.each([11, 12])(
    'keeps sessions recoverable when schema %s contains non-object rules',
    (schemaVersion) => {
      const settings = resolvePluginSettings({
        personalCorrectionRules: [
          null,
          42,
          [],
          { enabled: true, find: 'ok', id: 'valid', replace: 'yes' },
        ],
        schemaVersion,
      });

      expect(settings.schemaVersion).toBe(12);
      expect(settings.personalCorrectionRules).toHaveLength(1);
      expect(settings.personalCorrectionRuleDiagnostics).toMatchObject([
        { code: 'invalid_rule', raw: null },
        { code: 'invalid_rule', raw: 42 },
        { code: 'invalid_rule', raw: [] },
      ]);
    },
  );

  it('retains the first 100 valid rules and diagnoses overflow with original indexes', () => {
    const valid = Array.from({ length: 101 }, (_, index) => ({
      enabled: true,
      find: `find-${index}`,
      id: `rule-${index}`,
      replace: `replace-${index}`,
    }));
    const settings = resolvePluginSettings({
      personalCorrectionRules: [null, ...valid],
      schemaVersion: 12,
    });

    expect(settings.personalCorrectionRules).toHaveLength(100);
    expect(settings.personalCorrectionRules.at(-1)?.id).toBe('rule-99');
    expect(settings.personalCorrectionRuleDiagnostics).toMatchObject([
      { code: 'invalid_rule', index: 0 },
      { code: 'too_many_rules', field: 'rules', index: 101 },
    ]);
    expect(settings.personalCorrectionRuleOrder).toHaveLength(102);
  });

  it('retains repair diagnostics after active rules have been normalized', () => {
    const settings = resolvePluginSettings({
      personalCorrectionRuleDiagnostics: [
        {
          code: 'blank_find',
          field: 'find',
          index: 1,
          message: 'Find text cannot be blank.',
          raw: { enabled: true, find: ' ', id: 'repair-me', replace: 'value' },
        },
      ],
      personalCorrectionRules: [{ enabled: true, find: 'ok', id: 'valid', replace: 'yes' }],
      schemaVersion: 12,
    });

    expect(settings.personalCorrectionRules).toHaveLength(1);
    expect(settings.personalCorrectionRuleDiagnostics).toMatchObject([
      { code: 'blank_find', index: 1, raw: { id: 'repair-me' } },
    ]);
  });

  it('infers old normalized order from diagnostic indexes when no order is persisted', () => {
    const settings = resolvePluginSettings({
      personalCorrectionRuleDiagnostics: [
        {
          code: 'blank_find',
          field: 'find',
          index: 1,
          message: 'Find text cannot be blank.',
          raw: { enabled: true, find: ' ', id: 'repair-b', replace: 'd' },
        },
      ],
      personalCorrectionRules: [
        { enabled: true, find: 'a', id: 'a', replace: 'b' },
        { enabled: true, find: 'c', id: 'c', replace: 'd' },
      ],
      schemaVersion: 12,
    });

    expect(settings.personalCorrectionRuleOrder).toEqual([
      { index: 0, kind: 'active' },
      { index: 1, kind: 'invalid' },
      { index: 2, kind: 'active' },
    ]);
  });

  it('preserves newer schema fields and diagnoses a non-array rule container', () => {
    const settings = resolvePluginSettings({
      futureCorrectionField: { keep: true },
      personalCorrectionRules: { not: 'an array' },
      schemaVersion: 99,
    });

    expect(settings.schemaVersion).toBe(99);
    expect((settings as unknown as Record<string, unknown>).futureCorrectionField).toEqual({
      keep: true,
    });
    expect(settings.personalCorrectionRules).toEqual([]);
    expect(settings.personalCorrectionRuleDiagnostics).toMatchObject([
      { code: 'invalid_rule', field: 'rules', index: 0 },
    ]);
  });

  it('migrates legacy speaker label setting to diarization', () => {
    expect(resolvePluginSettings({ speakerLabelsEnabled: true }).diarizationEnabled).toBe(true);
    expect(
      resolvePluginSettings({ diarizationEnabled: false, speakerLabelsEnabled: true })
        .diarizationEnabled,
    ).toBe(false);
  });

  it('merges valid persisted values', () => {
    expect(
      resolvePluginSettings({
        accelerationPreference: 'cpu_only',
        cudaLibraryPath: ' /run/host/usr/lib64 ',
        dictationAnchor: 'end_of_note',
        listeningMode: 'always_on',
        llmFeaturesEnabled: false,
        llmNetworkTimeoutSec: 90,
        llmPostprocessMode: 'batch',
        llmPostprocessNoteContextChars: 4000,
        llmPostprocessPriorUtterancesN: 3,
        llmPostprocessShowRawBelow: true,
        llmPostprocessSkipMinWords: 6,
        llmPostprocessTemperature: 0.4,
        llmPostprocessTotalContextCap: 9000,
        llmProviderConfigurations: {
          ollama: { model: ' llama3.2:latest ' },
          openrouter: {
            model: ' anthropic/claude-sonnet-4.5 ',
            secretId: ' openrouter-secret ',
          },
          openai_compatible: {
            baseUrl: ' http://localhost:1234/v1/ ',
            model: ' local-model ',
            secretId: ' custom-secret ',
          },
        },
        llmRoutingPolicy: {
          defaultProviderId: 'ollama',
          kind: 'transcript_size',
          largeTranscriptProviderId: 'openrouter',
          thresholdChars: 8000,
        },
        localTranscriptSidebarBootstrapped: true,
        modelStorePathOverride: ' /tmp/models ',
        selectedModel: {
          familyId: 'whisper',
          kind: 'catalog_model',
          modelId: 'whisper_large_v3_turbo_q8_0',
          runtimeId: 'whisper_cpp',
        },
        sidecarPathOverride: ' /tmp/sidecar ',
        sidecarRequestTimeoutSeconds: 12,
        sidecarStartupTimeoutSeconds: 6,
        smartParagraphLineBreakPauseMs: 1500,
        smartParagraphParagraphPauseMs: 4500,
        speakingStyle: 'patient',
        timestampClock: 'wallclock',
        timestampDensity: 'every_utterance',
        timestampsEnabled: true,
        timestampSessionHeader: false,
        timestampSparseIntervalMs: 60_000,
        transcriptFormatting: 'new_paragraph',
        useNoteAsContext: false,
      }),
    ).toEqual({
      ...DEFAULT_PLUGIN_SETTINGS,
      accelerationPreference: 'cpu_only',
      cudaLibraryPath: '/run/host/usr/lib64',
      dictationAnchor: 'end_of_note',
      listeningMode: 'always_on',
      llmFeaturesEnabled: false,
      llmNetworkTimeoutSec: 90,
      // Seeded from the stored mode (no explicit value persisted).
      llmPostprocessLastEnabledMode: 'batch',
      llmPostprocessMode: 'batch',
      llmPostprocessNoteContextChars: 4000,
      llmPostprocessPriorUtterancesN: 3,
      llmPostprocessShowRawBelow: true,
      llmPostprocessSkipMinWords: 6,
      llmPostprocessTemperature: 0.4,
      llmPostprocessTotalContextCap: 9000,
      llmProviderConfigurations: {
        ollama: { model: 'llama3.2:latest' },
        openrouter: {
          model: 'anthropic/claude-sonnet-4.5',
          secretId: 'openrouter-secret',
        },
        openai_compatible: {
          baseUrl: 'http://localhost:1234/v1',
          model: 'local-model',
          secretId: 'custom-secret',
        },
      },
      llmRoutingPolicy: {
        defaultProviderId: 'ollama',
        kind: 'transcript_size',
        largeTranscriptProviderId: 'openrouter',
        thresholdChars: 8000,
      },
      localTranscriptSidebarBootstrapped: true,
      modelStorePathOverride: '/tmp/models',
      selectedModel: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
      sidecarPathOverride: '/tmp/sidecar',
      sidecarRequestTimeoutSeconds: 12,
      sidecarStartupTimeoutSeconds: 6,
      smartParagraphLineBreakPauseMs: 1500,
      smartParagraphParagraphPauseMs: 4500,
      speakingStyle: 'patient',
      timestampClock: 'wallclock',
      timestampDensity: 'every_utterance',
      timestampsEnabled: true,
      timestampSessionHeader: false,
      timestampSparseIntervalMs: 60_000,
      transcriptFormatting: 'new_paragraph',
      useNoteAsContext: false,
    });
  });

  it.each(['at_cursor', 'end_of_note'] as const)(
    'accepts the supported dictation anchor %s',
    (dictationAnchor) => {
      expect(resolvePluginSettings({ dictationAnchor }).dictationAnchor).toBe(dictationAnchor);
    },
  );

  it.each(['smart', 'space', 'new_line', 'new_paragraph'] as const)(
    'accepts the supported transcript formatting mode %s',
    (transcriptFormatting) => {
      expect(resolvePluginSettings({ transcriptFormatting }).transcriptFormatting).toBe(
        transcriptFormatting,
      );
    },
  );

  it('falls back when persisted values are invalid', () => {
    expect(
      resolvePluginSettings({
        dictationAnchor: 'at_end',
        listeningMode: 'unsupported',
        llmFeaturesEnabled: 'yes',
        llmOpenRouterSecretId: 'Invalid secret ID',
        llmRemoteFeaturesEnabled: 'yes',
        llmPostprocessMode: 'later',
        llmPostprocessPrompt: '',
        llmProviderModels: 'llama3',
        llmRemoteThresholdChars: 'soon',
        llmRouting: 'claude',
        localTranscriptSidebarBootstrapped: 'yes',
        modelStorePathOverride: 42,
        sidecarPathOverride: 12,
        sidecarRequestTimeoutSeconds: -1,
        sidecarStartupTimeoutSeconds: 'fast',
        smartParagraphLineBreakPauseMs: 'soon',
        smartParagraphParagraphPauseMs: 'later',
        timestampClock: 'date',
        timestampDensity: 'always',
        timestampsEnabled: 'yes',
        timestampSessionHeader: 'yes',
        timestampSparseIntervalMs: 'soon',
        transcriptFormatting: 'tab',
        useNoteAsContext: 'yes',
      }),
    ).toMatchObject({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmOpenRouterSecretId: 'Invalid secret ID',
      llmProviderModels: 'llama3',
      llmRemoteFeaturesEnabled: 'yes',
      llmRemoteThresholdChars: 'soon',
      llmRouting: 'claude',
      llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
    });
  });

  it('round-trips a well-formed selectedModelCapabilitiesSnapshot', () => {
    const selection = {
      familyId: 'whisper' as const,
      kind: 'catalog_model' as const,
      modelId: 'whisper_large_v3_turbo_q8_0',
      runtimeId: 'whisper_cpp' as const,
    };
    const capabilities = {
      family: {
        availableVoices: [],
        maxAudioDurationSecs: null,
        outputSampleRate: null,
        producesPunctuation: true,
        supportsHardwareAcceleration: true,
        supportedLanguages: { kind: 'all' as const },
        supportsInitialPrompt: true,
        supportsSpeedControl: false,
        supportsLanguageSelection: true,
        supportsAutomaticLanguageDetection: true,
        supportsSegmentTimestamps: true,
        supportsStreaming: false,
        supportsWordTimestamps: false,
        task: 'stt' as const,
      },
      familyId: 'whisper' as const,
      runtime: {
        acceleratorDetails: { cpu: { available: true, unavailableReason: null } },
        availableAccelerators: ['cpu' as const],
        supportedModelFormats: ['ggml' as const],
      },
      runtimeId: 'whisper_cpp' as const,
    };

    for (const schemaVersion of [4, 5, 11, 12]) {
      expect(
        resolvePluginSettings({
          schemaVersion,
          selectedModelCapabilitiesSnapshot: { capabilities, selection },
        }).selectedModelCapabilitiesSnapshot,
      ).toEqual({ capabilities, selection });
    }

    expect(
      resolvePluginSettings({
        schemaVersion: 3,
        selectedModelCapabilitiesSnapshot: { capabilities, selection },
      }).selectedModelCapabilitiesSnapshot,
    ).toBeNull();
  });

  it.each([
    ['not a record', 'nope'],
    [
      'missing capabilities',
      {
        selection: {
          familyId: 'whisper',
          kind: 'catalog_model',
          modelId: 'm',
          runtimeId: 'whisper_cpp',
        },
      },
    ],
    [
      'capabilities missing required fields',
      {
        capabilities: { familyId: 'whisper' },
        selection: {
          familyId: 'whisper',
          kind: 'catalog_model',
          modelId: 'm',
          runtimeId: 'whisper_cpp',
        },
      },
    ],
    [
      'invalid selection',
      {
        capabilities: {},
        selection: {
          familyId: 'not_a_family',
          kind: 'catalog_model',
          modelId: 'm',
          runtimeId: 'whisper_cpp',
        },
      },
    ],
  ])('drops a malformed selectedModelCapabilitiesSnapshot (%s)', (_label, value) => {
    expect(
      resolvePluginSettings({ selectedModelCapabilitiesSnapshot: value })
        .selectedModelCapabilitiesSnapshot,
    ).toBeNull();
  });

  it('validates setupCompletedAt as the exact persisted ISO timestamp', () => {
    const timestamp = '2026-05-22T10:00:00.000Z';

    expect(resolvePluginSettings({ setupCompletedAt: timestamp }).setupCompletedAt).toBe(timestamp);
    expect(resolvePluginSettings({ setupCompletedAt: 'corrupted' }).setupCompletedAt).toBeNull();
    expect(resolvePluginSettings({ setupCompletedAt: '2026-05-22' }).setupCompletedAt).toBeNull();
  });

  it('clamps LLM postprocess numeric settings at the settings boundary', () => {
    const low = resolvePluginSettings({
      llmPostprocessNoteContextChars: -1,
      llmPostprocessPriorUtterancesN: -1,
      llmPostprocessSkipMinWords: -1,
      llmPostprocessTemperature: -1,
      llmPostprocessTotalContextCap: -1,
    });
    const high = resolvePluginSettings({
      llmPostprocessNoteContextChars: 99_999,
      llmPostprocessPriorUtterancesN: 99,
      llmPostprocessSkipMinWords: 99,
      llmPostprocessTemperature: 99,
      llmPostprocessTotalContextCap: 99_999,
    });

    expect(low).toMatchObject({
      llmPostprocessNoteContextChars: 0,
      llmPostprocessPriorUtterancesN: 0,
      llmPostprocessSkipMinWords: 0,
      llmPostprocessTemperature: 0,
      llmPostprocessTotalContextCap: 0,
    });
    expect(high).toMatchObject({
      llmPostprocessNoteContextChars: 12_000,
      llmPostprocessPriorUtterancesN: 5,
      llmPostprocessSkipMinWords: 50,
      llmPostprocessTemperature: 2,
      llmPostprocessTotalContextCap: 30_000,
    });
  });

  it('clamps timestamp sparse interval at the settings boundary', () => {
    expect(resolvePluginSettings({ timestampSparseIntervalMs: 1 }).timestampSparseIntervalMs).toBe(
      10_000,
    );
    expect(
      resolvePluginSettings({ timestampSparseIntervalMs: 999_999 }).timestampSparseIntervalMs,
    ).toBe(600_000);
  });

  it('migrates detailed model timing to every-phrase timestamps', () => {
    expect(resolvePluginSettings({ timestampDensity: 'detailed' }).timestampDensity).toBe(
      'every_utterance',
    );
  });

  it.each([
    ['10', 10_000],
    [' 30 ', 30_000],
    ['600', 600_000],
  ])('validates a whole-number timestamp interval of %s seconds', (value, milliseconds) => {
    expect(validateTimestampIntervalSeconds(value)).toEqual({ milliseconds, valid: true });
  });

  it.each(['', 'ten', 'NaN', '9', '10.5', '601', '1e2', '0x10'])(
    'rejects timestamp interval %j',
    (value) => {
      expect(validateTimestampIntervalSeconds(value)).toEqual({
        message: 'Enter a whole number from 10 to 600 seconds.',
        valid: false,
      });
    },
  );

  it('defaults smart paragraph thresholds to separate line and paragraph pauses', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.smartParagraphLineBreakPauseMs).toBe(
      DEFAULT_SMART_PARAGRAPH_LINE_BREAK_PAUSE_MS,
    );
    expect(DEFAULT_PLUGIN_SETTINGS.smartParagraphParagraphPauseMs).toBe(
      DEFAULT_SMART_PARAGRAPH_PARAGRAPH_PAUSE_MS,
    );
    expect(resolvePluginSettings({})).toMatchObject({
      smartParagraphLineBreakPauseMs: 4_000,
      smartParagraphParagraphPauseMs: 10_000,
    });
  });

  it('clamps smart paragraph thresholds at the settings boundary', () => {
    expect(
      resolvePluginSettings({
        smartParagraphLineBreakPauseMs: 1,
        smartParagraphParagraphPauseMs: 999_999,
      }),
    ).toMatchObject({
      smartParagraphLineBreakPauseMs: MIN_SMART_PARAGRAPH_PAUSE_MS,
      smartParagraphParagraphPauseMs: MAX_SMART_PARAGRAPH_PAUSE_MS,
    });
  });

  it('normalizes smart paragraph line breaks to not exceed paragraph breaks', () => {
    expect(
      resolvePluginSettings({
        smartParagraphLineBreakPauseMs: 5000,
        smartParagraphParagraphPauseMs: 2000,
      }),
    ).toMatchObject({
      smartParagraphLineBreakPauseMs: 2000,
      smartParagraphParagraphPauseMs: 2000,
    });
  });

  it('defaults useLlmNoteContext to false', () => {
    expect(DEFAULT_PLUGIN_SETTINGS.useLlmNoteContext).toBe(false);
    expect(resolvePluginSettings({}).useLlmNoteContext).toBe(false);
  });

  it('accepts useLlmNoteContext when persisted as a boolean', () => {
    expect(resolvePluginSettings({ useLlmNoteContext: true }).useLlmNoteContext).toBe(true);
    expect(resolvePluginSettings({ useLlmNoteContext: false }).useLlmNoteContext).toBe(false);
  });

  it('migrates the legacy single Ollama model into provider configuration', () => {
    expect(
      resolvePluginSettings({
        llmPostprocessModel: ' llama3.2:latest ',
      }),
    ).toMatchObject({
      llmProviderConfigurations: {
        ollama: { model: 'llama3.2:latest' },
        openrouter: { model: '', secretId: '' },
      },
    });
  });

  it.each([
    ['ollama maps to Ollama', 'ollama', 'ollama'],
    ['openrouter maps to OpenRouter', 'openrouter', 'openrouter'],
    ['gemini maps to Ollama', 'gemini', 'ollama'],
  ] as const)('migrates legacy llmProvider %s', (_label, llmProvider, providerId) => {
    expect(resolvePluginSettings({ llmProvider }).llmRoutingPolicy).toEqual({
      kind: 'fixed',
      providerId,
    });
  });

  it('migrates old local, remote, and auto routing policies', () => {
    expect(resolvePluginSettings({ llmRouting: 'local' }).llmRoutingPolicy).toEqual({
      kind: 'fixed',
      providerId: 'ollama',
    });
    expect(resolvePluginSettings({ llmRouting: 'remote' }).llmRoutingPolicy).toEqual({
      kind: 'fixed',
      providerId: 'openrouter',
    });
    expect(
      resolvePluginSettings({ llmRemoteThresholdChars: 8_000, llmRouting: 'auto' })
        .llmRoutingPolicy,
    ).toEqual({
      defaultProviderId: 'ollama',
      kind: 'transcript_size',
      largeTranscriptProviderId: 'openrouter',
      thresholdChars: 8_000,
    });
  });

  it('keeps a remote-disabled vault fixed on Ollama during migration', () => {
    expect(
      resolvePluginSettings({ llmRemoteFeaturesEnabled: false, llmRouting: 'auto' })
        .llmRoutingPolicy,
    ).toEqual({ kind: 'fixed', providerId: 'ollama' });
  });

  it('drops the legacy Gemini model and keeps Ollama and OpenRouter models', () => {
    expect(
      resolvePluginSettings({
        llmProviderModels: {
          gemini: 'gemini-2.5-flash',
          ollama: 'new-ollama',
          openrouter: 'openai/gpt-4.1',
        },
      }).llmProviderConfigurations,
    ).toEqual({
      ollama: { model: 'new-ollama' },
      openrouter: { model: 'openai/gpt-4.1', secretId: '' },
      openai_compatible: DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
    });
  });

  it('clamps migrated and current routing thresholds at the settings boundary', () => {
    expect(
      resolvePluginSettings({ llmRemoteThresholdChars: 1, llmRouting: 'auto' }).llmRoutingPolicy,
    ).toMatchObject({ thresholdChars: 500 });
    expect(
      resolvePluginSettings({
        llmRoutingPolicy: {
          defaultProviderId: 'ollama',
          kind: 'transcript_size',
          largeTranscriptProviderId: 'openrouter',
          thresholdChars: 999_999,
        },
      }).llmRoutingPolicy,
    ).toMatchObject({ thresholdChars: 60_000 });
  });

  it('clamps the provider-neutral network timeout and migrates the old value', () => {
    expect(resolvePluginSettings({ llmNetworkTimeoutSec: 1 }).llmNetworkTimeoutSec).toBe(5);
    expect(resolvePluginSettings({ llmNetworkTimeoutSec: 9_999 }).llmNetworkTimeoutSec).toBe(600);
    expect(resolvePluginSettings({ llmRemoteTimeoutSec: 120 }).llmNetworkTimeoutSec).toBe(120);
  });

  it('falls back to the default when useLlmNoteContext is not a boolean', () => {
    expect(resolvePluginSettings({ useLlmNoteContext: 'yes' }).useLlmNoteContext).toBe(false);
  });

  it('persists the last enabled LLM mode and seeds it from the stored mode', () => {
    expect(
      resolvePluginSettings({ llmPostprocessLastEnabledMode: 'batch' })
        .llmPostprocessLastEnabledMode,
    ).toBe('batch');
    // Vaults that predate the field seed from the enabled mode.
    expect(
      resolvePluginSettings({ llmPostprocessMode: 'batch' }).llmPostprocessLastEnabledMode,
    ).toBe('batch');
    expect(
      resolvePluginSettings({ llmPostprocessLastEnabledMode: 'off' }).llmPostprocessLastEnabledMode,
    ).toBe('per_utterance');
  });
});

describe('llm preset migration', () => {
  it('drops a legacy prompt that matches the active preset', () => {
    const settings = resolvePluginSettings({
      llmPostprocessActivePresetRef: 'builtin:professional-writing',
      llmPostprocessPrompt: getLlmBuiltinPreset('professional-writing').prompt,
    });
    expect(settings.llmPostprocessActivePresetRef).toBe('builtin:professional-writing');
    expect(settings.llmPostprocessUserPresets).toHaveLength(0);
    expect('llmPostprocessPrompt' in settings).toBe(false);
  });

  it('re-points the ref when a legacy prompt matches another preset', () => {
    const settings = resolvePluginSettings({
      llmPostprocessActivePresetRef: null,
      llmPostprocessPrompt: getLlmBuiltinPreset('professional-writing').prompt,
    });
    expect(settings.llmPostprocessActivePresetRef).toBe('builtin:professional-writing');
  });

  it('trusts a valid builtin ref even when its prompt text changed across versions', () => {
    // Pre-redesign vaults stored the builtin's old prompt as a mirror; the ref
    // is the authoritative signal of user intent.
    const settings = resolvePluginSettings({
      llmPostprocessActivePresetRef: 'builtin:tldr',
      llmPostprocessPrompt: 'old TLDR prompt text that no longer matches any preset',
    });
    expect(settings.llmPostprocessActivePresetRef).toBe('builtin:tldr');
    expect(settings.llmPostprocessUserPresets).toHaveLength(0);
  });

  it('still preserves a custom prompt when the stored ref is a user preset with a different prompt', () => {
    const settings = resolvePluginSettings({
      llmPostprocessActivePresetRef: 'user:a',
      llmPostprocessPrompt: 'diverged custom prompt',
      llmPostprocessUserPresets: [makeUserPreset({ id: 'a' })],
    });
    const created = settings.llmPostprocessUserPresets[1];
    expect(created).toMatchObject({ label: 'My preset', prompt: 'diverged custom prompt' });
    expect(settings.llmPostprocessActivePresetRef).toBe(`user:${created?.id}`);
  });

  it('converts a custom legacy prompt into a "My preset" user preset', () => {
    const settings = resolvePluginSettings({ llmPostprocessPrompt: 'fully custom prompt' });
    const created = settings.llmPostprocessUserPresets[0];
    expect(created).toMatchObject({
      label: 'My preset',
      output: 'replace',
      prompt: 'fully custom prompt',
    });
    expect(settings.llmPostprocessActivePresetRef).toBe(`user:${created?.id}`);
  });

  it('suffixes the migrated preset label when "My preset" is taken', () => {
    const settings = resolvePluginSettings({
      llmPostprocessPrompt: 'fully custom prompt',
      llmPostprocessUserPresets: [makeUserPreset({ id: 'a', label: 'My preset' })],
    });
    expect(settings.llmPostprocessUserPresets[1]?.label).toBe('My preset 2');
  });

  it('falls back to clean-up for unknown refs, including removed voice-commands', () => {
    expect(
      resolvePluginSettings({ llmPostprocessActivePresetRef: 'builtin:voice-commands' })
        .llmPostprocessActivePresetRef,
    ).toBe('builtin:clean-up');
    expect(
      resolvePluginSettings({ llmPostprocessActivePresetRef: null }).llmPostprocessActivePresetRef,
    ).toBe('builtin:clean-up');
  });

  it('migrates legacy user-preset fields into the new shape', () => {
    const settings = resolvePluginSettings({
      llmPostprocessUserPresets: [
        { id: 'a', label: 'Old', prompt: 'p', mode: 'batch', minWords: 2, temperature: 0.7 },
      ],
    });
    expect(settings.llmPostprocessUserPresets[0]).toEqual({
      id: 'a',
      label: 'Old',
      output: 'replace',
      overrides: { minWords: 2, temperature: 0.7 },
      prompt: 'p',
      timing: 'batch',
    });
  });

  it('drops user presets without a prompt and forces batch timing for additive presets', () => {
    const settings = resolvePluginSettings({
      llmPostprocessUserPresets: [
        { id: 'empty', label: 'No prompt', prompt: '   ' },
        { id: 'add', label: 'Adder', prompt: 'p', output: 'add_above', timing: 'per_utterance' },
      ],
    });
    expect(settings.llmPostprocessUserPresets).toHaveLength(1);
    expect(settings.llmPostprocessUserPresets[0]).toMatchObject({ id: 'add', timing: 'batch' });
  });
});

describe('user preset normalization', () => {
  it.each([
    [
      'preserves valid entries in order',
      [
        makeUserPreset({ id: 'a', label: 'Style A', description: 'first' }),
        makeUserPreset({ id: 'b', label: 'Style B', prompt: 'second prompt' }),
      ],
      [
        makeUserPreset({ id: 'a', label: 'Style A', description: 'first' }),
        makeUserPreset({ id: 'b', label: 'Style B', prompt: 'second prompt' }),
      ],
    ],
    [
      'drops invalid entries',
      [
        null,
        'string',
        { id: '', label: 'empty id', prompt: 'x' },
        { id: 'valid', label: '   ', prompt: 'x' },
        { id: 'no-label', prompt: 'x' },
        makeUserPreset({ id: 'ok', label: 'Keeper' }),
      ],
      [makeUserPreset({ id: 'ok', label: 'Keeper' })],
    ],
    [
      'drops duplicate IDs after the first valid entry',
      [
        makeUserPreset({ id: 'a', label: 'First A' }),
        makeUserPreset({ id: 'a', label: 'Second A' }),
        makeUserPreset({ id: 'b', label: 'Keeper B' }),
      ],
      [
        makeUserPreset({ id: 'a', label: 'First A' }),
        makeUserPreset({ id: 'b', label: 'Keeper B' }),
      ],
    ],
  ] as const)('normalizes user presets: %s', (_label, llmPostprocessUserPresets, expected) => {
    expect(resolvePluginSettings({ llmPostprocessUserPresets }).llmPostprocessUserPresets).toEqual(
      expected,
    );
  });

  it('keeps valid override values in the overrides bag; drops invalid', () => {
    const presets = resolvePluginSettings({
      llmPostprocessUserPresets: [
        {
          id: 'a',
          label: 'Has all',
          prompt: 'p',
          overrides: { minWords: 0, temperature: 0.7, useNoteContext: true },
        },
        {
          id: 'b',
          label: 'Clamped high',
          prompt: 'p',
          overrides: { minWords: 999, temperature: 99 },
        },
        {
          id: 'c',
          label: 'Bad types',
          prompt: 'p',
          overrides: { minWords: '3', temperature: 'hot', useNoteContext: 'yes' },
        },
        { id: 'd', label: 'None', prompt: 'p' },
      ],
    }).llmPostprocessUserPresets;

    expect(presets[0]?.overrides).toEqual({ minWords: 0, temperature: 0.7, useNoteContext: true });
    expect(presets[1]?.overrides).toEqual({ minWords: 50, temperature: 2 });
    expect(presets[2]?.overrides).toBeUndefined();
    expect(presets[3]?.overrides).toBeUndefined();
  });

  it('keeps valid preset timings and drops invalid ones', () => {
    const presets = resolvePluginSettings({
      llmPostprocessUserPresets: [
        { id: 'a', label: 'Phrase', prompt: 'p', timing: 'per_utterance' },
        { id: 'b', label: 'Batch', prompt: 'p', timing: 'batch' },
        { id: 'c', label: 'Off rejected', prompt: 'p', timing: 'off' },
        { id: 'd', label: 'Unknown rejected', prompt: 'p', timing: 'whenever' },
        { id: 'e', label: 'No timing', prompt: 'p' },
      ],
    }).llmPostprocessUserPresets;

    expect(presets.map((preset) => preset.timing)).toEqual([
      'per_utterance',
      'batch',
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('clamps user preset label and description lengths', () => {
    const longLabel = 'L'.repeat(LLM_USER_PRESET_MAX_LABEL_CHARS + 20);
    const longDesc = 'D'.repeat(LLM_USER_PRESET_MAX_DESCRIPTION_CHARS + 50);
    const preset = resolvePluginSettings({
      llmPostprocessUserPresets: [
        { id: 'a', label: longLabel, description: longDesc, prompt: 'prompt' },
      ],
    }).llmPostprocessUserPresets[0];

    expect(preset?.label.length).toBe(LLM_USER_PRESET_MAX_LABEL_CHARS);
    expect(preset?.description?.length).toBe(LLM_USER_PRESET_MAX_DESCRIPTION_CHARS);
  });

  it(`caps user preset count at ${LLM_USER_PRESET_MAX_COUNT}`, () => {
    const presets = Array.from({ length: LLM_USER_PRESET_MAX_COUNT + 5 }, (_, i) =>
      makeUserPreset({ id: `id-${i}`, label: `Label ${i}` }),
    );

    expect(
      resolvePluginSettings({ llmPostprocessUserPresets: presets }).llmPostprocessUserPresets,
    ).toHaveLength(LLM_USER_PRESET_MAX_COUNT);
  });

  it('drops non-array user preset values', () => {
    expect(
      resolvePluginSettings({ llmPostprocessUserPresets: 'oops' }).llmPostprocessUserPresets,
    ).toEqual([]);
    expect(
      resolvePluginSettings({ llmPostprocessUserPresets: { 0: 'oops' } }).llmPostprocessUserPresets,
    ).toEqual([]);
  });
});

describe('audio input device', () => {
  it('reads a valid audioInputDevice and trims whitespace', () => {
    expect(
      resolvePluginSettings({
        audioInputDevice: { deviceId: '  abc123  ', label: '  Plantronics Headset  ' },
      }).audioInputDevice,
    ).toEqual({ deviceId: 'abc123', label: 'Plantronics Headset' });
  });

  it.each([
    ['missing field', { audioInputDevice: { deviceId: 'abc' } }],
    ['empty deviceId', { audioInputDevice: { deviceId: '', label: 'Mic' } }],
    ['empty label', { audioInputDevice: { deviceId: 'abc', label: '' } }],
    ['whitespace-only label', { audioInputDevice: { deviceId: 'abc', label: '   ' } }],
    ['wrong types', { audioInputDevice: { deviceId: 42, label: 'Mic' } }],
    ['not an object', { audioInputDevice: 'abc123' }],
  ])('coerces invalid audioInputDevice to null (%s)', (_label, raw) => {
    expect(resolvePluginSettings(raw).audioInputDevice).toBeNull();
  });
});

describe('system audio inclusion', () => {
  it('defaults to microphone-only capture when unset', () => {
    expect(resolvePluginSettings({}).includeSystemAudio).toBe(false);
  });

  it('reads a valid includeSystemAudio value', () => {
    expect(resolvePluginSettings({ includeSystemAudio: true }).includeSystemAudio).toBe(true);
  });

  it('migrates legacy system audio source to include system audio', () => {
    expect(resolvePluginSettings({ audioSource: 'system' }).includeSystemAudio).toBe(true);
    expect(resolvePluginSettings({ audioSource: 'microphone' }).includeSystemAudio).toBe(false);
  });

  it.each([
    ['unknown string', 'speaker'],
    ['wrong type', 42],
    ['null', null],
  ])('coerces invalid includeSystemAudio to false (%s)', (_label, raw) => {
    expect(resolvePluginSettings({ includeSystemAudio: raw }).includeSystemAudio).toBe(false);
  });
});

describe('resetLlmPostprocessDefaults', () => {
  it('resets editable LLM defaults while preserving preset state and provider configuration', () => {
    const presets = [makeUserPreset({ id: 'a', label: 'Keep me' })];
    const llmProviderConfigurations = {
      ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
      ollama: { model: 'llama3' },
      openrouter: { model: 'openai/gpt-4.1', secretId: 'openrouter-key' },
    };
    const reset = resetLlmPostprocessDefaults({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmFeaturesEnabled: false,
      llmPostprocessActivePresetRef: 'user:custom',
      llmPostprocessLastEnabledMode: 'batch',
      llmPostprocessMode: 'batch',
      llmPostprocessNoteContextChars: 333,
      llmPostprocessPriorUtterancesN: 3,
      llmPostprocessShowRawBelow: true,
      llmPostprocessSkipMinWords: 3,
      llmPostprocessTemperature: 1,
      llmPostprocessTotalContextCap: 333,
      llmPostprocessUserPresets: presets,
      llmProviderConfigurations,
    });

    expect(reset).toMatchObject({
      llmFeaturesEnabled: false,
      llmPostprocessActivePresetRef: 'user:custom',
      llmPostprocessLastEnabledMode: 'per_utterance',
      llmPostprocessMode: 'per_utterance',
      llmPostprocessShowRawBelow: true,
      llmPostprocessUserPresets: presets,
      llmProviderConfigurations,
    });
  });

  it('preserves a disabled transform while resetting its configuration', () => {
    const reset = resetLlmPostprocessDefaults({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmPostprocessMode: 'off',
      llmPostprocessTemperature: 1.5,
    });

    expect(reset.llmPostprocessMode).toBe('off');
    expect(reset.llmPostprocessLastEnabledMode).toBe('per_utterance');
    expect(reset.llmPostprocessTemperature).toBe(DEFAULT_PLUGIN_SETTINGS.llmPostprocessTemperature);
  });
});
