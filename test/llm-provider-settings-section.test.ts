import type { App } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { renderLlmProviderSettings } from '../src/settings/llm-provider-settings-section';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { Setting, TestElement } from './__mocks__/obsidian';

it('offers provider configuration and preset and context settings in Settings', async () => {
  Setting.reset();
  const managePresets = vi.fn();
  const openContextSettings = vi.fn();
  const openModelSettings = vi.fn();
  const openTimingSettings = vi.fn();
  renderLlmProviderSettings(new TestElement() as unknown as HTMLElement, {
    app: {} as App,
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    managePresets,
    mutatePresetState: vi.fn(async () => {}),
    openContextSettings,
    openModelSettings,
    openTimingSettings,
    persist: vi.fn(async () => {}),
  });
  expect(
    Setting.named('Provider')
      .onlyDropdown()
      .selectEl.options.map((option) => option.label),
  ).toContain('Ollama');
  expect(Setting.named('Transform new dictation').onlyToggle().value).toBe(false);
  expect(Setting.named('Active preset').onlyDropdown()).toBeDefined();
  expect(Setting.named('Run transform').onlyDropdown()).toBeDefined();
  expect(Setting.named('Show original transcript').onlyToggle()).toBeDefined();
  await Setting.buttonNamed('Timing settings').click();
  expect(openTimingSettings).toHaveBeenCalledOnce();
  await Setting.buttonNamed('Advanced model settings').click();
  expect(openModelSettings).toHaveBeenCalledOnce();
  await Setting.buttonNamed('Manage presets').click();
  await Setting.buttonNamed('Context settings').click();
  expect(managePresets).toHaveBeenCalledOnce();
  expect(openContextSettings).toHaveBeenCalledOnce();
});

it('keeps the secret control mounted when leaving the edited URL for a click', async () => {
  Setting.reset();
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
  };
  const parent = new TestElement();
  renderLlmProviderSettings(parent as unknown as HTMLElement, {
    app: {} as App,
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => settings,
    managePresets: vi.fn(),
    mutatePresetState: vi.fn(async () => {}),
    openContextSettings: vi.fn(),
    openModelSettings: vi.fn(),
    openTimingSettings: vi.fn(),
    persist: async (mutation) => {
      settings = mutation(settings);
    },
  });
  const url = Setting.named('Base URL').onlyText();
  const secretRow = Setting.named('API key').settingEl;
  Object.defineProperty(url.inputEl, 'isConnected', { value: true });
  url.inputEl.dispatchEvent({ type: 'focus' });
  url.change('http://127.0.0.1:62819/v1');
  await Promise.resolve();
  parent.dispatchEvent({ type: 'pointerdown' });
  url.inputEl.dispatchEvent({ type: 'blur' });
  expect(parent.contains(secretRow)).toBe(true);
});
