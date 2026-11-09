import { Setting, setTooltip } from 'obsidian';
import {
  describePresetBehavior,
  describePresetTiming,
  isLlmPresetTiming,
  listPresetEntries,
  resolveActivePresetEntry,
} from '../llm/presets';
import type { LlmPresetStateMutation, PluginSettingsMutation } from '../settings/llm-preset-state';
import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import { activePresetOverride } from './llm-preset-overrides';

interface DailyControlDependencies {
  getSettings: () => PluginSettings;
  mutateSettings: (mutation: PluginSettingsMutation) => Promise<void>;
  mutatePresetState: (mutation: LlmPresetStateMutation) => Promise<void>;
  rerender: () => void;
  managePresets?: () => void;
  openTimingSettings?: () => void;
  openContextSettings?: () => void;
}

export function renderLlmDailyControls(parent: HTMLElement, deps: DailyControlDependencies): void {
  const settings = deps.getSettings();
  new Setting(parent)
    .setName(t('llm.sidebar.enabled.name'))
    .setDesc(t('llm.sidebar.enabled.description'))
    .addToggle((toggle) => {
      toggle.setValue(settings.llmPostprocessMode !== 'off');
      toggle.onChange(async (enabled) => {
        await deps.mutateSettings((current) => ({
          ...current,
          llmPostprocessMode: enabled ? current.llmPostprocessLastEnabledMode : 'off',
        }));
        deps.rerender();
      });
    });
  const entries = listPresetEntries(settings.llmPostprocessUserPresets);
  const active = resolveActivePresetEntry(
    settings.llmPostprocessActivePresetRef,
    settings.llmPostprocessUserPresets,
  );
  const presetSetting = new Setting(parent)
    .setName(t('llm.sidebar.activePreset'))
    .setDesc(active.preset.description ?? describePresetBehavior(active.preset))
    .addDropdown((dropdown) => {
      for (const entry of entries)
        dropdown.addOption(
          entry.ref,
          entry.preset.timing === 'per_utterance'
            ? t('llm.preset.option.perUtterance', { preset: entry.preset.label })
            : entry.preset.label,
        );
      if (entries.length === 0) {
        dropdown.addOption('', t('llm.preset.none'));
        dropdown.setDisabled(true);
      }
      dropdown.setValue(active.ref);
      setTooltip(dropdown.selectEl, active.preset.label);
      dropdown.onChange(async (value) => {
        await deps.mutatePresetState((state) => ({ ...state, activePresetRef: value }));
        deps.rerender();
      });
    });
  const managePresets = deps.managePresets;
  if (managePresets) {
    const label = t('llm.preset.manager.title');
    presetSetting.addExtraButton((button) => {
      button.setIcon('settings').setTooltip(label).onClick(managePresets);
      button.extraSettingsEl.setAttribute('aria-label', label);
    });
  }
  const timingSetting = new Setting(parent)
    .setName(t('llm.sidebar.runTransform.name'))
    .setDesc(
      active.preset.timing === undefined
        ? t('llm.sidebar.runTransform.description')
        : t('llm.sidebar.runTransform.setByPreset', {
            preset: active.preset.label,
            timing: describePresetTiming(active.preset.timing),
          }),
    )
    .addDropdown((dropdown) => {
      dropdown.addOption('per_utterance', t('llm.timing.option.perUtterance'));
      dropdown.addOption('batch', t('llm.timing.option.batch'));
      dropdown.setValue(
        active.preset.timing ??
          (settings.llmPostprocessMode === 'off'
            ? settings.llmPostprocessLastEnabledMode
            : settings.llmPostprocessMode),
      );
      dropdown.setDisabled(active.preset.timing !== undefined);
      dropdown.onChange(async (value) => {
        if (!isLlmPresetTiming(value)) return;
        await deps.mutateSettings((current) => ({
          ...current,
          llmPostprocessLastEnabledMode: value,
          llmPostprocessMode: current.llmPostprocessMode === 'off' ? 'off' : value,
        }));
        deps.rerender();
      });
    });
  const openTimingSettings = deps.openTimingSettings;
  if (openTimingSettings) {
    const label = t('llm.timing.title');
    timingSetting.addExtraButton((button) => {
      button.setIcon('settings').setTooltip(label).onClick(openTimingSettings);
      button.extraSettingsEl.setAttribute('aria-label', label);
    });
  }
  new Setting(parent)
    .setName(t('llm.sidebar.showOriginal.name'))
    .setDesc(t('llm.sidebar.showOriginal.description'))
    .addToggle((toggle) => {
      toggle.setValue(settings.llmPostprocessShowRawBelow);
      toggle.onChange(async (value) => {
        await deps.mutateSettings((current) => ({ ...current, llmPostprocessShowRawBelow: value }));
      });
    });
  const override = activePresetOverride(settings, 'useNoteContext');
  const contextSetting = new Setting(parent)
    .setName(t('llm.context.useCurrentNote.name'))
    .setDesc(
      override !== null
        ? t('llm.managedByPreset', { preset: override.label })
        : t('llm.context.useCurrentNote.description'),
    )
    .addToggle((toggle) => {
      toggle.setValue(override !== null ? override.value === true : settings.useLlmNoteContext);
      toggle.setDisabled(override !== null);
      toggle.onChange(async (value) => {
        await deps.mutateSettings((current) => ({ ...current, useLlmNoteContext: value }));
      });
    });
  const openContextSettings = deps.openContextSettings;
  if (openContextSettings) {
    const label = t('llm.context.title');
    contextSetting.addExtraButton((button) => {
      button.setIcon('settings').setTooltip(label).onClick(openContextSettings);
      button.extraSettingsEl.setAttribute('aria-label', label);
    });
  }
}
