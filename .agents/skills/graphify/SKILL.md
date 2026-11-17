---

name: graphify
description: Build or query Speech Kit's local code graph. Use for Graphify requests, architecture exploration, callers, dependencies, and relationships across the TypeScript plugin and Rust sidecar.
---

# Speech Kit code graph

Run commands from the repository root. The npm wrapper uses the reviewed,
locked Graphify environment and disables model backends.

1. Build a missing graph with `npm run graphify:build`. Refresh it after code
   edits, pulls, or branch switches before relying on the results. A successful
   build produces `graphify-out/graph.json`, `GRAPH_REPORT.md`, and `graph.html`.
2. Orient with a scoped query:
   `npm run graphify -- query "<question or symbols>"`.
   Use `npm run graphify -- explain "<symbol>"` for neighbors and
   `npm run graphify -- path "<symbol A>" "<symbol B>"` for connections.
   Resolve ambiguous names using the qualified names or IDs in the candidates.
3. Read the relevant source and verify the proposed interpretation. Runtime
   dispatch, IPC, and relationships to docs can be absent from this AST graph.
   Report missing coverage or failed extraction rather than treating no edge
   as proof of no relationship.

For missing symbols, scope changes, forced rebuilds, or tool upgrades, read
`docs/guides/code-graph.md`. Keep source tests in scope and generated graph
artifacts local. The default build indexes code locally; semantic indexing of
other content needs a separate user request.
