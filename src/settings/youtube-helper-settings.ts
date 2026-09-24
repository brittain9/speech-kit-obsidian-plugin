import { Setting } from 'obsidian';

import {
  discoverYtDlpCandidates,
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
} from '../media/youtube-helper';
import { YOUTUBE_POLICY_VERSION } from '../media/youtube-media-source';
import { t } from '../shared/i18n';
import type { PluginSettings } from './plugin-settings';
import type { SettingAccess } from './setting-helpers';

export interface YouTubeHelperSettingsDependencies {
  readonly access: SettingAccess;
  readonly getSettings: () => PluginSettings;
}

export function renderYouTubeHelperSettings(
  parent: HTMLElement,
  dependencies: YouTubeHelperSettingsDependencies,
): Setting {
  const setting = new Setting(parent)
    .setName('Experimental YouTube media source')
    .setDesc(
      'Unofficial yt-dlp helper. Select an absolute executable path; suggestions are discovered from PATH without executing candidates. No bundled installer or retention is provided.',
    );
  const status = parent.createDiv({ cls: 'local-stt-youtube-helper-status' });
  const suggestions = discoverYtDlpCandidates();
  if (suggestions.length > 0) {
    status.createDiv({ text: `Existing PATH suggestions: ${suggestions.join(', ')}` });
  }
  const policy = dependencies.getSettings().youtubePolicyVersion;
  status.createDiv({
    text:
      policy === YOUTUBE_POLICY_VERSION
        ? `Rights confirmation: accepted for ${YOUTUBE_POLICY_VERSION}.`
        : 'Rights confirmation: required before the first YouTube job.',
  });

  const currentPath = dependencies.getSettings().youtubeHelperPath;
  let selectedPath = currentPath;
  const checkHelper = async (): Promise<void> => {
    const normalized = normalizeYouTubeHelperPath(selectedPath);
    if (normalized === null) {
      status.setText('Choose an absolute executable path. No path was saved.');
      return;
    }
    try {
      const result = await probeYtDlpVersion(normalized);
      status.setText(`Helper ready: ${result.version} (${result.path})`);
    } catch {
      status.setText('The selected helper could not be run or is not a supported version.');
    }
  };
  setting.addText((text) => {
    text.setPlaceholder('/absolute/path/to/yt-dlp');
    text.setValue(currentPath);
    text.onChange(async (value) => {
      const normalized = normalizeYouTubeHelperPath(value);
      if (normalized === null) {
        status.setText('Choose an absolute executable path. No path was saved.');
        text.setValue(selectedPath);
        return;
      }
      selectedPath = normalized;
      await dependencies.access.persistOne('youtubeHelperPath', normalized);
      status.setText('Selected helper path saved. Check the version explicitly.');
    });
  });
  setting.addButton((button) =>
    button.setButtonText('Check helper').onClick(() => {
      void checkHelper();
    }),
  );
  return setting;
}

export function youtubeHelperDescription(settings: PluginSettings): string {
  if (settings.youtubeHelperPath.length === 0) {
    return 'Experimental YouTube media is disabled until an absolute yt-dlp path is selected in Settings.';
  }
  return `Experimental YouTube media enabled with helper path ${settings.youtubeHelperPath}. The helper is unofficial and may stop working.`;
}

export function youtubeHelperSettingName(): string {
  return t('commands.transcribeYouTube');
}
