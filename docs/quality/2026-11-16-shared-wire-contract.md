# Shared wire-contract validation

The [shared corpus](../../test/fixtures/sidecar-wire-contract.md) adds 28
TypeScript checks and five Rust checks over repository-owned semantic and byte
expectations. It runs in the ordinary frontend and native suites without models.
The fixtures preserve documented compatibility differences rather than silently
strengthening one implementation to match the other.

A deliberate client limit mutation from 16 MiB to 15 MiB made the exact-limit
fixture fail with `Sidecar frame payload exceeds limit: 16777216 bytes (max
15728640)`. Restoring the source made the suite pass. The mutation was removed;
the change contains no production codec changes.

Validation on macOS used Node 24.22.3 and Rust 1.94.1. The full frontend check
passed 1,958 tests with 10 skipped. The Rust corpus passed with normal Mac engine
features, along with formatting and Clippy with warnings denied. An initial
engine-free test run also passed; its Clippy invocation exposed pre-existing
dead-code warnings from disabled engines, so final Clippy used the normal feature
set. No inference, models, microphone, or vault content were needed.

Linux CI exposed an avoidable test cost: the exhaustive split-point case timed
out at five seconds while repeatedly comparing PCM arrays with Vitest's general
matcher. Keeping the same split points and fixture expectations, Node's strict
assertions reduced the complete local corpus run from 1.97 seconds to 203 ms.
The fix preserves the bounded CI timeout and failure diagnostics rather than
increasing it. This measures test overhead, not application inference speed.
