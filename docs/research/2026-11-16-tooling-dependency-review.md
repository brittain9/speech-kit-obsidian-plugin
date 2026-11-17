# Tooling dependency review

Dependabot PR #539 updates Biome 2.6.6, eslint-plugin-obsidianmd 0.5.1, and
Vitest 5.1.0. Reviewed the official
[Biome release](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.6.6),
[Obsidian lint release and upgrade notes](https://github.com/obsidianmd/eslint-plugin/releases/tag/0.5.1),
and [Vitest release](https://github.com/vitest-dev/vitest/releases/tag/v5.1.0).
These are development dependencies; the shipped plugin bundle does not include
the lint or test runners.

Clean `npm ci` with Node 24.22.3 and the pinned npm 11.19.1 initially rejected
the peer dependency lock: ESLint 10.14.0 and config-array 0.23.5 no longer matched
the resolution npm computed for the updated plugin. Regenerating the lock changed
only ESLint to 10.15.0 and config-array to 0.23.6. The
[ESLint release](https://github.com/eslint/eslint/releases/tag/v10.15.0)
includes that config-array update and supports Node 24. The regenerated lock
passes a clean install without peer-bypass flags. npm still reports a nested
ESLint 9 peer override for the plugin's Microsoft SDL dependency; the installed
root ESLint is 10.15.0 and the complete lint run succeeds.

The updated Biome schema and its Markdown formatting adjustments address the
original CI failure. A malformed list in the wire-header description was also
rewritten as its intended paragraph. No lint rules were disabled. TypeScript checks, Biome,
Obsidian ESLint, 1,930 tests (10 skipped), and the production build passed. npm
audit reported zero known vulnerabilities in the installed lockfile. The new
Obsidian lint reports two popout/window warnings; those behavior fixes are a
separate compatibility change rather than part of the formatter migration.
