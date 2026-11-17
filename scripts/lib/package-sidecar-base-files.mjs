import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const THIRD_PARTY_NOTICES_PATH = fileURLToPath(
  new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url),
);

export async function stageSidecarBaseFiles({
  artifactDirectory,
  binaryName,
  binaryPath,
  helperName,
  helperPath,
  asrHelperName,
  asrHelperPath,
}) {
  for (const [name, path] of [
    [binaryName, binaryPath],
    [helperName, helperPath],
    [asrHelperName, asrHelperPath],
  ]) {
    try {
      if (!(await lstat(path)).isFile()) throw new Error('not a regular file');
    } catch (cause) {
      throw new Error(
        `Missing or invalid ${name} at ${path}. Build all sidecar executables before packaging.`,
        { cause },
      );
    }
  }
  await mkdir(artifactDirectory, { recursive: true });
  await Promise.all([
    copyFile(binaryPath, join(artifactDirectory, binaryName)),
    copyFile(helperPath, join(artifactDirectory, helperName)),
    copyFile(asrHelperPath, join(artifactDirectory, asrHelperName)),
    copyFile(THIRD_PARTY_NOTICES_PATH, join(artifactDirectory, 'THIRD_PARTY_NOTICES.md')),
  ]);
}
