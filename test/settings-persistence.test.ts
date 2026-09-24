import { describe, expect, it, vi } from 'vitest';

import LocalSttPlugin from '../src/main';
import { LlmPresetStateStore } from '../src/settings/llm-preset-state';
import {
  DEFAULT_PLUGIN_SETTINGS,
  type PluginSettings,
  resolvePluginSettings,
} from '../src/settings/plugin-settings';

interface TestablePlugin {
  applySettings: (settings: PluginSettings, options: { persist: boolean }) => Promise<void>;
  settings: PluginSettings;
}

function createTestPlugin(initial: PluginSettings, saveData: () => Promise<void>): TestablePlugin {
  const plugin = Object.create(LocalSttPlugin.prototype) as TestablePlugin;
  const lastUtteranceRecovery = { setEnabled: vi.fn() };
  const rawTranscriptRecovery = { setEnabled: vi.fn() };
  Object.assign(plugin, {
    dictationController: null,
    lastUtteranceRecovery,
    rawTranscriptRecovery,
    readAloudController: null,
    readAloudFollowAlong: null,
    saveData,
    settings: initial,
    syncLocalDictationSidebar: vi.fn(),
  });
  return plugin;
}

describe('settings persistence', () => {
  it('does not publish settings or side effects when saveData rejects', async () => {
    const previous = resolvePluginSettings(DEFAULT_PLUGIN_SETTINGS);
    const saveData = vi.fn(async () => {
      throw new Error('disk full');
    });
    const plugin = createTestPlugin(previous, saveData);
    const lastUtteranceRecovery = (
      plugin as unknown as { lastUtteranceRecovery: { setEnabled: ReturnType<typeof vi.fn> } }
    ).lastUtteranceRecovery;
    const rawTranscriptRecovery = (
      plugin as unknown as { rawTranscriptRecovery: { setEnabled: ReturnType<typeof vi.fn> } }
    ).rawTranscriptRecovery;

    await expect(
      plugin.applySettings({ ...previous, developerMode: true }, { persist: true }),
    ).rejects.toThrow('disk full');

    expect(plugin.settings).toBe(previous);
    expect(saveData).toHaveBeenCalledWith({ ...previous, developerMode: true });
    expect(lastUtteranceRecovery.setEnabled).not.toHaveBeenCalled();
    expect(rawTranscriptRecovery.setEnabled).not.toHaveBeenCalled();
  });

  it('keeps the latest unrelated snapshot when the store save rejects', async () => {
    const initial = resolvePluginSettings(DEFAULT_PLUGIN_SETTINGS);
    const latest = { ...initial, autoCopyFinalizedUtterances: true };
    const saveData = vi.fn(async () => {
      throw new Error('disk full');
    });
    const plugin = createTestPlugin(latest, saveData);
    const store = new LlmPresetStateStore({
      commit: (settings, options) => plugin.applySettings(settings, options),
      getSettings: () => plugin.settings,
      loadData: async () => plugin.settings,
      onExternalChange: vi.fn(),
      warn: vi.fn(),
    });

    await expect(
      store.mutateSettings((settings) => ({ ...settings, developerMode: true })),
    ).rejects.toThrow('disk full');

    expect(plugin.settings).toBe(latest);
    expect(plugin.settings.autoCopyFinalizedUtterances).toBe(true);
    expect(plugin.settings.developerMode).toBe(false);
  });
});
