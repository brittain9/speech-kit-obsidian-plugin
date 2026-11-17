# WASAPI 0.27 compatibility review

Dependabot PR #538 updates wasapi 0.26.0 to 0.27.0. The
[official release](https://github.com/HEnquist/wasapi-rs/releases/tag/v0.27.0)
includes correctly zero-filled silent capture packets. Its
[source diff](https://github.com/HEnquist/wasapi-rs/compare/v0.26.0...v0.27.0)
also changes copyable enum parameters to values and adds an optional audio-session
GUID to `AudioClient::initialize_client`.

The existing Windows adapter did not compile against these signatures. A
compile-only Windows harness including the actual production Windows adapter and
resampler reproduced `E0308` for borrowed Direction and `E0061` for the missing
GUID/changed parameter types. The harness substituted only the enclosing
controller types to avoid unrelated native TLS dependencies on the Mac.

The adapter now passes Direction/StreamMode values and `None` for the session
GUID, preserving its existing loopback, polling, format, and session behavior.
The same Windows-target source check passes after the fix; formatting and Git
whitespace checks pass. A full Mac-to-Windows crate check was blocked by missing
Windows C headers in the TLS dependency, so this source check does not replace
the actual Windows CI build or system-audio hardware validation.

The target-specific dependency remains MIT licensed. OSV returned no known
advisory for wasapi 0.27.0 on 2026-11-16; that query does not prove the absence of
all vulnerabilities. The existing Linux-only PR lane cannot validate Windows
source, so run the ordinary `ci` workflow's platform matrix on this branch before
merging. No release workflow is needed.
