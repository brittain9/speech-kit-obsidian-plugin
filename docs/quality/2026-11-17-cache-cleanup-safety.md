# Preserve active Actions caches

The weekly orphan sweep compared every cache ref with branch refs only. Open PR
caches use `refs/pull/<number>/merge` or `/head`, so that sweep classified them as
orphaned even while the PR was open. Both cleanup paths also limited their cache
inventory to 100 entries.

Cleanup now reads every page of cache, branch, and open PR inventories before
deleting anything. It retains live branch refs and both ref forms for open PRs.
Only missing branch refs and closed PR refs are eligible; tags and unfamiliar ref
forms are left alone. Failed or malformed inventories abort before mutation.

The existing close, weekly, and manual triggers share one planner and executor.
The workflow executes default-branch code even when an unmerged PR closes.
Its existing cache deletion permission is unchanged; open PR inventory adds
read-only pull request permission. No release or branch protection changes.

The old predicate reproduced deleting both open PR cache refs. Seven focused
tests now cover preservation, closed/deleted refs, pagination beyond 100 caches,
failed reads, and malformed later pages. GitHub execution is mocked; no real
repository caches were deleted during validation. A separate read-only API replay
fed the real inventories into the planner: 38 branches, five open PRs, 11 caches,
and five planned orphans, with zero deletions. The full frontend gate passed
2,067 tests with 16 skipped, plus typechecks, lint and build. This fixes incorrect
eviction, not the separate cost of restoring large Rust caches.
