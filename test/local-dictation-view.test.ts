import type { WorkspaceLeaf } from 'obsidian';
import { expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS, resolvePluginSettings } from '../src/settings/plugin-settings';
import { LocalDictationView } from '../src/ui/local-dictation-view';
import { Setting, type TestElement } from './__mocks__/obsidian';

it('opens Settings from the compact daily sidebar', async () => {
  Setting.reset();
  const openSettings = vi.fn();
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getDictationState: () => 'idle',
    toggleDictation: vi.fn(async () => {}),
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
  const dictation = Setting.named('Dictation');
  const settingsButton = dictation.extraButtonComponents.find(
    (button) => button.extraSettingsEl.getAttribute('aria-label') === 'Open settings',
  );
  expect(settingsButton).toBeDefined();
  expect(Setting.instances.filter((row) => row.name === '')).toHaveLength(0);
  await settingsButton?.click();
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
    getDictationState: () => 'idle',
    toggleDictation: vi.fn(async () => {}),
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

it('keeps output beside the active preset and timing in its own row', () => {
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getDictationState: () => 'idle',
    toggleDictation: vi.fn(async () => {}),
    getSettings: () => ({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmFeaturesEnabled: true,
      llmPostprocessMode: 'batch',
    }),
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
  });

  view.refresh();

  expect(Setting.named('Active preset').descEl.textContent).not.toContain('When dictation stops');
  expect(Setting.named('When to transform').descEl.textContent).toContain('When dictation stops');
  expect(
    (view.contentEl as unknown as TestElement).findByClass('local-dictation-sidebar__summary'),
  ).toBeUndefined();
});

it('preserves the sidebar scroll position across a settings rerender', () => {
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getDictationState: () => 'idle',
    toggleDictation: vi.fn(async () => {}),
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

it('keeps dictation controls available when AI transformations are disabled', async () => {
  Setting.reset();
  const toggleDictation = vi.fn(async () => {});
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, llmFeaturesEnabled: false }),
    getDictationState: () => 'idle',
    toggleDictation,
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
  });
  view.refresh();
  const start = Setting.buttonNamed('Start dictation');
  await start.click();
  expect(toggleDictation).toHaveBeenCalledOnce();
  view.updateDictationState('listening');
  expect(start.text).toBe('Stop dictation');
  view.updateDictationState('speech_detected');
  expect(start.text).toBe('Stop dictation');
  view.updateDictationState('idle');
  expect(start.text).toBe('Start dictation');
});

it('opens the active preset from its timing summary and ignores close callbacks after the view closes', async () => {
  Setting.reset();
  let onClosed: (() => void) | undefined;
  const editPreset = vi.fn((_ref: string, closed: () => void) => {
    onClosed = closed;
  });
  const settings = resolvePluginSettings({ llmPostprocessActivePresetRef: 'builtin:summary' });
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => settings,
    getDictationState: () => 'idle',
    toggleDictation: vi.fn(async () => {}),
    editPreset,
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
  });
  view.refresh();
  await Setting.buttonNamed('Edit preset').click();
  expect(editPreset.mock.calls[0]?.[0]).toBe('user:default:summary');
  const content = view.contentEl as unknown as TestElement;
  const first = content.children[0];
  await view.onClose();
  onClosed?.();
  expect(content.children[0]).toBe(first);
});

it('keeps raw dictation controls in one native section without repeated mode banners', () => {
  Setting.reset();
  const view = new LocalDictationView({ app: {} } as unknown as WorkspaceLeaf, {
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getDictationState: () => 'idle',
    toggleDictation: vi.fn(async () => {}),
    getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, llmPostprocessMode: 'off' }),
    mutatePresetState: vi.fn(async () => {}),
    mutateSettings: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
  });
  view.refresh();
  const content = view.contentEl as unknown as TestElement;
  expect(content.findByClass('local-dictation-sidebar__header')).toBeUndefined();
  expect(content.findByClass('local-dictation-sidebar__empty')).toBeUndefined();
  expect(content.findByClass('local-dictation-sidebar__summary')).toBeUndefined();
  expect(Setting.named('AI transformations')).toBeDefined();
  expect(Setting.named('Transform new dictation').onlyToggle().value).toBe(false);
  expect(Setting.named('Transform new dictation').descEl.textContent).toContain('raw transcript');
  expect(Setting.buttonNamed('Start dictation')).toBeDefined();
});
