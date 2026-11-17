import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stageSidecarBaseFiles } from '../scripts/lib/package-sidecar-base-files.mjs';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('stageSidecarBaseFiles', () => {
  it.each(['', '.exe'])(
    'stages all three executables and third-party notices together (%s)',
    async (suffix) => {
      const directory = await mkdtemp(join(tmpdir(), 'sidecar-package-'));
      tempDirectories.push(directory);
      const binaryPath = join(directory, 'source-sidecar');
      const artifactDirectory = join(directory, 'artifact');
      const helperPath = join(directory, 'source-helper');
      const asrHelperPath = join(directory, 'source-asr-helper');
      await writeFile(binaryPath, 'binary');
      await writeFile(helperPath, 'helper');
      await writeFile(asrHelperPath, 'asr-helper');

      await stageSidecarBaseFiles({
        artifactDirectory,
        binaryName: `local-dictation-sidecar${suffix}`,
        binaryPath,
        helperName: `local-dictation-translation-helper${suffix}`,
        asrHelperName: `local-dictation-asr-helper${suffix}`,
        asrHelperPath,
        helperPath,
      });

      await expect(
        readFile(join(artifactDirectory, `local-dictation-sidecar${suffix}`), 'utf8'),
      ).resolves.toBe('binary');
      await expect(
        readFile(join(artifactDirectory, `local-dictation-translation-helper${suffix}`), 'utf8'),
      ).resolves.toBe('helper');
      await expect(
        readFile(join(artifactDirectory, `local-dictation-asr-helper${suffix}`), 'utf8'),
      ).resolves.toBe('asr-helper');
      const notices = await readFile(join(artifactDirectory, 'THIRD_PARTY_NOTICES.md'), 'utf8');
      expect(notices).toContain('WeSpeaker');
      expect(notices).toContain('CC BY 4.0');
      expect(notices).toContain('Copyright (c) 2023 CNRS');
      expect(notices).toContain('Silero VAD');
      expect(notices).toContain('Copyright (c) 2020-present Silero Team');
      expect(notices).toContain('MIT License');
      expect(notices).toContain('NVIDIA Nemotron 3.5 ASR');
      expect(notices).toContain('OpenMDW License Agreement, version 1.1');
      expect(notices).toContain('numerical representation');
      expect(notices).toContain('Tencent HY-MT');
    },
  );
  it('rejects a missing ASR helper before creating a partial package directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sidecar-package-'));
    tempDirectories.push(directory);
    const binaryPath = join(directory, 'sidecar');
    const helperPath = join(directory, 'translation');
    const artifactDirectory = join(directory, 'artifact');
    await writeFile(binaryPath, 'binary');
    await writeFile(helperPath, 'translation');
    await expect(
      stageSidecarBaseFiles({
        artifactDirectory,
        binaryName: 'local-dictation-sidecar',
        binaryPath,
        helperName: 'local-dictation-translation-helper',
        helperPath,
        asrHelperName: 'local-dictation-asr-helper',
        asrHelperPath: join(directory, 'missing-asr'),
      }),
    ).rejects.toThrow(/local-dictation-asr-helper/);
    await expect(access(artifactDirectory)).rejects.toThrow();
  });
});
