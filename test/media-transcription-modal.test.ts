import { Modal, Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';
import { MediaTranscriptionModalRegistry } from '../src/ui/media-transcription-modal';
import type { TestElement } from './__mocks__/obsidian';

interface SettingFixture {
  readonly name: string;
  readonly extraButtonComponents: Array<{ tooltip: string; click(): Promise<void> }>;
}

const settings = (): SettingFixture[] =>
  (Setting as unknown as { instances: SettingFixture[] }).instances;

afterEach(() => {
  settings().length = 0;
  (Modal as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('local media transcription modal', () => {
  it('keeps the file workflow focused on audio and video files', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    const onManagePresets = vi.fn();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [],
      getLastError: () => null,
      getPartialTranscript: () => null,
      insertPartialTranscript: () => false,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      onManageModels: vi.fn(),
      onManagePresets,
      startFile: vi.fn(async () => {}),
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    expect(modal?.contentEl.findByClass('local-stt-media-drop-zone')).toBeDefined();
    expect(modal?.contentEl.findByClass('local-stt-media-source-tabs')).toBeUndefined();
    expect(settings().some(({ name }) => name === t('youtube.modal.urlName'))).toBe(false);
    expect(settings().some(({ name }) => name === t('media.modal.language'))).toBe(true);

    const opener = settings()
      .flatMap(({ extraButtonComponents }) => extraButtonComponents)
      .find(({ tooltip }) => tooltip === t('llm.preset.manager.title'));
    expect(opener).toBeDefined();
    await opener?.click();
    expect(onManagePresets).toHaveBeenCalledOnce();

    registry.closeAll();
  });
});
