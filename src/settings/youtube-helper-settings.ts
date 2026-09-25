import { Setting } from 'obsidian';

import { isYouTubeSupportedPlatform, probeYtDlpVersion } from '../media/youtube-helper';
import { t } from '../shared/i18n';
import type { PluginSettings } from './plugin-settings';
import type { SettingAccess } from './setting-helpers';
import { addToggleSetting } from './setting-helpers';

export interface YouTubeHelperSettingsDependencies {
  readonly access: SettingAccess;
  readonly getSettings: () => PluginSettings;
  readonly installPinnedHelper?: () => Promise<string>;
  readonly isPlatformSupported?: () => boolean;
}

export function renderYouTubeHelperSettings(
  parent: HTMLElement,
  dependencies: YouTubeHelperSettingsDependencies,
): Setting {
  const isPlatformSupported = dependencies.isPlatformSupported ?? isYouTubeSupportedPlatform;
  if (!isPlatformSupported()) {
    return new Setting(parent)
      .setName(t('youtube.settings.helperName'))
      .setDesc(t('youtube.settings.unsupportedPlatform'));
  }

  addToggleSetting(parent, dependencies.access, {
    desc: t('youtube.settings.enableDesc'),
    key: 'youtubeMediaSourceEnabled',
    name: t('youtube.settings.enableName'),
  });

  const setting = new Setting(parent)
    .setName(t('youtube.settings.helperName'))
    .setDesc(t('youtube.settings.helperDesc'));
  const status = setting.descEl.createDiv({
    cls: 'local-stt-youtube-helper-status',
    attr: { 'aria-atomic': 'true', 'aria-live': 'polite', role: 'status' },
  });

  let selectedPath = dependencies.getSettings().youtubeHelperPath;
  let probeGeneration = 0;
  let probeController: AbortController | null = null;
  const checkHelper = async (path: string): Promise<void> => {
    probeController?.abort();
    const controller = new AbortController();
    probeController = controller;
    const generation = ++probeGeneration;
    try {
      const result = await probeYtDlpVersion(path, { signal: controller.signal });
      if (!controller.signal.aborted && generation === probeGeneration) {
        status.setText(t('youtube.settings.helperReady', { version: result.version }));
      }
    } catch {
      if (!controller.signal.aborted && generation === probeGeneration) {
        status.setText(t('youtube.settings.helperError'));
      }
    } finally {
      if (probeController === controller) probeController = null;
    }
  };

  if (selectedPath) {
    status.setText(t('youtube.settings.checkingHelper'));
    void checkHelper(selectedPath);
  } else {
    status.setText(t('youtube.settings.helperMissing'));
  }

  if (dependencies.installPinnedHelper !== undefined) {
    setting.addButton((button) =>
      button.setButtonText(t('youtube.settings.installHelper')).onClick(async () => {
        button.setDisabled(true);
        probeGeneration += 1;
        probeController?.abort();
        status.setText(t('youtube.settings.installingHelper'));
        try {
          const installedPath = await dependencies.installPinnedHelper?.();
          if (!installedPath) throw new Error('No helper was installed.');
          await dependencies.access.persistOne('youtubeHelperPath', installedPath);
          selectedPath = installedPath;
          await checkHelper(selectedPath);
        } catch (error) {
          status.setText(
            error instanceof Error && error.message
              ? t('youtube.settings.installFailedDetail', { reason: error.message })
              : t('youtube.settings.installFailed'),
          );
        } finally {
          button.setDisabled(false);
        }
      }),
    );
  }
  return setting;
}
