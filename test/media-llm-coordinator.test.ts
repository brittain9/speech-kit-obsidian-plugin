import { describe, expect, it, vi } from 'vitest';
import type { MediaLlmEditorSession } from '../src/dictation/audio-file-transcript-adapter';
import { MediaLlmCoordinator } from '../src/dictation/media-llm-coordinator';
import { ProviderError } from '../src/llm/provider';
import type { LlmRouter } from '../src/llm/router';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmFeaturesEnabled: true,
    llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
    llmProviderConfigurations: {
      ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
      ollama: { model: 'local-model' },
    },
    mediaLlmProcessing: true,
    ...overrides,
  };
}

function session(): MediaLlmEditorSession {
  return {
    clearSessionProcessingMark: vi.fn(),
    insertAdjacentToSessionRange: vi.fn(() => true),
    joinRawSessionText: vi.fn(() => 'Raw transcript.'),
    markSessionRangeAsProcessing: vi.fn(() => true),
    readNoteText: vi.fn(() => null),
    replaceSessionRangeWithCleaned: vi.fn(() => ({ kind: 'denied' as const })),
    setAnchorMode: vi.fn(),
  };
}

describe('MediaLlmCoordinator', () => {
  it('preflights missing remote credentials with a typed localized readiness failure', () => {
    const feedback = { show: vi.fn() };
    const coordinator = new MediaLlmCoordinator({
      confirm: vi.fn(),
      createRouter: vi.fn(),
      feedback,
      getSettings: () =>
        settings({
          llmProviderConfigurations: {
            ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
            openrouter: { model: 'remote-model', secretId: 'secret-id' },
          },
          llmRoutingPolicy: { kind: 'fixed', providerId: 'openrouter' },
        }),
    });

    expect(coordinator.preflight()).toBe(false);
    expect(feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'media-llm-readiness-api_key_missing',
        message: expect.stringContaining('API key'),
      }),
    );
  });

  it('aborts an active provider request when media processing is disabled', async () => {
    let current = settings();
    const cleanup = vi.fn(
      (options: { abortSignal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(new ProviderError('aborted', 'aborted')),
            { once: true },
          );
        }),
    );
    const router: LlmRouter = { cleanup, selectProviderId: vi.fn(() => 'ollama' as const) };
    const feedback = { show: vi.fn() };
    const editor = session();
    const coordinator = new MediaLlmCoordinator({
      confirm: vi.fn(async () => true),
      createRouter: () => router,
      feedback,
      getSettings: () => current,
      onRawTranscriptRecoveryAvailable: vi.fn(),
    });

    const running = coordinator.run(editor);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    current = settings({ mediaLlmProcessing: false });
    coordinator.settingsChanged();
    await running;

    expect(editor.replaceSessionRangeWithCleaned).not.toHaveBeenCalled();
    expect(feedback.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'media-llm-failed' }),
    );
  });

  it('rechecks settings after confirmation before applying an old provider result', async () => {
    let current = settings();
    const feedback = { show: vi.fn() };
    const editor = session();
    const coordinator = new MediaLlmCoordinator({
      confirm: vi.fn(async () => {
        current = settings({ mediaLlmProcessing: false });
        return true;
      }),
      createRouter: () => ({
        cleanup: vi.fn(async () => ({
          model: 'local-model',
          providerId: 'ollama' as const,
          text: 'Clean.',
        })),
        selectProviderId: vi.fn(() => 'ollama' as const),
      }),
      feedback,
      getSettings: () => current,
    });

    await coordinator.run(editor);
    expect(editor.replaceSessionRangeWithCleaned).not.toHaveBeenCalled();
  });
});
