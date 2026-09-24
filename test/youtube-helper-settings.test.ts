import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { renderYouTubeHelperSettings } from '../src/settings/youtube-helper-settings';
import { TestElement } from './__mocks__/obsidian';

interface SettingFixture {
  readonly buttonComponents: Array<{ click(): Promise<void> }>;
  readonly textComponents: Array<{ change(value: string): void }>;
}

const temporaryPaths: string[] = [];

afterEach(async () => {
  (Setting as unknown as { instances: SettingFixture[] }).instances.length = 0;
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('YouTube helper settings lifecycle', () => {
  it('aborts stale probes and serializes path persistence so path A cannot win', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-settings-'));
    temporaryPaths.push(root);
    const helperA = join(root, 'a');
    const helperB = join(root, 'b');
    await writeFile(helperA, '#!/bin/sh\nsleep 10\n', { mode: 0o700 });
    await writeFile(helperB, '#!/bin/sh\nprintf "yt-dlp 2026.08.19\\n"\n', { mode: 0o700 });
    await chmod(helperA, 0o700);
    await chmod(helperB, 0o700);
    let resolvePersistence: () => void = () => {};
    const persistenceGate = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    const persistOne = vi.fn(
      async <K extends keyof PluginSettings>(key: K, value: PluginSettings[K]) => {
        if (key === 'youtubeHelperPath' && value === helperA) await persistenceGate;
      },
    );
    const access = {
      getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, youtubeHelperPath: helperA }),
      persistOne,
    };
    const parent = new TestElement();
    renderYouTubeHelperSettings(parent as unknown as HTMLElement, {
      access,
      getSettings: access.getSettings,
    });
    const setting = (Setting as unknown as { instances: SettingFixture[] }).instances[1];
    const text = setting?.textComponents[0];
    const check = setting?.buttonComponents[0];
    if (setting === undefined || text === undefined || check === undefined) {
      throw new Error('Expected helper setting controls');
    }

    await check.click();
    text.change(helperB);
    resolvePersistence();
    await vi.waitFor(() => {
      expect(persistOne).toHaveBeenCalledWith('youtubeHelperPath', helperB);
    });

    expect(persistOne.mock.calls.map(([, value]) => value)).toEqual([helperB]);
  });
});
