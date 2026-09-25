import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestUrl } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installPinnedYouTubeHelper,
  YOUTUBE_HELPER_ASSETS,
} from '../src/media/youtube-helper-installer';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.mocked(requestUrl).mockReset();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe('pinned yt-dlp installation', () => {
  it('rejects platforms without a pinned executable before any network request', async () => {
    await expect(installPinnedYouTubeHelper('/unused', 'win32')).rejects.toThrow(/not supported/u);
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it('rejects a downloaded executable whose SHA-256 does not match the pinned release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'speech-kit-ytdlp-install-'));
    temporaryDirectories.push(directory);
    vi.mocked(requestUrl).mockResolvedValue({
      arrayBuffer: new TextEncoder().encode('untrusted helper').buffer,
      headers: {},
      json: {},
      status: 200,
      text: '',
    });

    await expect(installPinnedYouTubeHelper(directory, 'linux', 'x64')).rejects.toThrow(
      /did not match its verified SHA-256 hash/u,
    );
    expect(await readdir(directory)).toEqual([]);
    expect(YOUTUBE_HELPER_ASSETS.linux?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(requestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/2026.08.19/yt-dlp_linux'),
      }),
    );
  });
});
