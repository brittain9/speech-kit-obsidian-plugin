# Production client and sidecar integration

The previous test layers covered TypeScript against a simulated child and Rust
against the real executable. The model-free client suite composes the production
`SidecarConnection`, JSON encoder/event parser, `SidecarProcess`, and actual Rust
binary. Obsidian host APIs retain the existing test mock.

## Evidence

On macOS, five tests passed against the existing debug sidecar. They exercised
health/system information, a correlated invalid model-store request, expected
shutdown with confirmed child exit, unsolicited server shutdown while a request
was waiting, and recovery after an unknown command. No models, microphone,
network endpoint, or vault content are required.

The health constructor was temporarily changed to send `health_wire_mismatch`.
The health test failed through the real process with `SidecarError`, code
`invalid_frame`, and the server diagnostic `unknown variant
health_wire_mismatch`. Restoring the constructor made the suite pass. The
mutation was not retained.

Every request and asynchronous event assertion has a deadline. Failure teardown
uses production shutdown, closes stdin, applies its bounded kill grace period,
and waits for child exit. A frontend-only run skips the suite; the dedicated
`npm run test:sidecar:client` command requires an executable and fails rather
than silently skipping if it is absent.

The normal Linux sidecar PR lane reuses its existing native build and cache for
this check. It installs locked JavaScript dependencies to run the same Vitest
suite; it does not run another native build. macOS was exercised locally;
Windows was not exercised in this change.

See [Contributing](../../CONTRIBUTING.md) for binary paths and the local command.
