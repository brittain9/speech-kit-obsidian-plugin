import { type ButtonComponent, Setting, type ToggleComponent } from 'obsidian';
import { t } from '../shared/i18n';
import type { PluginSettings } from './plugin-settings';

export function diarizationSettingDescription(streamingModelSelected: boolean): string {
  return streamingModelSelected
    ? t('settings.speakerLabels.inactiveStreaming')
    : t('settings.speakerLabels.numberedVoices');
}

interface DiarizationSettingDependencies {
  getSettings: () => PluginSettings;
  saveEnabled: (enabled: boolean) => Promise<void>;
  streamingModelSelected: () => boolean;
  subscribe: (listener: () => void) => () => void;
  chooseModel: () => void;
  configure: () => void;
}

export function renderDiarizationSetting(
  parent: HTMLElement,
  deps: DiarizationSettingDependencies,
): () => void {
  let toggle: ToggleComponent;
  let chooseModel: ButtonComponent;
  const setting = new Setting(parent).setName(t('settings.speakerLabels.name'));
  setting.addToggle((control) => {
    toggle = control;
    control.onChange(async (enabled) => {
      if (!deps.streamingModelSelected()) await deps.saveEnabled(enabled);
    });
  });
  setting.addButton((button) => {
    chooseModel = button;
    button.setButtonText(t('settings.speakerLabels.chooseModel')).onClick(deps.chooseModel);
    button.buttonEl.toggle(deps.streamingModelSelected());
  });
  setting.addExtraButton((button) => {
    button.setIcon('sliders-horizontal').setTooltip(t('settings.speakerLabels.modal.title'));
    button.extraSettingsEl.setAttribute('aria-label', t('settings.speakerLabels.modal.title'));
    button.onClick(deps.configure);
  });
  const refresh = (): void => {
    const streaming = deps.streamingModelSelected();
    setting.setDesc(diarizationSettingDescription(streaming));
    toggle.setValue(!streaming && deps.getSettings().diarizationEnabled).setDisabled(streaming);
    chooseModel.buttonEl.toggle(streaming);
  };
  refresh();
  return deps.subscribe(refresh);
}
