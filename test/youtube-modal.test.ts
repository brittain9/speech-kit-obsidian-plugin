import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Modal, Setting } from 'obsidian';
import { afterEach, describe, expect, it } from 'vitest';

import {
  openYouTubeMediaSourceModal,
  openYouTubeMediaSourceModalSession,
} from '../src/ui/youtube-media-source-modal';

const temporaryPaths: string[] = [];

afterEach(async () => {
  modalInstances().length = 0;
  settingInstances().length = 0;
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

interface SettingFixture {
  readonly buttonComponents: Array<{ click(): Promise<void> }>;
  readonly textComponents: Array<{ change(value: string): void }>;
  readonly toggleComponents: Array<{ change(value: boolean): void }>;
}

function settingInstances(): SettingFixture[] {
  return (Setting as unknown as { instances: SettingFixture[] }).instances;
}

function modalInstances(): Array<{
  close(): void;
  contentEl: { children: Array<{ attributes: Map<string, string> }> };
}> {
  return (
    Modal as unknown as {
      instances: Array<{
        close(): void;
        contentEl: { children: Array<{ attributes: Map<string, string> }> };
      }>;
    }
  ).instances;
}

describe('YouTube source modal lifecycle', () => {
  it('invalidates a stale helper probe when the path changes before submit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-modal-stale-'));
    temporaryPaths.push(root);
    const helperA = join(root, 'a');
    const helperB = join(root, 'b');
    await writeFile(helperA, '#!/bin/sh\nsleep 10\n', { mode: 0o700 });
    await writeFile(helperB, '#!/bin/sh\nprintf "yt-dlp 2026.08.19\\n"\n', { mode: 0o700 });
    await chmod(helperA, 0o700);
    await chmod(helperB, 0o700);
    const session = openYouTubeMediaSourceModalSession({} as never, {
      getHelperPath: () => helperA,
      getPolicyVersion: () => null,
    });
    const helperText = settingInstances()[0]?.textComponents[0];
    const urlText = settingInstances()[2]?.textComponents[0];
    const rightsToggle = settingInstances()[1]?.toggleComponents[0];
    const submitButton = settingInstances()[3]?.buttonComponents[1];
    if (
      helperText === undefined ||
      urlText === undefined ||
      rightsToggle === undefined ||
      submitButton === undefined
    ) {
      throw new Error('Expected modal controls');
    }
    helperText.change(helperB);
    urlText.change('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    rightsToggle.change(true);
    await submitButton.click();
    await expect(session.result).resolves.toMatchObject({ helperPath: helperB });
  });

  it('invalidates an in-flight helper probe and does not persist after close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-modal-'));
    temporaryPaths.push(root);
    const helper = join(root, 'yt-dlp');
    await writeFile(helper, '#!/bin/sh\nsleep 10\n', { mode: 0o700 });
    await chmod(helper, 0o700);
    const resultPromise = openYouTubeMediaSourceModal({} as never, {
      getHelperPath: () => helper,
      getPolicyVersion: () => null,
    });
    const modal = modalInstances().at(-1);
    if (modal === undefined) throw new Error('Expected modal instance');
    expect(modal.contentEl.children.some((child) => child.attributes.get('role') === 'alert')).toBe(
      true,
    );
    modal.close();
    await expect(resultPromise).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
