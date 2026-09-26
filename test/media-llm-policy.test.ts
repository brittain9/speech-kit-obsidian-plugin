import { describe, expect, it } from 'vitest';
import {
  describeMediaLlmConfiguration,
  formatMediaLlmDisclosure,
  resolveMediaLlmDisclosure,
} from '../src/llm/media-llm-policy';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { createFakeLlmRouter } from './fixtures/llm';

function settings(
  provider: 'ollama' | 'openrouter' | 'openai_compatible',
  baseUrl = 'http://127.0.0.1:1234/v1',
  overrides: Partial<typeof DEFAULT_PLUGIN_SETTINGS> = {},
) {
  return {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmProviderConfigurations: {
      ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
      [provider]: {
        model: 'configured-model',
        ...(provider === 'openai_compatible' ? { baseUrl } : {}),
      },
    },
    llmRoutingPolicy: { kind: 'fixed' as const, providerId: provider },
    mediaLlmProcessing: true,
    useLlmNoteContext: false,
    ...overrides,
  };
}

describe('media LLM disclosure policy', () => {
  it('classifies loopback custom endpoints as local and states the exact payload', () => {
    const disclosure = resolveMediaLlmDisclosure(
      settings('openai_compatible'),
      createFakeLlmRouter({ providerId: 'openai_compatible' }),
      100,
      { noteContextChars: 100, totalContextCap: 100, useNoteContext: false },
    );
    expect(disclosure).toMatchObject({
      dataEgress: 'local',
      payload: 'transcript_only',
    });
    expect(formatMediaLlmDisclosure(disclosure)).toContain('transcript text only');
    expect(formatMediaLlmDisclosure(disclosure)).not.toContain('note context');
  });

  it('classifies non-loopback custom endpoints as network and includes bounded context when enabled', () => {
    const disclosure = resolveMediaLlmDisclosure(
      settings('openai_compatible', 'https://example.com/v1'),
      createFakeLlmRouter({ providerId: 'openai_compatible' }),
      100,
      { noteContextChars: 100, totalContextCap: 100, useNoteContext: true },
    );
    expect(disclosure.dataEgress).toBe('network');
    expect(disclosure.payload).toBe('transcript_and_bounded_note_context');
    expect(formatMediaLlmDisclosure(disclosure)).toContain('bounded note context');
  });

  it('omits note context when either effective budget is zero', () => {
    for (const context of [
      { noteContextChars: 100, totalContextCap: 0, useNoteContext: true },
      { noteContextChars: 0, totalContextCap: 100, useNoteContext: true },
    ]) {
      const disclosure = resolveMediaLlmDisclosure(
        settings('ollama'),
        createFakeLlmRouter({ providerId: 'ollama' }),
        100,
        context,
      );
      expect(disclosure.payload).toBe('transcript_only');
    }
    expect(
      describeMediaLlmConfiguration(
        settings('ollama', 'http://127.0.0.1:1234/v1', {
          llmPostprocessTotalContextCap: 0,
          useLlmNoteContext: true,
        }),
      ),
    ).not.toContain('note context');
  });
  it('describes Ollama separately from remote providers', () => {
    expect(describeMediaLlmConfiguration(settings('ollama'))).toContain('on this device');
    expect(describeMediaLlmConfiguration(settings('openrouter'))).toContain('over the network');
  });
});
