import { Setting } from 'obsidian';

import {
  discoverYtDlpCandidates,
  isYouTubeSupportedPlatform,
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
  const probeStatus = status.createDiv({
    attr: { 'aria-atomic': 'true', 'aria-live': 'polite', role: 'status' },
  });

  const currentPath = dependencies.getSettings().youtubeHelperPath;
  let selectedPath = currentPath;
  let probeController: AbortController | null = null;
  let probeGeneration = 0;
  let persistenceQueue: Promise<void> = Promise.resolve();
  const checkHelper = async (): Promise<void> => {
    probeController?.abort();
    const controller = new AbortController();
    probeController = controller;
    const generation = ++probeGeneration;
    const requestedPath = selectedPath;
    const normalized = normalizeYouTubeHelperPath(requestedPath);
    if (normalized === null) {
      probeStatus.setText(t('youtube.settings.pathRequired'));
      probeController = null;
      return;
    }
    try {
      const result = await probeYtDlpVersion(normalized, { signal: controller.signal });
      if (
        controller.signal.aborted ||
        generation !== probeGeneration ||
        selectedPath !== requestedPath
      ) {
        return;
      }
      probeStatus.setText(
        t('youtube.settings.helperReady', { version: result.version, path: result.path }),
      );
    } catch {
      if (
        !controller.signal.aborted &&
        generation === probeGeneration &&
        selectedPath === requestedPath
      ) {
        probeStatus.setText(t('youtube.settings.helperError'));
      }
    } finally {
      if (probeController === controller) probeController = null;
    }
  };
  setting.addText((text) => {
    text.setPlaceholder(t('youtube.modal.helperPlaceholder'));
    text.setValue(currentPath);
    text.onChange((value) => {
      probeGeneration += 1;
      probeController?.abort();
      probeController = null;
      const generation = probeGeneration;
      const normalized = normalizeYouTubeHelperPath(value);
      if (normalized === null) {
        probeStatus.setText(t('youtube.settings.pathRequired'));
        text.setValue(selectedPath);
        return;
      }
      selectedPath = normalized;
      persistenceQueue = persistenceQueue
        .catch(() => {})
        .then(async () => {
          if (generation !== probeGeneration) return;
          await dependencies.access.persistOne('youtubeHelperPath', normalized);
          if (generation === probeGeneration) probeStatus.setText(t('youtube.settings.pathSaved'));
        });
    });
  });
  setting.addButton((button) =>
    button.setButtonText(t('youtube.settings.checkHelper')).onClick(() => {
      void checkHelper();
    }),
  );
  return setting;
}
