import type { WorkspaceLeaf } from 'obsidian';
import { expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { LocalDictationView } from '../src/ui/local-dictation-view';
import { Setting, type TestElement } from './__mocks__/obsidian';

it('opens Settings from the compact daily sidebar', async () => {
  Setting.reset();
  const openSettings = vi.fn();
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => ({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmFeaturesEnabled: true,
      llmPostprocessMode: 'off',
    }),
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
    openSettings,
  });
  view.refresh();
  await Setting.buttonNamed('Open settings').click();
  expect(openSettings).toHaveBeenCalledOnce();
  expect(Setting.instances.map((setting) => setting.name)).not.toContain('Provider');
});

it('preserves another setting changed while enabling transformation is waiting to save', async () => {
  Setting.reset();
  let settings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmFeaturesEnabled: true,
    llmPostprocessMode: 'off' as const,
  } as import('../src/settings/plugin-settings').PluginSettings;
  let commit!: () => void;
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => settings,
    mutatePresetState: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
    mutateSettings: async (mutation) => {
      await new Promise<void>((resolve) => {
        commit = resolve;
      });
      settings = mutation(settings);
    },
  });
  view.refresh();
  Setting.named('Transform new dictation').onlyToggle().change(true);
  settings = { ...settings, llmNetworkTimeoutSec: 42 };
  commit();
  await vi.waitFor(() => expect(settings.llmPostprocessMode).not.toBe('off'));
  expect(settings.llmNetworkTimeoutSec).toBe(42);
});

it('announces the changing sidebar workflow summary as one atomic status', () => {
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, llmFeaturesEnabled: false }),
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
  });

  view.refresh();

  const status = (view.contentEl as unknown as TestElement).findByClass(
    'local-dictation-sidebar__summary',
  );
  expect(status?.attributes.get('role')).toBe('status');
  expect(status?.attributes.get('aria-live')).toBe('polite');
  expect(status?.attributes.get('aria-atomic')).toBe('true');
});

it('preserves the sidebar scroll position across a settings rerender', () => {
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, llmFeaturesEnabled: false }),
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
  });

  view.refresh();
  const content = view.contentEl as unknown as TestElement;
  content.scrollTop = 320;

  view.requestRefresh();

  expect(content.scrollTop).toBe(320);
});
