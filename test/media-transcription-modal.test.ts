import { Modal, Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';
import { MediaTranscriptionModalRegistry } from '../src/ui/media-transcription-modal';
import type { TestElement } from './__mocks__/obsidian';

interface SettingFixture {
  readonly name: string;
}

const settings = (): SettingFixture[] =>
  (Setting as unknown as { instances: SettingFixture[] }).instances;

afterEach(() => {
  settings().length = 0;
  (Modal as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('local media transcription modal', () => {
  it('keeps the file workflow focused on audio and video files', () => {
    const registry = new MediaTranscriptionModalRegistry();
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

    registry.closeAll();
  });
});
