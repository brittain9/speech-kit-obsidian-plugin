import type { App } from 'obsidian';
import { Modal, Setting } from 'obsidian';

import { t } from '../shared/i18n';
import { isDictationControlLocation } from './plugin-settings';
import { addEnumSetting, addToggleSetting, type SettingAccess } from './setting-helpers';

interface CustomizeToolsDependencies {
  access: SettingAccess;
  onChanged: () => void;
  onClosed?: () => void;
  onDialogOpened?: () => () => void;
}

export function renderCustomizeToolsSetting(
  parent: HTMLElement,
  app: App,
  dependencies: CustomizeToolsDependencies,
): Setting {
  return new Setting(parent)
    .setName(t('settings.features.title'))
    .setDesc(t('settings.features.rowDescription'))
    .addButton((button) => {
      button.setButtonText(t('settings.features.customize')).onClick(() => {
        const restoreFocus = dependencies.onDialogOpened?.();
        new CustomizeToolsModal(app, {
          ...dependencies,
          onClosed: () => {
            dependencies.onClosed?.();
            restoreFocus?.();
          },
        }).open();
      });
    });
}

class CustomizeToolsModal extends Modal {
  constructor(
    app: App,
    private readonly dependencies: CustomizeToolsDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t('settings.features.title'));
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: t('settings.features.description'),
      cls: 'setting-item-description',
    });
    const { access, onChanged } = this.dependencies;
    addToggleSetting(this.contentEl, access, {
      name: t('settings.features.translation'),
      desc: t('settings.features.translationDesc'),
      key: 'translationEnabled',
      onChange: onChanged,
    });
    addToggleSetting(this.contentEl, access, {
      name: t('settings.features.readAloud'),
      desc: t('settings.features.readAloudDesc'),
      key: 'readAloudEnabled',
      onChange: onChanged,
    });
    addToggleSetting(this.contentEl, access, {
      name: t('settings.features.llm'),
      desc: t('settings.features.llmDesc'),
      key: 'llmFeaturesEnabled',
      onChange: onChanged,
    });
    addEnumSetting(this.contentEl, access, {
      name: t('settings.dictationControl.name'),
      desc: t('settings.dictationControl.description'),
      key: 'dictationControlLocation',
      isValid: isDictationControlLocation,
      options: [
        { value: 'ribbon', label: t('settings.dictationControl.ribbon') },
        { value: 'status_bar', label: t('settings.dictationControl.statusBar') },
        { value: 'both', label: t('settings.dictationControl.both') },
        { value: 'commands_only', label: t('settings.dictationControl.commandsOnly') },
      ],
    });
    addToggleSetting(this.contentEl, access, {
      name: t('desktop.enabled'),
      desc: t('desktop.enabledDesc'),
      key: 'desktopControlsEnabled',
      onChange: onChanged,
    });
  }

  override onClose(): void {
    this.contentEl.empty();
    this.dependencies.onClosed?.();
  }
}
