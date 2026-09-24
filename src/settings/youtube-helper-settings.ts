import { Setting } from 'obsidian';

import {
  discoverYtDlpCandidates,
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
} from '../media/youtube-helper';
import {
  hasYouTubeRightsConfirmation,
  YOUTUBE_POLICY_VERSION,
} from '../media/youtube-media-source';
import { t } from '../shared/i18n';
import type { PluginSettings } from './plugin-settings';
import type { SettingAccess } from './setting-helpers';
import { addToggleSetting } from './setting-helpers';

export interface YouTubeHelperSettingsDependencies {
  readonly access: SettingAccess;
  readonly getSettings: () => PluginSettings;
}

export function renderYouTubeHelperSettings(
  parent: HTMLElement,
  dependencies: YouTubeHelperSettingsDependencies,
): Setting {
  addToggleSetting(parent, dependencies.access, {
    desc: t('youtube.settings.enableDesc'),
    key: 'youtubeMediaSourceEnabled',
    name: t('youtube.settings.enableName'),
  });
  const setting = new Setting(parent)
    .setName(t('youtube.settings.helperName'))
    .setDesc(t('youtube.settings.helperDesc'));
  const status = parent.createDiv({ cls: 'local-stt-youtube-helper-status' });
  const suggestions = discoverYtDlpCandidates();
  if (suggestions.length > 0) {
    status.createDiv({
      text: t('youtube.settings.suggestions', { suggestions: suggestions.join(', ') }),
    });
  }
  const policy = dependencies.getSettings().youtubePolicyVersion;
  status.createDiv({
    text: hasYouTubeRightsConfirmation(policy)
      ? t('youtube.settings.policyAccepted', { policy: YOUTUBE_POLICY_VERSION })
      : t('youtube.settings.policyRequired'),
  });

  const currentPath = dependencies.getSettings().youtubeHelperPath;
  let selectedPath = currentPath;
  const checkHelper = async (): Promise<void> => {
    const normalized = normalizeYouTubeHelperPath(selectedPath);
    if (normalized === null) {
      status.setText(t('youtube.settings.pathRequired'));
      return;
    }
    try {
      const result = await probeYtDlpVersion(normalized);
      status.setText(
        t('youtube.settings.helperReady', { version: result.version, path: result.path }),
      );
    } catch {
      status.setText(t('youtube.settings.helperError'));
    }
  };
  setting.addText((text) => {
    text.setPlaceholder(t('youtube.modal.helperPlaceholder'));
    text.setValue(currentPath);
    text.onChange(async (value) => {
      const normalized = normalizeYouTubeHelperPath(value);
      if (normalized === null) {
        status.setText(t('youtube.settings.pathRequired'));
        text.setValue(selectedPath);
        return;
      }
      selectedPath = normalized;
      await dependencies.access.persistOne('youtubeHelperPath', normalized);
      status.setText(t('youtube.settings.pathSaved'));
    });
  });
  setting.addButton((button) =>
    button.setButtonText(t('youtube.settings.checkHelper')).onClick(() => {
      void checkHelper();
    }),
  );
  return setting;
}

export function youtubeHelperDescription(settings: PluginSettings): string {
  if (!settings.youtubeMediaSourceEnabled || settings.youtubeHelperPath.length === 0) {
    return t('youtube.settings.disabledDescription');
  }
  return t('youtube.settings.enabledDescription');
}

export function youtubeHelperSettingName(): string {
  return t('commands.transcribeYouTube');
}
