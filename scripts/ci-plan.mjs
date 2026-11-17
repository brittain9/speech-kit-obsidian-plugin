import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function planChecks(paths, full = false) {
  let native = full;
  let platform = full;
  for (const path of paths) {
    if (path.startsWith('docs/') || /\.md$/.test(path) || /^LICENSE/.test(path)) continue;
    if (/^(src\/(sidecar|models)\/|test\/sidecar-|package(-lock)?\.json$)/.test(path)) {
      native = true;
    } else if (/^(src\/|test\/|styles\.css$)/.test(path)) {
      // Frontend typechecks, tests, lint and build still run for every change.
    } else {
      // Native, build, workflow and unknown paths receive conservative coverage.
      native = true;
      platform = true;
    }
  }
  return { native, platform };
}

export function changedFiles(base, head, cwd = process.cwd()) {
  if (![base, head].every((sha) => /^[a-f0-9]{40,64}$/i.test(sha))) {
    throw new Error('CI comparison requires exact commit SHAs.');
  }
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, head], {
    cwd,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

export function assertCiSuccess(needs) {
  if (needs.changes?.result !== 'success' || needs['frontend-checks']?.result !== 'success') {
    throw new Error('CI planning and frontend checks must succeed.');
  }
  const plan = needs.changes.outputs;
  if (
    !plan ||
    !['true', 'false'].includes(plan.native) ||
    !['true', 'false'].includes(plan.platform) ||
    (plan.platform === 'true' && plan.native !== 'true')
  ) {
    throw new Error('CI plan is missing or invalid.');
  }
  for (const [flag, job] of [
    ['native', 'sidecar-quality'],
    ['platform', 'sidecar-platform-quality'],
  ]) {
    const result = needs[job]?.result;
    if (plan[flag] === 'true' ? result !== 'success' : !['success', 'skipped'].includes(result)) {
      throw new Error(`CI job ${job} did not satisfy its plan (${result}).`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--result')) {
    assertCiSuccess(JSON.parse(process.env.CI_NEEDS));
    console.log('All planned CI checks passed.');
  } else {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const base = event.pull_request?.base.sha ?? event.before;
    const full =
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || !base || /^0+$/.test(base);
    const paths = full ? [] : changedFiles(base, process.env.GITHUB_SHA);
    const plan = planChecks(paths, full);
    appendFileSync(process.env.GITHUB_OUTPUT, `native=${plan.native}\nplatform=${plan.platform}\n`);
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## CI coverage\n\nPortable native: **${plan.native}**. Platform matrix: **${plan.platform}**.\n\nFrontend checks always run. Manual dispatch runs every lane.\n`,
    );
  }
}
