# Tooling dependency review

Dependabot PR #549 updates seven development dependencies. Reviewed the official
[Biome 2.6.7 release](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.6.7),
[typescript-eslint 8.72.2 fixes](https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.72.2),
[ESLint 10.15.0 release](https://github.com/eslint/eslint/releases/tag/v10.15.0),
[Obsidian lint 0.5.1 release and upgrade notes](https://github.com/obsidianmd/eslint-plugin/releases/tag/0.5.1),
[jsdom 31.0.1 fixes](https://github.com/jsdom/jsdom/releases/tag/v31.0.1), and
[Vitest 5.1.0 release](https://github.com/vitest-dev/vitest/releases/tag/v5.1.0).
These development tools remain outside the shipped plugin bundle.

The existing lockfile passes clean `npm ci --engine-strict` under Node 24.22.3
and the pinned npm 11.19.1. npm reports a nested ESLint 9 peer override for the
Obsidian lint plugin's Microsoft SDL dependency; the installed root ESLint is
10.15.0 and the complete lint run succeeds without peer-bypass flags.

The Biome 2.6.7 schema and required Markdown formatting adjustments address the
CI failure. A malformed list in the wire-header description is now its intended
paragraph. No lint rules were disabled. Both TypeScript checks, Biome, Obsidian
ESLint, 1,930 tests (15 skipped with the real-sidecar suite disabled), and the
production build pass. The real-sidecar suite is validated separately. npm audit
reports zero known vulnerabilities for this lockfile. The new Obsidian lint
reports two popout/window warnings; their behavior fixes are a separate
compatibility change rather than part of the formatter migration.
