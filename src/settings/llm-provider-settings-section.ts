import { Setting } from 'obsidian';
import { t } from '../shared/i18n';
import { renderLlmDailyControls } from '../ui/llm-daily-controls';
import {
  LlmRoutingControls,
  type LlmRoutingControlsDependencies,
} from '../ui/llm-routing-controls';
import type { LlmPresetStateMutation } from './llm-preset-state';
import { captureSettingsFocus, restoreSettingsFocus } from './settings-tab-lifecycle';

interface LlmProviderSettingsDependencies extends LlmRoutingControlsDependencies {
  managePresets: () => void;
  mutatePresetState: (mutation: LlmPresetStateMutation) => Promise<void>;
  openContextSettings: () => void;
  openModelSettings: () => void;
  openTimingSettings: () => void;
}

export function renderLlmProviderSettings(
  parent: HTMLElement,
  dependencies: LlmProviderSettingsDependencies,
): () => void {
  const dailyHost = parent.createDiv({ cls: 'local-dictation-settings-rows' });
  const routingHost = parent.createDiv({ cls: 'local-dictation-settings-rows' });
  let disposed = false;
  const render = (): void => {
    if (disposed) return;
    const focus = captureSettingsFocus(parent);
    dailyHost.empty();
    renderLlmDailyControls(dailyHost, {
      getSettings: dependencies.getSettings,
      mutateSettings: dependencies.persist,
      mutatePresetState: dependencies.mutatePresetState,
      rerender: render,
    });
    routingHost.empty();
    controls.render(routingHost, dependencies.getSettings());
    restoreSettingsFocus(parent, focus);
  };
  const controls = new LlmRoutingControls({
    ...dependencies,
    persist: async (settings, options) => {
      await dependencies.persist(settings, options);
      if (options?.rerender ?? true) render();
    },
  });
  render();
  new Setting(parent).setName(t('llm.timing.title')).addButton((button) => {
    button.setButtonText(t('llm.timing.title')).onClick(dependencies.openTimingSettings);
  });
  new Setting(parent).setName(t('llm.model.title')).addButton((button) => {
    button.setButtonText(t('llm.model.title')).onClick(dependencies.openModelSettings);
  });
  new Setting(parent).setName(t('llm.preset.manager.title')).addButton((button) => {
    button.setButtonText(t('llm.preset.manager.title')).onClick(dependencies.managePresets);
  });
  new Setting(parent).setName(t('llm.context.title')).addButton((button) => {
    button.setButtonText(t('llm.context.title')).onClick(dependencies.openContextSettings);
  });
  return () => {
    disposed = true;
    controls.dispose();
  };
}
