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
  readonly buttonComponents: Array<{
    buttonEl: TestElement;
    disabled: boolean;
    text: string;
    click(): Promise<void>;
  }>;
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
      timestampsEnabled: true,
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
      .filter((setting) => setting.name === t('settings.timestamps.interval.name'))
      .at(-1)
      ?.textComponents[0]?.change('45');
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
      timestampSparseIntervalMs: 45_000,
    });
    expect(saved.llmPostprocessActivePresetRef).toBe(
      DEFAULT_PLUGIN_SETTINGS.llmPostprocessActivePresetRef,
    );
    expect(saved.timestampSparseIntervalMs).toBe(DEFAULT_PLUGIN_SETTINGS.timestampSparseIntervalMs);
    registry.closeAll();
  });

  it('shows progress and only one cancel action while a YouTube job runs', async () => {
    let finishJob: (() => void) | undefined;
    const startYouTube = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishJob = resolve;
        }),
    );
    const cancel = vi.fn(async () => {});
    const registry = new MediaTranscriptionModalRegistry();
    registry.open(
      {} as never,
      {
        cancel,
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
        startYouTube,
        subscribeProgress: () => () => {},
      },
      'youtube',
    );

    settings()
      .find((setting) => setting.name === t('youtube.modal.urlName'))
      ?.textComponents[0]?.change('https://www.youtube.com/watch?v=8MxG6tOkdNY');
    const buttons = settings().flatMap((setting) => setting.buttonComponents);
    const start = buttons.find((button) => button.text === t('media.modal.start'));
    const close = buttons.find((button) => button.text === t('common.close'));
    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    if (start === undefined || close === undefined || modal === undefined)
      throw new Error('Expected job controls');

    await start.click();
    expect(start.text).toBe(t('media.modal.cancelJob'));
    expect(close.buttonEl.style.display).toBe('none');
    expect(modal.contentEl.findByClass('local-stt-media-spinner')?.style.display).toBe('');
    expect(modal.contentEl.findByClass('local-stt-media-progress-text')?.textContent).toBe(
      t('media.progress.download'),
    );

    await start.click();
    expect(cancel).toHaveBeenCalledOnce();
    expect(modal.contentEl.findByClass('local-stt-media-spinner')?.style.display).toBe('none');
    finishJob?.();
    await vi.waitFor(() => expect(start.text).toBe(t('media.modal.start')));
    registry.closeAll();
  });
});
