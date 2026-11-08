---

## status: accepted

# Decouple plugin and sidecar releases through an explicit compatibility pointer

Each plugin build declares its required native runtime in `sidecar-version.json`.
This points to the single ordinary GitHub Release tag that published the
compatible native archives; it is not a second sidecar-only release stream. A
plugin-only release retains that pointer, skips native builds, and has no
sidecar assets of its own. A sidecar-bearing release advances the pointer to
its plugin tag and publishes the full archive matrix there.

The release workflow is the enforcement point. For a plugin-only release it
fetches the referenced tag and rejects changes in the compatibility boundary
defined by `scripts/verify-sidecar-compatibility.mjs`: native sources and the
TypeScript modules that construct sidecar commands, parse sidecar events, or
resolve the packaged executable layout. Native, wire-protocol, helper-layout,
or required-sidecar behavior changes must therefore use `release:prepare` with
`--sidecar`. Ordinary UI, localization, documentation, and plugin-only behavior
changes can reuse the declared compatible sidecar.

The workflow also requires the referenced GitHub Release to be published (not
a draft), to contain `checksums.txt` and every platform archive, and to have
one valid SHA-256 entry for each archive that matches GitHub's published asset
digest. Release assets referenced by a later plugin release are retained. These
rules ensure fresh installs download the archives and checksum manifest from a
live historical tag, while existing installs retain the compatible sidecar
without a redownload.

This trades a deliberately narrow source-path boundary for release simplicity:
compatibility is declared once in version-controlled metadata, release authors
retain one tag per release, and native rebuilds occur only when the compatibility
inputs changed.
