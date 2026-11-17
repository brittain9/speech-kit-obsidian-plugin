import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { renderCustomizeToolsSetting } from '../src/settings/customize-tools-modal';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import {
  type Modal as MockModal,
  type Setting as MockSetting,
  TestElement,
} from './__mocks__/obsidian';

describe('Customize tools', () => {
  it('keeps switches in a native dialog and preserves saved choices when tools are hidden', async () => {
    const rows = Setting as unknown as typeof MockSetting;
    rows.reset();
    let settings: PluginSettings = { ...DEFAULT_PLUGIN_SETTINGS, llmNetworkTimeoutSec: 42 };
    const onChanged = vi.fn();
    const onClosed = vi.fn();
    const restoreFocus = vi.fn();
    const onDialogOpened = vi.fn(() => restoreFocus);
    renderCustomizeToolsSetting(new TestElement() as unknown as HTMLElement, {} as App, {
      access: {
        getSettings: () => settings,
        persistOne: async (key, value) => {
          settings = { ...settings, [key]: value };
        },
      },
      onChanged,
      onClosed,
      onDialogOpened,
    });
    expect(rows.instances.map((row) => row.name)).toEqual(['Customize tools']);
    expect(rows.instances[0]?.toggleComponents).toHaveLength(0);
    expect(onDialogOpened).not.toHaveBeenCalled();
    await rows.buttonNamed('Customize').click();
    expect(onDialogOpened).toHaveBeenCalledOnce();
    const modal = (Modal as unknown as typeof MockModal).instances.at(-1);
    expect(modal?.titleEl.textContent).toBe('Customize tools');
    expect(rows.instances.slice(1).map((row) => row.name)).toEqual([
      'Translation',
      'Read aloud',
      'AI transformations',
    ]);
    for (const name of ['Translation', 'Read aloud', 'AI transformations']) {
      rows.named(name).onlyToggle().change(false);
    }
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(3));
    expect(settings.translationEnabled).toBe(false);
    expect(settings.readAloudEnabled).toBe(false);
    expect(settings.llmFeaturesEnabled).toBe(false);
    expect(settings.llmNetworkTimeoutSec).toBe(42);
    rows.named('Translation').onlyToggle().change(true);
    await vi.waitFor(() => expect(settings.translationEnabled).toBe(true));
    modal?.close();
    expect(onClosed).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
    expect(modal?.contentEl.children).toHaveLength(0);
    rows.reset();
    renderCustomizeToolsSetting(new TestElement() as unknown as HTMLElement, {} as App, {
      access: { getSettings: () => settings, persistOne: vi.fn(async () => {}) },
      onChanged,
    });
    await rows.buttonNamed('Customize').click();
    expect(rows.named('Translation').onlyToggle().value).toBe(true);
    expect(rows.named('Read aloud').onlyToggle().value).toBe(false);
    expect(rows.named('AI transformations').onlyToggle().value).toBe(false);
  });
});
