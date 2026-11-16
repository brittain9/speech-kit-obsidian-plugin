# Local code graph

Graphify maps Speech Kit's code into a queryable graph. Use it to find symbols,
callers, dependencies, and connections between the TypeScript plugin and Rust
sidecar, then verify relevant results in the source. Static analysis can miss
runtime dispatch and cross-process relationships.

## Setup and use

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) and Python
3.11–3.13, then run from the repository root:

```sh
npm run graphify:build
npm run graphify -- query "transcription sidecar"
npm run graphify -- explain "LocalSttPlugin"
npm run graphify -- path "symbol A" "symbol B"
```

The first command installs the pinned tool and locked dependencies into
`tools/graphify/.venv`, extracts the code, and generates `graphify-out/graph.json`,
`GRAPH_REPORT.md`, and `graph.html`. Open `graphify-out/graph.html` in a browser
to explore it. If a symbol is ambiguous, use the qualified name or node ID from
the candidates Graphify prints.

Large graphs open as a community overview. To export all individual symbols:

```sh
npm run graphify -- export html --node-limit 0
```

Re-run `npm run graphify:build` after source edits, pulls, or branch switches.
Extraction reuses its cache. To force a fresh code scan:

```sh
npm run graphify -- extract . --code-only --max-workers 4 --force
npm run graphify -- cluster-only . --no-label
```

The project skill at `.agents/skills/graphify/SKILL.md` lets Codex use the same
commands. It becomes available on the next turn after installation.

## Scope and defaults

- Graphify is development tooling, separate from npm and the shipped plugin.
  `tools/graphify/uv.lock` locks the Python dependency resolution.
- The wrapper sets `GRAPHIFY_BACKEND=none`; the build uses local AST extraction
  and community detection with automatic labels disabled. No model API key is
  needed. Docs and media are outside this code graph. Semantic indexing is a
  separate choice because it can send content to a configured model provider.
- `.graphifyignore` supplements `.gitignore` and excludes worktrees, experiments,
  the separate transcript plugin, and the tool's own environment. Source tests
  stay in scope. Review these rules if an expected symbol is missing.
- Generated graphs, caches, and virtual environments stay local. No watcher,
  git hook, global assistant configuration, cloud service, or MCP server is
  required. Refresh explicitly before relying on the graph.

## Updating the tool

Review the [upstream release and source](https://github.com/Graphify-Labs/graphify)
before changing the exact `graphifyy` version in `tools/graphify/pyproject.toml`.
Run `uv lock --project tools/graphify`, review the lockfile diff, and repeat the
build and a representative query before committing both files. This setup began
with the SHA-256-verified PyPI wheel for 0.9.111 and a focused source review of
installation, scanning, local extraction, and backend selection.
