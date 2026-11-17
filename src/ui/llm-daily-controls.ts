import { Setting, setTooltip } from 'obsidian';
import {
  describePresetBehavior,
  describePresetOutput,
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
  editPreset?: (ref: string) => void;
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
      toggle.setDisabled(!settings.llmFeaturesEnabled);
      toggle.onChange(async (enabled) => {
        if (!deps.getSettings().llmFeaturesEnabled) return;
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
  const effectiveTiming =
    active.preset.timing ??
    (settings.llmPostprocessMode === 'off'
      ? settings.llmPostprocessLastEnabledMode
      : settings.llmPostprocessMode);
  const timingLabel = t(
    effectiveTiming === 'batch' ? 'llm.timing.option.batch' : 'llm.timing.option.perUtterance',
  );
  const detail = [active.preset.description, describePresetBehavior(active.preset)]
    .filter(Boolean)
    .join(' · ');
  const presetSetting = new Setting(parent)
    .setName(t('llm.sidebar.activePreset'))
    .setDesc(
      entries.length === 0
        ? t('llm.preset.none')
        : `${describePresetOutput(active.preset.output)}.`,
    )
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
      setTooltip(dropdown.selectEl, detail);
      dropdown.selectEl.setAttribute('aria-description', detail);
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
  const timingSetting = new Setting(parent).setName(t('llm.sidebar.runTransform.name'));
  if (entries.length === 0) {
    timingSetting.setDesc(t('llm.preset.none'));
  } else if (active.preset.timing !== undefined) {
    timingSetting.setDesc(
      t('llm.sidebar.runTransform.fixed', { preset: active.preset.label, timing: timingLabel }),
    );
    if (deps.editPreset !== undefined) {
      timingSetting.addButton((button) => {
        button.setButtonText(t('llm.preset.manager.editTooltip')).onClick(() => {
          const current = deps.getSettings();
          if (!current.llmFeaturesEnabled) return;
          const entry = resolveActivePresetEntry(
            current.llmPostprocessActivePresetRef,
            current.llmPostprocessUserPresets,
          );
          deps.editPreset?.(entry.ref);
        });
      });
    }
  } else {
    timingSetting.setDesc(t('llm.sidebar.runTransform.description')).addDropdown((dropdown) => {
      dropdown.addOption('per_utterance', t('llm.timing.option.perUtterance'));
      dropdown.addOption('batch', t('llm.timing.option.batch'));
      dropdown.setValue(effectiveTiming);
      dropdown.onChange(async (value) => {
        if (!isLlmPresetTiming(value)) return;
        if (!canEditSharedTiming(deps.getSettings())) return;
        await deps.mutateSettings((current) => {
          if (!canEditSharedTiming(current)) return current;
          return {
            ...current,
            llmPostprocessLastEnabledMode: value,
            llmPostprocessMode: current.llmPostprocessMode === 'off' ? 'off' : value,
          };
        });
        deps.rerender();
      });
    });
  }
  const openTimingSettings = deps.openTimingSettings;
  if (openTimingSettings) {
    const label = t('llm.timing.advancedTooltip');
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

function canEditSharedTiming(settings: PluginSettings): boolean {
  return (
    settings.llmFeaturesEnabled &&
    resolveActivePresetEntry(
      settings.llmPostprocessActivePresetRef,
      settings.llmPostprocessUserPresets,
    ).preset.timing === undefined
  );
}
