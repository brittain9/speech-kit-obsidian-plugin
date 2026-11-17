import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function planOrphanCaches(branches, pulls, caches) {
  if (
    !Array.isArray(branches) ||
    branches.length === 0 ||
    branches.some((branch) => typeof branch?.name !== 'string' || !branch.name)
  ) {
    throw new Error('Invalid branch inventory; refusing cache deletion.');
  }
  if (
    !Array.isArray(pulls) ||
    pulls.some((pull) => !Number.isSafeInteger(pull?.number) || pull.number < 1)
  ) {
    throw new Error('Invalid open PR inventory; refusing cache deletion.');
  }
  if (
    !Array.isArray(caches) ||
    caches.some(
      (cache) =>
        !Number.isSafeInteger(cache?.id) ||
        cache.id < 1 ||
        typeof cache.ref !== 'string' ||
        !cache.ref,
    )
  ) {
    throw new Error('Invalid cache inventory; refusing cache deletion.');
  }
  const live = new Set(branches.map((branch) => `refs/heads/${branch.name}`));
  for (const pull of pulls) {
    live.add(`refs/pull/${pull.number}/merge`);
    live.add(`refs/pull/${pull.number}/head`);
  }
  return [
    ...new Set(
      caches
        .filter(
          (cache) =>
            // Other ref kinds cannot be classified as orphaned from these inventories.
            /^(?:refs\/heads\/.+|refs\/pull\/[1-9]\d*\/(?:merge|head))$/u.test(cache.ref) &&
            !live.has(cache.ref),
        )
        .map((cache) => cache.id),
    ),
  ];
}

export function cleanupActionsCaches(repository, run = execFileSync) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '')) throw new Error('Expected owner/repository.');
  const inventory = (endpoint, field) => {
    const pages = JSON.parse(
      run('gh', ['api', '--paginate', '--slurp', endpoint], { encoding: 'utf8' }),
    );
    if (
      !Array.isArray(pages) ||
      pages.length === 0 ||
      pages.some((page) => !Array.isArray(field ? page?.[field] : page))
    ) {
      throw new Error(`Incomplete inventory from ${endpoint}; refusing cache deletion.`);
    }
    return pages.flatMap((page) => (field ? page[field] : page));
  };
  // Cache inventory first: refs creating newer caches can appear in the later
  // live inventories. Complete all reads before any mutation.
  const caches = inventory(`repos/${repository}/actions/caches?per_page=100`, 'actions_caches');
  const branches = inventory(`repos/${repository}/branches?per_page=100`);
  const pulls = inventory(`repos/${repository}/pulls?state=open&per_page=100`);
  const orphanIds = planOrphanCaches(branches, pulls, caches);
  for (const id of orphanIds) {
    run('gh', ['api', '--method', 'DELETE', `repos/${repository}/actions/caches/${id}`], {
      encoding: 'utf8',
    });
  }
  return orphanIds;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(
    `Deleted ${cleanupActionsCaches(process.env.GITHUB_REPOSITORY).length} orphan cache(s).`,
  );
}
