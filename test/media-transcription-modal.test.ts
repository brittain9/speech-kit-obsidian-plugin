import { Modal, Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaTranscriptionJobOptions } from '../src/media/media-transcription-options';
import { YOUTUBE_POLICY_VERSION } from '../src/media/youtube-media-source';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';
import { MediaTranscriptionModalRegistry } from '../src/ui/media-transcription-modal';
import type { TestElement } from './__mocks__/obsidian';

interface SettingFixture {
  readonly name: string;
  readonly textComponents: Array<{ change(value: string): void }>;
  readonly dropdownComponents: Array<{ change(value: string): void }>;
  readonly buttonComponents: Array<{ disabled: boolean; text: string; click(): Promise<void> }>;
}

const settings = (): SettingFixture[] =>
  (Setting as unknown as { instances: SettingFixture[] }).instances;

afterEach(() => {
  settings().length = 0;
  (Modal as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('media transcription modal eligibility', () => {
  it('accepts a timestamped YouTube podcast link as one video', () => {
    const registry = new MediaTranscriptionModalRegistry();
    registry.open(
      {} as never,
      {
        cancel: async () => {},
        getModels: () => [
          {
            capabilities: {} as never,
            label: 'Whisper',
            selection: {
              familyId: 'whisper',
              kind: 'catalog_model',
              modelId: 'whisper-small',
              runtimeId: 'whisper_cpp',
            },
          },
        ],
        getLastError: () => null,
        getProgress: () => null,
        getSettings: () => DEFAULT_PLUGIN_SETTINGS,
        getYouTubeHelperPath: () => '/tmp/yt-dlp',
        getYouTubePolicyVersion: () => YOUTUBE_POLICY_VERSION,
        isTranscribing: () => false,
        isYouTubeEnabled: () => true,
        onManageModels: () => {},
        startFile: async () => {},
        startYouTube: async () => {},
        subscribeProgress: () => () => {},
      },
      'youtube',
    );

    const url = settings().find((setting) => setting.name === t('youtube.modal.urlName'))
      ?.textComponents[0];
    const start = settings()
      .flatMap((setting) => setting.buttonComponents)
      .find((button) => button.text === t('media.modal.start'));
    if (url === undefined || start === undefined) throw new Error('Expected YouTube controls');
    url.change('https://www.youtube.com/watch?v=8MxG6tOkdNY&t=407s');
    expect(start.disabled).toBe(false);
    registry.closeAll();
  });

  it('explains why an unsupported link cannot start', () => {
    const registry = new MediaTranscriptionModalRegistry();
    registry.open(
      {} as never,
      {
        cancel: async () => {},
        getModels: () => [
          {
            capabilities: {} as never,
            label: 'Whisper',
            selection: {
              familyId: 'whisper',
              kind: 'catalog_model',
              modelId: 'whisper-small',
              runtimeId: 'whisper_cpp',
            },
          },
        ],
        getLastError: () => null,
        getProgress: () => null,
        getSettings: () => DEFAULT_PLUGIN_SETTINGS,
        getYouTubeHelperPath: () => '/tmp/yt-dlp',
        getYouTubePolicyVersion: () => YOUTUBE_POLICY_VERSION,
        isTranscribing: () => false,
        isYouTubeEnabled: () => true,
        onManageModels: () => {},
        startFile: async () => {},
        startYouTube: async () => {},
        subscribeProgress: () => () => {},
      },
      'youtube',
    );
    const url = settings().find((setting) => setting.name === t('youtube.modal.urlName'))
      ?.textComponents[0];
    if (url === undefined) throw new Error('Expected URL input');
    url.change('https://example.com/watch?v=8MxG6tOkdNY');
    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    expect(modal?.contentEl.findByClass('local-stt-media-requirement')?.textContent).toBe(
      t('media.modal.invalidYouTubeUrl'),
    );
    registry.closeAll();
  });

  it('snapshots a selected summary preset for this job without changing saved settings', async () => {
    const saved = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'ollama' as const },
    };
    const startYouTube = vi.fn(async (_url: string, _options: MediaTranscriptionJobOptions) => {});
    const registry = new MediaTranscriptionModalRegistry();
    registry.open(
      {} as never,
      {
        cancel: async () => {},
        getModels: () => [
          {
            capabilities: {} as never,
            label: 'Whisper',
            selection: {
              familyId: 'whisper',
              kind: 'catalog_model',
              modelId: 'whisper-small',
              runtimeId: 'whisper_cpp',
            },
          },
        ],
        getLastError: () => null,
        getProgress: () => null,
        getSettings: () => saved,
        getYouTubeHelperPath: () => '/tmp/yt-dlp',
        getYouTubePolicyVersion: () => YOUTUBE_POLICY_VERSION,
        isTranscribing: () => false,
        isYouTubeEnabled: () => true,
        onManageModels: () => {},
        startFile: async () => {},
        startYouTube,
        subscribeProgress: () => () => {},
      },
      'youtube',
    );

    settings()
      .find((setting) => setting.name === t('media.modal.aiPreset'))
      ?.dropdownComponents[0]?.change('builtin:tldr');
    settings()
      .filter((setting) => setting.name === t('youtube.modal.urlName'))
      .at(-1)
      ?.textComponents[0]?.change('https://www.youtube.com/watch?v=8MxG6tOkdNY&t=407s');
    const start = settings()
      .flatMap((setting) => setting.buttonComponents)
      .filter((button) => button.text === t('media.modal.start'))
      .at(-1);
    expect(start?.disabled).toBe(false);
    await start?.click();
    await vi.waitFor(() => expect(startYouTube).toHaveBeenCalledOnce());
    expect(startYouTube.mock.calls[0]?.[1]).toMatchObject({
      mediaLlmSnapshot: { output: 'add_above', prompt: expect.stringContaining('summary') },
    });
    expect(saved.llmPostprocessActivePresetRef).toBe(
      DEFAULT_PLUGIN_SETTINGS.llmPostprocessActivePresetRef,
    );
    registry.closeAll();
  });
});
