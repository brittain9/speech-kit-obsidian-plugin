# Isolated ASR helper distribution

Qwen ASR uses `local-dictation-asr-helper` (`.exe` on Windows), a third sibling
executable beside the main sidecar and translation helper. The helper contract
uses Cargo feature `engine-qwen-asr`; the native owner validates the package
version and protocol version in Ready before loading a model. The process
boundary preserves the existing Whisper/llama GGML isolation in ADR 0005.

Normal builds, all-engine Clippy/tests, and both CUDA builders enable the same
feature. New archive staging, build-output checks and dev installation require
all three regular executable files. A missing helper fails with an actionable
message. Dev installation checks the entire executable set before replacing a
working variant; optional CUDA runtime artifacts retain their existing behavior.
A present but incomplete CUDA build is rejected by output verification.

Release packaging copies the three executables from the selected build directory,
strips all three on Linux and ad-hoc signs all three on macOS. The release workflow
was edited only; no release workflow, tag or version bump was run.

## Legacy archives and validation

Published 2026.11.1 archives contain two executables and expose no Qwen adapter.
They remain installable. An ASR helper, when included, comes only from the same
SHA-256-verified archive as the sidecar. Every included executable must be a
regular file on every OS before the installer calls its replacement barrier or
promotes staging. The existing extractor rejects links and unsupported entries.

This also fixes an existing Windows gap: chmod returned without checking that
the required translation helper existed. Directory entries were accepted as
helpers on both platforms. The public installer regressions reproduce these
failures and verify malformed packages leave the working install intact.
Runtime helper/version mismatch and unavailable Qwen readiness belong to the
native handshake tests; archive byte verification does not replace that check.

## Checks

The regression slices failed before implementation: archive staging omitted ASR,
build verification accepted an incomplete set, dev installation omitted ASR,
Windows accepted a missing translation helper, and invalid helper directories
were promoted. They now pass through the public staging, CLI and installer paths.

`npm run check:frontend` passes on Node 24.22.3/npm 11.19.1: 2,032 tests passed,
15 skipped, both TypeScript targets, formatting, Obsidian lint and frontend build.
A fresh source review found no blockers against the agreed native contract.

The native helper implementation is owned separately. This packaging slice has
not built or executed the new helper, signed actual artifacts, or exercised CUDA
hardware. Integrated native/platform checks follow the native feature and binary
landing together. No models, services or executable tools were downloaded here.
