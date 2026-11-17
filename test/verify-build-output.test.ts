import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  verifyFrontendBuildOutput,
  verifySidecarBuildOutput,
} from '../scripts/verify-build-output.mjs';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function writeBundle(contents: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'verify-build-output-'));
  tempDirectories.push(rootDir);
  await mkdir(rootDir, { recursive: true });
  await writeFile(join(rootDir, 'main.js'), contents);
  return rootDir;
}

describe('verifyFrontendBuildOutput', () => {
  it('accepts a self-contained bundle with the inlined recorder worklet', async () => {
    const rootDir = await writeBundle('registerProcessor("obsidian-local-stt-pcm-recorder", {})');

    await expect(verifyFrontendBuildOutput({ rootDir })).resolves.toBeUndefined();
  });

  it.each([
    ['a dynamic Node import', 'import("node:fs")', /dynamic node: import/],
    ['an external recorder worklet', 'pcm-recorder.worklet.js', /external recorder worklet/],
    ['a missing inlined worklet', 'const bundle = true;', /missing the inlined recorder worklet/],
  ])('rejects %s', async (_label, bundle, expected) => {
    const rootDir = await writeBundle(bundle);

    await expect(verifyFrontendBuildOutput({ rootDir })).rejects.toThrow(expected);
  });
});

describe('verifySidecarBuildOutput', () => {
  it('rejects a new build missing its ASR helper and accepts all three binaries', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'verify-sidecar-output-'));
    tempDirectories.push(rootDir);
    const directory = join(rootDir, 'native', 'target', 'debug');
    await mkdir(directory, { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const binary of ['local-dictation-sidecar', 'local-dictation-translation-helper']) {
      await writeFile(join(directory, `${binary}${suffix}`), binary);
    }
    await expect(verifySidecarBuildOutput({ rootDir })).rejects.toThrow(
      /local-dictation-asr-helper/,
    );
    await writeFile(join(directory, `local-dictation-asr-helper${suffix}`), 'asr-helper');
    await expect(verifySidecarBuildOutput({ rootDir })).resolves.toBe(false);
  });
  it('rejects a partial CUDA build rather than silently treating it as absent', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'verify-sidecar-cuda-'));
    tempDirectories.push(rootDir);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const cpu = join(rootDir, 'native', 'target', 'debug');
    const cuda = join(rootDir, 'native', 'target-cuda', 'debug');
    await mkdir(cpu, { recursive: true });
    await mkdir(cuda, { recursive: true });
    for (const binary of [
      'local-dictation-sidecar',
      'local-dictation-translation-helper',
      'local-dictation-asr-helper',
    ]) {
      await writeFile(join(cpu, `${binary}${suffix}`), binary);
      if (binary !== 'local-dictation-asr-helper')
        await writeFile(join(cuda, `${binary}${suffix}`), binary);
    }
    await expect(verifySidecarBuildOutput({ rootDir })).rejects.toThrow(
      /local-dictation-asr-helper/,
    );
  });
});
