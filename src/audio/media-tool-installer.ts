import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getExistingPathKind } from '../filesystem/path-validation';
import { runManagedProcess } from '../media/process-runner';
import {
  DEFAULT_RELEASE_BASE_URL,
  downloadToFile,
  extractTarGz,
  markExecutable,
} from '../sidecar/sidecar-installer';

export const MEDIA_TOOL_VERSION = '9.0.2-2';
const RELEASE_TAG = `media-ffmpeg-${MEDIA_TOOL_VERSION}`;
const HASHES = {
  'linux-x86_64': 'ee0d6bbea587712185912cd6d7c042dd647012d14cfe6a0157ae787efe7cba72',
  'macos-arm64': '359fd6f6e04e79549114c534ee147300a11df6ff265c2485e1e21b587d9e3745',
  'macos-x86_64': 'ed49d46e372bb83dabf8b955edb2f57f53ce870645ff941c5732b3ef807e677c',
  'windows-x86_64': 'f0fabeb95beb43c8e15dcf2566121a2725567fefb44d463773c44791a71f9205',
} as const;

export interface MediaToolInstallProgress {
  readonly bytesDownloaded: number;
  readonly totalBytes: number | null;
  readonly phase: 'download' | 'verify' | 'install';
}

export interface InstallMediaToolsOptions {
  readonly pluginDirectory: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: MediaToolInstallProgress) => void;
  readonly releaseBaseUrl?: string;
}

let activeInstall = false;

export function mediaToolDirectory(pluginDirectory: string): string {
  return join(pluginDirectory, 'data', 'media-tools', 'ffmpeg');
}

export function mediaToolAsset(
  platform = process.platform,
  arch = process.arch,
): {
  readonly name: string;
  readonly sha256: string;
} {
  const key =
    platform === 'darwin' && arch === 'arm64'
      ? 'macos-arm64'
      : platform === 'darwin' && arch === 'x64'
        ? 'macos-x86_64'
        : platform === 'linux' && arch === 'x64'
          ? 'linux-x86_64'
          : platform === 'win32' && arch === 'x64'
            ? 'windows-x86_64'
            : null;
  if (key === null) throw new Error('The media decoder is not available for this computer.');
  return { name: `media-ffmpeg-9.0.2-${key}.tar.gz`, sha256: HASHES[key] };
}

export async function isMediaToolInstalled(pluginDirectory: string): Promise<boolean> {
  const directory = mediaToolDirectory(pluginDirectory);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  try {
    const manifest: unknown = JSON.parse(await readFile(join(directory, 'install.json'), 'utf8'));
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('version' in manifest) ||
      manifest.version !== MEDIA_TOOL_VERSION ||
      !('sha256' in manifest) ||
      manifest.sha256 !== mediaToolAsset().sha256
    )
      return false;
    await access(join(directory, `ffmpeg${suffix}`));
    await access(join(directory, `ffprobe${suffix}`));
    return true;
  } catch {
    return false;
  }
}

export async function installMediaTools(options: InstallMediaToolsOptions): Promise<void> {
  if (activeInstall) throw new Error('The media decoder is already being installed.');
  const { name, sha256 } = mediaToolAsset();
  activeInstall = true;
  const parent = join(options.pluginDirectory, 'data', 'media-tools');
  const staging = join(parent, `.ffmpeg-staging-${randomUUID()}`);
  const destination = mediaToolDirectory(options.pluginDirectory);
  const backup = join(parent, '.ffmpeg-previous');
  const releaseBase = (options.releaseBaseUrl ?? DEFAULT_RELEASE_BASE_URL).replace(/\/$/u, '');
  const archiveUrl = `${releaseBase}/${RELEASE_TAG}/${name}`;
  try {
    await mkdir(staging, { recursive: true });
    const archive = join(staging, name);
    const actual = await downloadToFile(
      archiveUrl,
      archive,
      (bytesDownloaded, totalBytes) =>
        options.onProgress?.({ bytesDownloaded, totalBytes, phase: 'download' }),
      options.signal,
      64 * 1024 * 1024,
    );
    options.signal?.throwIfAborted();
    options.onProgress?.({ bytesDownloaded: 0, totalBytes: null, phase: 'verify' });
    if (actual !== sha256) throw new Error('Media decoder download failed verification.');
    await extractTarGz(archive, staging, options.signal);
    await rm(archive, { force: true });
    options.signal?.throwIfAborted();
    const suffix = process.platform === 'win32' ? '.exe' : '';
    await markExecutable(join(staging, `ffmpeg${suffix}`));
    await markExecutable(join(staging, `ffprobe${suffix}`));
    options.onProgress?.({ bytesDownloaded: 0, totalBytes: null, phase: 'install' });
    for (const executable of ['ffmpeg', 'ffprobe']) {
      const result = await runManagedProcess(
        join(staging, `${executable}${suffix}`),
        ['-version'],
        { cwd: staging, env: process.env, windowsHide: true },
        {
          maxOutputBytes: 16_384,
          timeoutMs: 10_000,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (result.cancelled) options.signal?.throwIfAborted();
      if (result.failed || !result.stdout.startsWith(`${executable} version 9.0.2`)) {
        throw new Error(`The downloaded ${executable} could not run on this computer.`);
      }
    }
    options.signal?.throwIfAborted();
    await writeFile(
      join(staging, 'install.json'),
      JSON.stringify({ version: MEDIA_TOOL_VERSION, sha256 }),
    );
    const hadExisting = (await getExistingPathKind(destination)) !== 'missing';
    if (hadExisting) {
      await rm(backup, { force: true, recursive: true });
      await rename(destination, backup);
    }
    try {
      await rename(staging, destination);
    } catch (error) {
      if (hadExisting) await rename(backup, destination).catch(() => {});
      throw error;
    }
    if (hadExisting) await rm(backup, { force: true, recursive: true });
  } finally {
    activeInstall = false;
    await rm(staging, { force: true, recursive: true }).catch(() => {});
  }
}
