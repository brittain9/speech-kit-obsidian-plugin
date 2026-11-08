import { type ButtonComponent, Setting } from 'obsidian';

import { isMediaToolInstalled } from '../audio/media-tool-installer';
import { t } from '../shared/i18n';
import type { UserFeedback } from '../shared/user-feedback';
import type { MediaToolInstallModalCallbacks } from '../ui/media-tool-install-modal';

export interface MediaToolSettingDependencies {
  readonly feedback: Pick<UserFeedback, 'show'>;
  readonly isDictationBusy: () => boolean;
  readonly openInstaller: (
    pluginDirectory: string,
    callbacks: Required<MediaToolInstallModalCallbacks>,
  ) => void;
  readonly resolvePluginDirectory: () => Promise<string>;
}

export function renderMediaToolSetting(
  parent: HTMLElement,
  dependencies: MediaToolSettingDependencies,
): () => void {
  const setting = new Setting(parent)
    .setName(t('media.tools.title'))
    .setDesc(t('settings.model.checking'));
  let disposed = false;
  let generation = 0;
  let pluginDirectory: string | null = null;
  let installing = false;

  let button!: ButtonComponent;
  setting.addButton((component) => {
    button = component;
    component.setButtonText(t('settings.model.checking')).setDisabled(true);
  });

  const refresh = async (): Promise<void> => {
    const currentGeneration = ++generation;
    try {
      const directory = await dependencies.resolvePluginDirectory();
      const installed = await isMediaToolInstalled(directory);
      if (disposed || currentGeneration !== generation) return;
      pluginDirectory = directory;
      setting.setDesc(installed ? t('media.tools.ready') : t('media.tools.settingsDesc'));
      button.setButtonText(installed ? t('media.tools.reinstall') : t('media.tools.install'));
      button.setDisabled(installing);
    } catch {
      if (disposed || currentGeneration !== generation) return;
      pluginDirectory = null;
      setting.setDesc(t('media.tools.settingsDesc'));
      button.setButtonText(t('media.tools.install'));
      button.setDisabled(installing);
    }
  };

  button.onClick(() => {
    if (dependencies.isDictationBusy()) {
      dependencies.feedback.show({
        intent: 'action-required',
        message: t('media.tools.busy'),
      });
      return;
    }

    if (installing) return;

    installing = true;
    button.setDisabled(true);
    void (async () => {
      try {
        const directory = pluginDirectory ?? (await dependencies.resolvePluginDirectory());
        if (disposed) return;
        pluginDirectory = directory;
        dependencies.openInstaller(directory, {
          onClosed: () => {
            installing = false;
            void refresh();
          },
          onInstalled: () => {
            void refresh();
          },
        });
      } catch (error) {
        installing = false;
        button.setDisabled(false);
        dependencies.feedback.show({
          cause: error,
          intent: 'error',
          message: t('media.tools.failed'),
        });
      }
    })();
  });

  void refresh();

  return () => {
    disposed = true;
    generation += 1;
  };
}
