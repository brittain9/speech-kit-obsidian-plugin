import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { assertCiSuccess, changedFiles, planChecks } from '../scripts/ci-plan.mjs';

it('plans real PR/push diffs and full manual/merge-queue events through the CLI', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'speech-kit-ci-events-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(cwd, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(cwd, 'README.md'), 'updated docs\n');
    git('add', '.');
    git('commit', '-m', 'docs');
    const head = git('rev-parse', 'HEAD');
    for (const [name, event, expected] of [
      ['push', { before: base }, false],
      ['pull_request', { pull_request: { base: { sha: base } } }, false],
      ['workflow_dispatch', {}, true],
      ['merge_group', {}, true],
      ['push', { before: '0'.repeat(40) }, true],
    ] as const) {
      const eventPath = join(cwd, 'event.json');
      const output = join(cwd, 'output');
      await writeFile(eventPath, JSON.stringify(event));
      await writeFile(output, '');
      execFileSync(
        process.execPath,
        [fileURLToPath(new URL('../scripts/ci-plan.mjs', import.meta.url))],
        {
          cwd,
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: name,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_SHA: head,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: join(cwd, 'summary'),
          },
        },
      );
      expect(await readFile(output, 'utf8')).toBe(`native=${expected}\nplatform=${expected}\n`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

it('keeps docs and ordinary UI changes out of native builds', () => {
  expect(planChecks(['docs/guide.md', 'README.md'])).toEqual({ native: false, platform: false });
  expect(planChecks(['src/settings/settings-tab.ts', 'styles.css'])).toEqual({
    native: false,
    platform: false,
  });
});

it('runs portable integration for the frontend/native boundary and package updates', () => {
  for (const path of [
    'src/sidecar/protocol.ts',
    'src/models/model-install-manager.ts',
    'test/sidecar-real-process.test.ts',
    'package-lock.json',
  ]) {
    expect(planChecks([path])).toEqual({ native: true, platform: false });
  }
});

it('runs every platform for native, workflow and build changes or unknown paths', () => {
  for (const path of [
    'native/catalog.json',
    'native/Cargo.lock',
    '.github/workflows/ci.yml',
    'scripts/build-sidecar.mjs',
    'new-build-config',
  ]) {
    expect(planChecks([path])).toEqual({ native: true, platform: true });
  }
  expect(planChecks([], true)).toEqual({ native: true, platform: true });
});

it('fails closed for missing plans, failed or skipped planned jobs', () => {
  const needs = {
    changes: { result: 'success', outputs: { native: 'false', platform: 'false' } },
    'frontend-checks': { result: 'success' },
    'sidecar-quality': { result: 'skipped' },
    'sidecar-platform-quality': { result: 'skipped' },
  };
  expect(() => assertCiSuccess(needs)).not.toThrow();
  expect(() => assertCiSuccess({ ...needs, changes: { result: 'failure' } })).toThrow();
  expect(() => assertCiSuccess({ ...needs, 'frontend-checks': { result: 'failure' } })).toThrow();
  expect(() =>
    assertCiSuccess({
      ...needs,
      changes: { result: 'success', outputs: { native: 'true', platform: 'false' } },
    }),
  ).toThrow();
  expect(() =>
    assertCiSuccess({ ...needs, changes: { result: 'success', outputs: { native: 'false' } } }),
  ).toThrow();
});

it('includes deleted paths and both sides of renames in the git diff', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'speech-kit-ci-plan-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(cwd, 'old.rs'), 'native source\n');
    git('add', '.');
    git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'old.rs', 'README.md');
    git('commit', '-m', 'rename');
    expect(changedFiles(base, git('rev-parse', 'HEAD'), cwd).sort()).toEqual([
      'README.md',
      'old.rs',
    ]);
    expect(() => changedFiles('invalid', 'HEAD', cwd)).toThrow();
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
