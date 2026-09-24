import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Modal } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openYouTubeMediaSourceModal } from '../src/ui/youtube-media-source-modal';

const temporaryPaths: string[] = [];

afterEach(async () => {
  modalInstances().length = 0;
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function modalInstances(): Array<{ close(): void }> {
  return (Modal as unknown as { instances: Array<{ close(): void }> }).instances;
}

describe('YouTube source modal lifecycle', () => {
  it('invalidates an in-flight helper probe and does not persist after close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'speech-kit-youtube-modal-'));
    temporaryPaths.push(root);
    const helper = join(root, 'yt-dlp');
    await writeFile(helper, '#!/bin/sh\nsleep 10\n', { mode: 0o700 });
    await chmod(helper, 0o700);
    const onHelperSelected = vi.fn(async () => {});
    const onRightsConfirmed = vi.fn(async () => {});
    const resultPromise = openYouTubeMediaSourceModal({} as never, {
      getHelperPath: () => helper,
      getPolicyVersion: () => null,
      onHelperSelected,
      onRightsConfirmed,
    });
    const modal = modalInstances().at(-1);
    if (modal === undefined) throw new Error('Expected modal instance');
    modal.close();
    await expect(resultPromise).resolves.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onHelperSelected).not.toHaveBeenCalled();
    expect(onRightsConfirmed).not.toHaveBeenCalled();
  });
});
