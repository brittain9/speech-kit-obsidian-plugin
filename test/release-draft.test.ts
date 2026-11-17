import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('prepares a draft with provenance and keeps publication manual', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  expect(workflow).not.toMatch(/--draft=false|gh release edit|softprops\/action-gh-release/);
  expect(workflow).toContain('node scripts/create-release-draft.mjs');
  expect(workflow).toContain("if: github.event_name == 'push'");
  expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
  expect(workflow).toContain('name: Upload dry-run bundle');
  expect(workflow).toContain('node scripts/assemble-release-files.mjs --sidecars');
  expect(workflow).toContain('name: Attest plugin release assets');
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { createReleaseDraft } from '../scripts/create-release-draft.mjs';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const releaseDir = await mkdtemp(join(tmpdir(), 'release-draft-'));
  directories.push(releaseDir);
  for (const asset of ['main.js', 'manifest.json', 'styles.css']) {
    await writeFile(join(releaseDir, asset), 'fixture');
  }
  return { repository: 'owner/repo', tag: '2026.11.2', notesPath: 'notes.md', releaseDir };
}

it.each([true, false])('refuses an existing release (draft=%s) without a write', async (draft) => {
  const run = vi.fn(() => JSON.stringify([[], [{ tag_name: '2026.11.2', draft }]]));
  await expect(createReleaseDraft({ ...(await fixture()), run })).rejects.toThrow('already exists');
  expect(run.mock.calls).toEqual([
    [['api', '--paginate', '--slurp', 'repos/owner/repo/releases?per_page=100']],
  ]);
});

it.each(['unavailable', 'invalid metadata', 'malformed JSON', 'empty pagination', 'null metadata'])(
  'fails closed on %s',
  async (reason) => {
    const run = vi.fn(() => {
      if (reason === 'unavailable') throw new Error('API unavailable');
      if (reason === 'empty pagination') return '[]';
      if (reason === 'null metadata') return 'null';
      return reason === 'malformed JSON' ? '{' : '[{}]';
    });
    await expect(createReleaseDraft({ ...(await fixture()), run })).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  },
);

it('creates one verified-tag draft with the exact assembled assets', async () => {
  const options = await fixture();
  const run = vi
    .fn<(args: string[]) => string>()
    .mockReturnValueOnce('[[]]')
    .mockReturnValueOnce('url');
  await expect(createReleaseDraft({ ...options, run })).resolves.toBe('url');
  expect(run.mock.calls[1]).toEqual([
    [
      'release',
      'create',
      options.tag,
      '--repo',
      options.repository,
      '--draft',
      '--verify-tag',
      '--title',
      options.tag,
      '--notes-file',
      options.notesPath,
      ...['main.js', 'manifest.json', 'styles.css'].map((name) => join(options.releaseDir, name)),
    ],
  ]);
  expect(run).toHaveBeenCalledTimes(2);
});

it('leaves a failed draft upload for manual inspection without cleanup or retry', async () => {
  const run = vi
    .fn()
    .mockReturnValueOnce('[[]]')
    .mockImplementationOnce(() => {
      throw new Error('upload interrupted');
    });
  await expect(createReleaseDraft({ ...(await fixture()), run })).rejects.toThrow(
    'upload interrupted',
  );
  expect(run).toHaveBeenCalledTimes(2);
});
