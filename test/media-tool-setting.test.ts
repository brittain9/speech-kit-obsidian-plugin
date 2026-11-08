import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MEDIA_TOOL_VERSION,
  mediaToolAsset,
  mediaToolDirectory,
} from '../src/audio/media-tool-installer';
import { renderMediaToolSetting } from '../src/settings/media-tool-setting';
import { t } from '../src/shared/i18n';
import { TestElement } from './__mocks__/obsidian';

const temporaryDirectories: string[] = [];

interface SettingFixture {
  readonly buttonComponents: Array<{ click(): Promise<void>; disabled: boolean; text: string }>;
  readonly descEl: { textContent: string };
}

const mockSettings = Setting as unknown as {
  named(name: string): SettingFixture;
  reset(): void;
};

afterEach(async () => {
  mockSettings.reset();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe('media decoder settings', () => {
  it('reflects installation after the installer completes', async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'speech-kit-media-setting-test-'));
    temporaryDirectories.push(pluginDirectory);
    let attempts = 0;
    const openInstaller = vi.fn(async (callbacks: { onClosed(): void; onInstalled(): void }) => {
      attempts += 1;
      if (attempts === 1) {
        callbacks.onClosed();
        return;
      }
      const directory = mediaToolDirectory(pluginDirectory);
      await mkdir(directory, { recursive: true });
      const suffix = process.platform === 'win32' ? '.exe' : '';
      await writeFile(join(directory, `ffmpeg${suffix}`), 'ffmpeg');
      await writeFile(join(directory, `ffprobe${suffix}`), 'ffprobe');
      await writeFile(
        join(directory, 'install.json'),
        JSON.stringify({ version: MEDIA_TOOL_VERSION, sha256: mediaToolAsset().sha256 }),
      );
      callbacks.onInstalled();
      callbacks.onClosed();
    });
    renderMediaToolSetting(new TestElement() as unknown as HTMLElement, {
      feedback: { show: vi.fn() },
      isDictationBusy: () => false,
      openInstaller: (_directory, callbacks) => {
        void openInstaller(callbacks);
      },
      resolvePluginDirectory: async () => pluginDirectory,
    });
    const setting = mockSettings.named(t('media.tools.title'));

    await vi.waitFor(() =>
      expect(setting.buttonComponents[0]?.text).toBe(t('media.tools.install')),
    );
    await setting.buttonComponents[0]?.click();
    await vi.waitFor(() => expect(setting.buttonComponents[0]?.disabled).toBe(false));
    expect(setting.buttonComponents[0]?.text).toBe(t('media.tools.install'));

    await setting.buttonComponents[0]?.click();
    await vi.waitFor(() =>
      expect(setting.buttonComponents[0]?.text).toBe(t('media.tools.reinstall')),
    );
    expect(setting.descEl.textContent).toBe(t('media.tools.ready'));
  });
});
