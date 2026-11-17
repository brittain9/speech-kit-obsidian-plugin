# Node security refresh, November 16, 2026

Use Node 24.22.3 with npm 11.19.1 for development and CI. The project already
uses the supported 24.x LTS line; this patch adds the November security fixes
without a major-runtime migration. This updates contributor tooling, not
Obsidian's embedded Electron/Node runtime.

The [November security advisory](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/)
and [24.22.3 release](https://nodejs.org/en/blog/release/v24.22.3) identify fixes
in HTTP/2, TLS, permission handling, and bundled dependencies. The source checkout
was pinned to 24.22.2. These advisories justify updating the toolchain; they do
not establish that the plugin exposes an affected server path.

The official `node-v24.22.3-darwin-arm64.tar.xz` was verified against the
[release checksums](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt):
`1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5`.
Its actual executables report Node 24.22.3 and npm 11.19.1. Current contributor
and CI pins, the engine floor, and the root lockfile use the patched version.
Historical QA records retain the versions actually tested at that time.

Validation results are recorded in the PR and maintenance log. No release,
release tag, or plugin version change is part of this update.
