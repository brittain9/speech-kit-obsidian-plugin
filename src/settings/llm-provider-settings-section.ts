import { Setting } from 'obsidian';
import { t } from '../shared/i18n';
import { styleDestructiveButton } from '../ui/destructive-button';
import { renderLlmDailyControls } from '../ui/llm-daily-controls';
import {
  LlmRoutingControls,
  type LlmRoutingControlsDependencies,
} from '../ui/llm-routing-controls';
import type { LlmPresetStateMutation } from './llm-preset-state';
import { createSettingGroup } from './setting-helpers';
import { captureSettingsFocus, restoreSettingsFocus } from './settings-tab-lifecycle';

interface LlmProviderSettingsDependencies extends LlmRoutingControlsDependencies {
  managePresets: () => void;
  mutatePresetState: (mutation: LlmPresetStateMutation) => Promise<void>;
  openContextSettings: () => void;
  openModelSettings: () => void;
  openTimingSettings: () => void;
  restoreDefaults: () => void;
}

export function renderLlmProviderSettings(
  parent: HTMLElement,
  dependencies: LlmProviderSettingsDependencies,
): () => void {
  const dailyHost = createSettingGroup(parent, t('settings.groups.llmTransformation'));
  const routingHost = createSettingGroup(parent, t('settings.groups.llmProviders'));
  let disposed = false;
  const render = (): void => {
    if (disposed) return;
    const dailyFocus = captureSettingsFocus(dailyHost);
    const routingFocus = captureSettingsFocus(routingHost);
    dailyHost.empty();
    new Setting(dailyHost)
      .setName(t('settings.llm.enableFeatures.name'))
      .setDesc(t('settings.llm.enableFeatures.desc'))
      .addToggle((toggle) => {
        toggle.setValue(dependencies.getSettings().llmFeaturesEnabled);
        toggle.onChange(async (value) => {
          await dependencies.persist((current) => ({ ...current, llmFeaturesEnabled: value }));
          render();
        });
      });
    renderLlmDailyControls(dailyHost, {
      getSettings: dependencies.getSettings,
      mutateSettings: dependencies.persist,
      mutatePresetState: dependencies.mutatePresetState,
      rerender: render,
      managePresets: dependencies.managePresets,
      openTimingSettings: dependencies.openTimingSettings,
      openContextSettings: dependencies.openContextSettings,
    });
    new Setting(dailyHost)
      .setName(t('settings.llm.restoreDefaults.name'))
      .setDesc(t('settings.llm.restoreDefaults.editableDesc'))
      .addButton((button) => {
        styleDestructiveButton(
          button.setButtonText(t('settings.llm.restoreDefaults.button')),
        ).onClick(dependencies.restoreDefaults);
      });
    routingHost.empty();
    controls.render(routingHost, dependencies.getSettings());
    restoreSettingsFocus(dailyHost, dailyFocus);
    restoreSettingsFocus(routingHost, routingFocus);
  };
  const controls = new LlmRoutingControls({
    ...dependencies,
    persist: async (settings, options) => {
      await dependencies.persist(settings, options);
      if (options?.rerender ?? true) render();
    },
  });
  render();
  return () => {
    disposed = true;
    controls.dispose();
  };
}
