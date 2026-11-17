import { execFileSync } from 'node:child_process';
import { appendFile, lstat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Create only. A retry must never edit, replace assets on, or delete a release. */
export async function createReleaseDraft({
  repository,
  tag,
  notesPath,
  releaseDir,
  run = (args) => execFileSync('gh', args, { encoding: 'utf8' }),
}) {
  if (!repository || !tag || !notesPath || !releaseDir) {
    throw new Error('Repository, tag, notes file and release directory are required.');
  }
  // Listing includes drafts, unlike a published-only lookup by tag. Any API or
  // parsing failure aborts before the first write, including on a workflow retry.
  const pages = JSON.parse(
    run(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]),
  );
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    !pages.every(
      (page) =>
        Array.isArray(page) &&
        page.every((release) => release && typeof release.tag_name === 'string'),
    )
  ) {
    throw new Error('Could not validate existing releases; refusing to create a draft.');
  }
  if (pages.flat().some((release) => release.tag_name === tag)) {
    throw new Error(`Release ${tag} already exists. Inspect it manually before retrying.`);
  }
  const entries = (await readdir(releaseDir)).sort();
  if (entries.length === 0) throw new Error('Release directory is empty.');
  const assets = [];
  for (const entry of entries) {
    const path = resolve(releaseDir, entry);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Invalid release asset: ${entry}`);
    assets.push(path);
  }
  return run([
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--draft',
    '--verify-tag',
    '--title',
    tag,
    '--notes-file',
    notesPath,
    ...assets,
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = await createReleaseDraft({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.RELEASE_TAG,
    notesPath: process.env.RELEASE_NOTES_PATH,
    releaseDir: 'dist/release',
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Release assets staged\n\n${url.trim()}\n\nThe approved tag workflow publishes automatically after verified staging.\n`,
    );
  }
}
