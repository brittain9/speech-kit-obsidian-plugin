import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installMediaTools,
  isMediaToolInstalled,
  MEDIA_TOOL_VERSION,
  mediaToolAsset,
  mediaToolDirectory,
} from '../src/audio/media-tool-installer';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe('media tool installer', () => {
  it('selects only published platform and architecture combinations', () => {
    expect(mediaToolAsset('darwin', 'arm64').name).toBe('media-ffmpeg-9.0.2-macos-arm64.tar.gz');
    expect(mediaToolAsset('darwin', 'x64').name).toBe('media-ffmpeg-9.0.2-macos-x86_64.tar.gz');
    expect(mediaToolAsset('linux', 'x64').name).toBe('media-ffmpeg-9.0.2-linux-x86_64.tar.gz');
    expect(mediaToolAsset('win32', 'x64').name).toBe('media-ffmpeg-9.0.2-windows-x86_64.tar.gz');
    expect(() => mediaToolAsset('linux', 'arm64')).toThrow(/not available/u);
  });

  it('requires a matching install receipt and both executables', async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'speech-kit-media-install-test-'));
    temporaryDirectories.push(pluginDirectory);
    const directory = mediaToolDirectory(pluginDirectory);
    await mkdir(directory, { recursive: true });
    expect(await isMediaToolInstalled(pluginDirectory)).toBe(false);
    await writeFile(
      join(directory, 'install.json'),
      JSON.stringify({ version: MEDIA_TOOL_VERSION, sha256: mediaToolAsset().sha256 }),
    );
    const suffix = process.platform === 'win32' ? '.exe' : '';
    await writeFile(join(directory, `ffmpeg${suffix}`), '');
    expect(await isMediaToolInstalled(pluginDirectory)).toBe(false);
    await writeFile(join(directory, `ffprobe${suffix}`), '');
    expect(await isMediaToolInstalled(pluginDirectory)).toBe(true);
    await writeFile(join(directory, 'install.json'), JSON.stringify({ version: 'wrong' }));
    expect(await isMediaToolInstalled(pluginDirectory)).toBe(false);
  });

  it('leaves an existing helper intact and removes staging after cancellation', async () => {
    const pluginDirectory = await mkdtemp(join(tmpdir(), 'speech-kit-media-cancel-test-'));
    temporaryDirectories.push(pluginDirectory);
    const directory = mediaToolDirectory(pluginDirectory);
    await mkdir(directory, { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    await writeFile(join(directory, `ffmpeg${suffix}`), 'previous helper');
    await writeFile(join(directory, `ffprobe${suffix}`), 'previous probe');
    await writeFile(
      join(directory, 'install.json'),
      JSON.stringify({ version: MEDIA_TOOL_VERSION, sha256: mediaToolAsset().sha256 }),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      installMediaTools({ pluginDirectory, signal: controller.signal }),
    ).rejects.toThrow();
    expect(await isMediaToolInstalled(pluginDirectory)).toBe(true);
    const entries = await readdir(join(pluginDirectory, 'data', 'media-tools'));
    expect(entries).toEqual(['ffmpeg']);
  });
});
