import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const installScript = fileURLToPath(new URL('../scripts/install-dev-plugin.mjs', import.meta.url));
const directories: string[] = [];
const suffix = process.platform === 'win32' ? '.exe' : '';
const binaries = [
  'local-dictation-sidecar',
  'local-dictation-translation-helper',
  'local-dictation-asr-helper',
].map((name) => `${name}${suffix}`);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dev-helper-install-'));
  directories.push(directory);
  const vault = join(directory, 'vault');
  const destination = join(vault, '.obsidian', 'plugins', 'local-dictation', 'bin', 'cpu');
  for (const [file, text] of [
    ['manifest.json', '{"id":"local-dictation","version":"2026.11.1"}'],
    ['main.js', 'plugin'],
    ['styles.css', 'styles'],
  ] as const) {
    await writeFile(join(directory, file), text);
  }
  const source = join(directory, 'native', 'target', 'debug');
  await mkdir(source, { recursive: true });
  await mkdir(destination, { recursive: true });
  for (const binary of binaries) await writeFile(join(destination, binary), `previous:${binary}`);
  await writeFile(join(destination, 'install.json'), '{"version":"previous"}');
  return { directory, vault, source, destination };
}

it('copies the ASR helper with its matching dev sidecar and translation helper', async () => {
  const data = await fixture();
  for (const binary of binaries) await writeFile(join(data.source, binary), `new:${binary}`);
  const result = spawnSync(process.execPath, [installScript, '--vault', data.vault, '--sidecars'], {
    cwd: data.directory,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  for (const binary of binaries)
    await expect(readFile(join(data.destination, binary), 'utf8')).resolves.toBe(`new:${binary}`);
  expect(JSON.parse(await readFile(join(data.destination, 'install.json'), 'utf8'))).toMatchObject({
    version: 'dev-debug',
    variant: 'cpu',
  });
});

it.each(['missing', 'directory'])(
  'keeps the previous dev sidecar set intact when the new ASR helper is %s',
  async (kind) => {
    const data = await fixture();
    for (const binary of binaries.slice(0, 2))
      await writeFile(join(data.source, binary), `new:${binary}`);
    if (kind === 'directory') await mkdir(join(data.source, binaries[2] ?? 'missing-helper'));
    const result = spawnSync(
      process.execPath,
      [installScript, '--vault', data.vault, '--sidecars'],
      {
        cwd: data.directory,
        encoding: 'utf8',
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('local-dictation-asr-helper');
    for (const binary of binaries)
      await expect(readFile(join(data.destination, binary), 'utf8')).resolves.toBe(
        `previous:${binary}`,
      );
    await expect(readFile(join(data.destination, 'install.json'), 'utf8')).resolves.toBe(
      '{"version":"previous"}',
    );
  },
);
