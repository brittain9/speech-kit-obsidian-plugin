# Dictation cleanup after sidecar exit

## Finding

Observed in a controller regression: an unexpected sidecar process exit emitted
the global `sidecar_exited` error, but dictation only changed its visible error
state. With no more audio frames, microphone capture and the native session lease
could remain active indefinitely. The reproduction failed with capture still on.

Graphify identified `DictationSessionController` as the shared dictation lifecycle
owner. Source inspection confirmed that `SidecarConnection` emits the unscoped
error when its process exits, without a subsequent native `session_stopped`.

## Change and evidence

The controller now treats this specific error as local termination of its native
sessions. It stops capture, saves an enabled recording before embedding it,
releases inference ownership, and drains transcript work received before the
crash. It ignores later transcript events and sends no cancellation command to
the dead process. Existing completed sessions can finish their provider work.

The public-controller test failed before the change and passed afterward.
All 104 dictation-controller tests passed, including two-session drain and delayed
recording-save regressions. Both TypeScript typechecks passed.

Native Obsidian 1.15.1 verification in `~/Documents/test-vault` passed for
capture termination, preservation of the existing note prefix, temporary pin
release, and replacement-session Listening followed by a clean stop. The exact
reviewed frontend was hash-matched to the installed build; only the verified
test-vault sidecar received SIGTERM. Recording was disabled for this check;
delayed recording-save ordering is covered by the controller regression.

The native check exposed a second UX defect: the first toggle after an error
only cleared it, requiring another click to start. A public-controller regression
failed with one native start instead of two. Toggle now clears the stale error
and starts the replacement session in the same action.
No inference-engine or wire-contract behavior changed.
