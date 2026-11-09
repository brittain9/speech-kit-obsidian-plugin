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
    restoreDefaults: vi.fn(),
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
    restoreDefaults: vi.fn(),
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

it('persists the global enable switch without overwriting other settings', async () => {
  Setting.reset();
  let settings: PluginSettings = { ...DEFAULT_PLUGIN_SETTINGS, llmNetworkTimeoutSec: 42 };
  renderLlmProviderSettings(new TestElement() as unknown as HTMLElement, {
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
    restoreDefaults: vi.fn(),
  });
  Setting.named('Enable LLM features').onlyToggle().change(true);
  await vi.waitFor(() => expect(settings.llmFeaturesEnabled).toBe(true));
  expect(settings.llmNetworkTimeoutSec).toBe(42);
});

it('keeps the saved transform mode while global features are disabled', async () => {
  Setting.reset();
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmFeaturesEnabled: false,
    llmPostprocessMode: 'batch',
  };
  renderLlmProviderSettings(new TestElement() as unknown as HTMLElement, {
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
    restoreDefaults: vi.fn(),
  });
  const transform = Setting.named('Transform new dictation').onlyToggle();
  expect(transform.toggleEl.disabled).toBe(true);
  expect(transform.value).toBe(true);
  Setting.named('Enable LLM features').onlyToggle().change(true);
  await vi.waitFor(() => expect(settings.llmFeaturesEnabled).toBe(true));
  await vi.waitFor(() => {
    const current = Setting.instances
      .filter((setting) => setting.name === 'Transform new dictation')
      .at(-1);
    expect(current?.onlyToggle().toggleEl.disabled).toBe(false);
  });
  expect(settings.llmPostprocessMode).toBe('batch');
});

it('opens advanced model settings before a provider is selected', async () => {
  Setting.reset();
  const openModelSettings = vi.fn();
  renderLlmProviderSettings(new TestElement() as unknown as HTMLElement, {
    app: {} as App,
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    managePresets: vi.fn(),
    mutatePresetState: vi.fn(async () => {}),
    openContextSettings: vi.fn(),
    openModelSettings,
    openTimingSettings: vi.fn(),
    persist: vi.fn(async () => {}),
    restoreDefaults: vi.fn(),
  });
  const button = Setting.named('Provider').extraButtonComponents.find(
    (candidate) => candidate.tooltip === 'Advanced model settings',
  );
  expect(button).toBeDefined();
  expect(button?.extraSettingsEl.getAttribute('aria-label')).toBe('Advanced model settings');
  await button?.click();
  expect(openModelSettings).toHaveBeenCalledOnce();
});

it('groups daily and provider controls and opens advanced settings beside their choices', async () => {
  Setting.reset();
  const managePresets = vi.fn();
  const openContextSettings = vi.fn();
  const openModelSettings = vi.fn();
  const openTimingSettings = vi.fn();
  const parent = new TestElement();
  const settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
  };
  renderLlmProviderSettings(parent as unknown as HTMLElement, {
    app: {} as App,
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => settings,
    managePresets,
    mutatePresetState: vi.fn(async () => {}),
    openContextSettings,
    openModelSettings,
    openTimingSettings,
    persist: vi.fn(async () => {}),
    restoreDefaults: vi.fn(),
  });
  const preset = Setting.named('Active preset');
  const timing = Setting.named('Run transform');
  const context = Setting.named('Use current note as context');
  const provider = Setting.named('Provider');
  const model = Setting.named('Model');
  const dailyGroup = preset.settingEl.closest('.setting-group');
  const providerGroup = provider.settingEl.closest('.setting-group');
  expect(dailyGroup).not.toBeNull();
  expect(providerGroup).not.toBeNull();
  expect(providerGroup).not.toBe(dailyGroup);
  expect(Setting.named('Enable LLM features').settingEl.closest('.setting-group')).toBe(dailyGroup);
  expect(timing.settingEl.closest('.setting-group')).toBe(dailyGroup);
  expect(model.settingEl.closest('.setting-group')).toBe(providerGroup);
  const action = (setting: Setting, label: string) => {
    const button = setting.extraButtonComponents.find((candidate) => candidate.tooltip === label);
    if (button === undefined) throw new Error(`Missing adjacent action: ${label}`);
    expect(button.extraSettingsEl.getAttribute('aria-label')).toBe(label);
    return button;
  };
  await action(preset, 'Manage presets').click();
  await action(timing, 'Timing settings').click();
  await action(context, 'Context settings').click();
  await action(model, 'Advanced model settings').click();
  expect(managePresets).toHaveBeenCalledOnce();
  expect(openTimingSettings).toHaveBeenCalledOnce();
  expect(openContextSettings).toHaveBeenCalledOnce();
  expect(openModelSettings).toHaveBeenCalledOnce();
  expect(Setting.instances.some((setting) => setting.name === 'Manage presets')).toBe(false);
  expect(Setting.named('Enable LLM features').descEl.textContent).toContain(
    'Settings or the sidebar',
  );
});
