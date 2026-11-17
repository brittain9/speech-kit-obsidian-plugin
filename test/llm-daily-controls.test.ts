import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';
import { renderLlmDailyControls } from '../src/ui/llm-daily-controls';
import { Setting, TestElement } from './__mocks__/obsidian';
import { createUserPreset } from './fixtures/llm';

beforeEach(() => Setting.reset());

it('shows preset-owned timing as a summary and edits that exact preset', async () => {
  const preset = createUserPreset({
    id: 'recap',
    label: 'Recap',
    timing: 'batch',
    output: 'add_below',
    description: 'A friendly recap.',
    overrides: { minWords: 12 },
  });
  const settings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmPostprocessActivePresetRef: 'user:recap',
    llmPostprocessUserPresets: [preset],
  };
  const editPreset = vi.fn();
  renderLlmDailyControls(new TestElement() as unknown as HTMLElement, {
    getSettings: () => settings,
    mutateSettings: vi.fn(async () => {}),
    mutatePresetState: vi.fn(async () => {}),
    rerender: vi.fn(),
    editPreset,
  });
  const timing = Setting.named(t('llm.sidebar.runTransform.name'));
  expect(timing.dropdownComponents).toHaveLength(0);
  expect(timing.descEl.textContent).toContain('When dictation stops');
  expect(Setting.named('Active preset').descEl.textContent).toContain(
    'adds new content below the transcript',
  );
  expect(Setting.named('Active preset').descEl.textContent).not.toContain('min words');
  expect(Setting.named('Active preset').descEl.textContent).not.toContain('When dictation stops');
  expect(
    Setting.named('Active preset').onlyDropdown().selectEl.getAttribute('aria-description'),
  ).toContain('min words');
  await timing.buttonComponents.find((button) => button.text === 'Edit preset')?.click();
  expect(editPreset).toHaveBeenCalledExactlyOnceWith('user:recap');
});

it('keeps unrestricted timing editable without enabling automatic transformation', async () => {
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmPostprocessMode: 'off',
    llmPostprocessActivePresetRef: 'user:free',
    llmPostprocessUserPresets: [createUserPreset({ id: 'free' })],
  };
  renderLlmDailyControls(new TestElement() as unknown as HTMLElement, {
    getSettings: () => settings,
    mutateSettings: async (mutate) => {
      settings = mutate(settings);
    },
    mutatePresetState: vi.fn(async () => {}),
    rerender: vi.fn(),
  });
  Setting.named(t('llm.sidebar.runTransform.name')).onlyDropdown().change('batch');
  await vi.waitFor(() => expect(settings.llmPostprocessLastEnabledMode).toBe('batch'));
  expect(settings.llmPostprocessMode).toBe('off');
});

it('ignores a stale unrestricted selector after switching to preset-owned timing', async () => {
  const free = createUserPreset({ id: 'free' });
  const pinned = createUserPreset({ id: 'pinned', timing: 'batch' });
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmPostprocessActivePresetRef: 'user:free',
    llmPostprocessUserPresets: [free, pinned],
  };
  const mutateSettings = vi.fn(async () => {});
  renderLlmDailyControls(new TestElement() as unknown as HTMLElement, {
    getSettings: () => settings,
    mutateSettings,
    mutatePresetState: vi.fn(async () => {}),
    rerender: vi.fn(),
  });
  const timing = Setting.named(t('llm.sidebar.runTransform.name')).onlyDropdown();
  settings = { ...settings, llmPostprocessActivePresetRef: 'user:pinned' };
  timing.change('per_utterance');
  await Promise.resolve();
  expect(mutateSettings).not.toHaveBeenCalled();
});

it('keeps timing inert when every preset has been deleted', () => {
  const settings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmPostprocessActivePresetRef: '',
    llmPostprocessUserPresets: [],
  };
  const mutateSettings = vi.fn(async () => {});
  renderLlmDailyControls(new TestElement() as unknown as HTMLElement, {
    getSettings: () => settings,
    mutateSettings,
    mutatePresetState: vi.fn(async () => {}),
    rerender: vi.fn(),
  });
  expect(Setting.named(t('llm.sidebar.runTransform.name')).dropdownComponents).toHaveLength(0);
  expect(Setting.named(t('llm.sidebar.runTransform.name')).descEl.textContent).toBe(
    t('llm.preset.none'),
  );
  expect(Setting.named('Active preset').descEl.textContent).toBe(t('llm.preset.none'));
  expect(mutateSettings).not.toHaveBeenCalled();
});
