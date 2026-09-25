import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { requestUrl } from 'obsidian';

import { isYouTubeSupportedPlatform, YOUTUBE_HELPER_PINNED_VERSION } from './youtube-helper';

export interface YouTubeHelperAsset {
  readonly assetName: string;
  readonly executableName: string;
  readonly sha256: string;
}

export const YOUTUBE_HELPER_ASSETS: Readonly<Partial<Record<NodeJS.Platform, YouTubeHelperAsset>>> =
  {
    darwin: {
      assetName: 'yt-dlp_macos',
      executableName: 'yt-dlp',
      sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202',
    },
    linux: {
      assetName: 'yt-dlp_linux',
      executableName: 'yt-dlp',
      sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
    },
  };

// The pinned macOS and Linux standalone executables are about 37 and 40 MB.
export const YOUTUBE_HELPER_INSTALL_MAX_BYTES = 64 * 1024 * 1024;

export async function installPinnedYouTubeHelper(
  pluginDirectory: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Promise<string> {
  if (!isYouTubeSupportedPlatform(platform, arch)) {
    throw new Error('The managed yt-dlp installer is not supported on this platform.');
  }
  const asset = YOUTUBE_HELPER_ASSETS[platform];
  if (asset === undefined) {
    throw new Error(`No pinned yt-dlp release asset is available for ${platform}.`);
  }

  const helperDirectory = join(pluginDirectory, 'data', 'media-tools');
  const executablePath = join(helperDirectory, asset.executableName);
  const existing = await lstat(executablePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error('The configured yt-dlp destination is a symbolic link.');
  }
  if (existing !== null && !existing.isFile()) {
    throw new Error('The configured yt-dlp destination is not a regular file.');
  }
  if (existing !== null && existing.size <= YOUTUBE_HELPER_INSTALL_MAX_BYTES) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(executablePath)) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Could not read the existing yt-dlp helper.');
      hash.update(chunk);
    }
    if (hash.digest('hex') === asset.sha256) {
      await chmod(executablePath, 0o700);
      return executablePath;
    }
  }

  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YOUTUBE_HELPER_PINNED_VERSION}/${asset.assetName}`;
  const response = await requestUrl({ url, method: 'GET', throw: false });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The pinned yt-dlp release returned HTTP ${response.status}.`);
  }
  const binary = Buffer.from(response.arrayBuffer);
  if (binary.byteLength === 0 || binary.byteLength > YOUTUBE_HELPER_INSTALL_MAX_BYTES) {
    throw new Error('The pinned yt-dlp download exceeded its safety limit.');
  }
  const actualHash = createHash('sha256').update(binary).digest('hex');
  if (actualHash !== asset.sha256) {
    throw new Error('The pinned yt-dlp download did not match its verified SHA-256 hash.');
  }

  await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(helperDirectory, `.yt-dlp-${randomUUID()}.partial`);

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o700);
    await handle.writeFile(binary);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, executablePath);
    const installed = await lstat(executablePath);
    if (!installed.isFile() || installed.isSymbolicLink()) {
      throw new Error('The installed yt-dlp helper is not a regular file.');
    }
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
  return executablePath;
}
