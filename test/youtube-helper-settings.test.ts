import { Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { renderYouTubeHelperSettings } from '../src/settings/youtube-helper-settings';
import { t } from '../src/shared/i18n';
import { TestElement } from './__mocks__/obsidian';

interface SettingFixture {
  readonly name: string;
  readonly descEl: TestElement;
  readonly textComponents: unknown[];
  readonly toggleComponents: unknown[];
  readonly buttonComponents: Array<{ click(): Promise<void> }>;
}

const settingInstances = (): SettingFixture[] =>
  (Setting as unknown as { instances: SettingFixture[] }).instances;

afterEach(() => {
  settingInstances().length = 0;
});

describe('YouTube helper settings', () => {
  it('keeps setup in one compact row and saves an installed helper', async () => {
    const helperPath = '/tmp/speech-kit-yt-dlp';
    const persistOne = vi.fn(async () => {});
    const parent = new TestElement();
    renderYouTubeHelperSettings(parent as unknown as HTMLElement, {
      access: {
        getSettings: () => DEFAULT_PLUGIN_SETTINGS,
        persistOne,
      },
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      installPinnedHelper: async () => helperPath,
    });

    const helperSetting = settingInstances()[1];
    expect(helperSetting).toBeDefined();
    expect(helperSetting?.textComponents).toHaveLength(0);
    expect(helperSetting?.buttonComponents).toHaveLength(1);
    const status = helperSetting?.descEl.findByClass('local-stt-youtube-helper-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toBe(t('youtube.settings.helperMissing'));

    await helperSetting?.buttonComponents[0]?.click();
    expect(persistOne).toHaveBeenCalledWith('youtubeHelperPath', helperPath);
    expect(status?.textContent).toBe(t('youtube.settings.helperError'));
  });

  it('shows a localized unsupported message and no helper controls on Windows', () => {
    const parent = new TestElement();
    renderYouTubeHelperSettings(parent as unknown as HTMLElement, {
      access: {
        getSettings: () => ({}) as never,
        persistOne: vi.fn(async () => {}),
      },
      getSettings: () => ({}) as never,
      isPlatformSupported: () => false,
    });
    const fixture = settingInstances()[0];
    expect(fixture?.name).toBe(t('youtube.settings.helperName'));
    expect(fixture?.descEl.textContent).toBe(t('youtube.settings.unsupportedPlatform'));
    expect(fixture?.toggleComponents).toHaveLength(0);
    expect(fixture?.textComponents).toHaveLength(0);
    expect(fixture?.buttonComponents).toHaveLength(0);
  });
});
