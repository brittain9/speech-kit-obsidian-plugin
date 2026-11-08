# Security and runtime review — 2026-11-08

## Decision

Use Node.js 24.22.2 and its bundled npm 11.19.1 for development and CI. Declare Node `^24.22.2` as the supported contributor runtime. This is the tested LTS line and includes the October security fixes. It is a build requirement, not a claim about the Node runtime inside Obsidian.

The former Node 24.14.1 pin failed a clean `npm ci --engine-strict`: jsdom 31 requires `^22.22.2 || ^24.15.0 || >=26.0.0`. The former `engines` field also claimed Node 20 and older Node 22 and 24 versions. Node 20 is end-of-life. Node 22 and 26 remain supported upstream, but this change does not claim or test them. Keep jsdom 31 instead of changing the test dependency to accommodate an outdated runtime. The recommended pin, package engines, and CI installs now agree. CI uses `--engine-strict` so a later incompatible dependency fails the install.

Node 24.22.2 is the latest 24.x release available on the review date. Node 24.22.1 fixed high-severity DNS, TLS, and Brotli issues; 24.22.2 includes those fixes. The Node project recommends LTS releases for production use. Sources: [release schedule](https://nodejs.org/en/about/previous-releases), [October security releases](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [24.22.2 release](https://nodejs.org/en/blog/release/v24.22.2), [24.22.2 bundled npm](https://nodejs.org/en/download/archive/v24.22.2).

**Follow-up:** Node has announced another high-severity security release for the 24.x line on or shortly after November 11. Recheck and update the pin when that release is available. Its details were not yet published during this review. [Node security announcement](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases).

## Checks and limits

- On macOS Apple Silicon, Node 24.14.1 and npm 11.11.0 failed the strict clean install at jsdom 31. Node 24.22.2 and npm 11.19.1 passed the strict clean install, with zero npm audit findings. The full frontend gates use that same Node runtime.
- GitHub's open Dependabot and code-scanning alert lists each returned zero alerts on November 8. This does not prove the absence of vulnerabilities.
- Rust remains pinned at 1.94.1. Rust 1.96.0 fixed Cargo CVE-2026-5222 and CVE-2026-5223. The Rust team states that crates.io users are unaffected; the conditions involve third-party registries. No registry replacement was found in this repository. A compiler upgrade needs its own native build and platform validation because the sidecar includes native libraries. [Rust 1.96.0 security notes](https://blog.rust-lang.org/2026/05/28/Rust-1.96.0/), [CVE-2026-5223 details](https://blog.rust-lang.org/2026/05/25/cve-2026-5223/).
- This review did not independently run `cargo audit`, build every native platform, or establish that every native library is free of advisories. Those checks remain separate work. It did not inspect download handling or provider payloads.
