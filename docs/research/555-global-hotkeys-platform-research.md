# Issue #555: background dictation and global shortcuts

Investigation date: 2026-11-16. This is a feasibility assessment, not an implemented
or hardware-verified feature. Request: [issue #555](https://github.com/brittain9/speech-kit-obsidian-plugin/issues/555).

## Platform findings

A global shortcut can start and stop dictation while another application has
focus. It does not require a standalone application. Recommend an opt-in global
**toggle** that sends an event to the existing Obsidian dictation controller and
keeps the destination inside Obsidian. Sending text into arbitrary applications
is a separate feature with different permissions and failure modes.

| Platform      | Native path                                                                     | Relevant constraint                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows       | `RegisterHotKey`; available through Rust `global-hotkey`                        | Own a message loop on the registering thread. Handle occupied/reserved shortcuts explicitly.                                                                    |
| macOS         | Regular chords through `RegisterEventHotKey`; available through `global-hotkey` | Hotkey manager and event loop must run on the main thread. This requires integrating a native run loop with this sidecar's existing stdio dispatch.             |
| Linux X11     | Rust `global-hotkey`                                                            | Supported by the crate; requires real X11 validation.                                                                                                           |
| Linux Wayland | XDG `GlobalShortcuts` portal; Rust binding candidate `ashpd`                    | Separate implementation, desktop backend support, session lifecycle, and application identity need validation. Do not infer Wayland coverage from an X11 build. |

Sources: [`global-hotkey` platform requirements](https://github.com/tauri-apps/global-hotkey#platform-specific-notes),
[Microsoft `RegisterHotKey`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey),
[XDG portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html),
[`ashpd` global-shortcuts module](https://docs.rs/ashpd/latest/ashpd/desktop/global_shortcuts/index.html).

### Candidate implementation and permissions

`global-hotkey` is a plausible dependency to review, not an adopted dependency.
The inspected upstream [manifest](https://github.com/tauri-apps/global-hotkey/blob/41b011d42b90498e507754b96ec5909d7bcd6f67/Cargo.toml)
declares version 0.10.0, MIT/Apache-2.0 licensing, and Rust 1.77 minimum. Pin and
review an actual release and its dependencies before adding it.

Its [macOS implementation](https://github.com/tauri-apps/global-hotkey/blob/41b011d42b90498e507754b96ec5909d7bcd6f67/src/platform_impl/macos/mod.rs)
registers ordinary keyboard chords through Carbon hotkey APIs; media keys take an
event-tap path. It emits pressed and released states. Avoid claiming that every
global hotkey requires broad keyboard-monitoring or Accessibility permission.
Prefer a normal modifier-plus-key chord for the first version. Validate permission
behavior with the actual distributed sidecar and macOS version.

Its [Windows implementation](https://github.com/tauri-apps/global-hotkey/blob/41b011d42b90498e507754b96ec5909d7bcd6f67/src/platform_impl/windows/mod.rs)
uses `RegisterHotKey` for presses and polls `GetAsyncKeyState` every 50 ms while
waiting for release. This is a reason to begin with toggle dictation rather than
making hold-to-talk release timing part of the initial guarantee. Microsoft's
API supports `MOD_NOREPEAT`; registration can fail when a chord is already owned,
and Windows-key combinations are OS-reserved. Surface registration success or
failure instead of showing a setting as enabled merely because it was saved.

The [Wayland portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
creates sessions, binds shortcuts, and emits activation/deactivation independently
of focus. Bindings and user interaction belong to the desktop portal. The
[portal architecture](https://docs.flatpak.org/en/latest/portal-api-reference.html)
depends on desktop-specific backends. Probe actual interface availability and
report unsupported environments; installing the generic portal service alone
does not establish that its backend implements global shortcuts.

### Why Electron is not an automatic shortcut

[Electron `globalShortcut`](https://www.electronjs.org/docs/latest/api/global-shortcut/)
works without application focus, but is a **main-process** API. Speech Kit runs
inside Obsidian's plugin environment, so its existence is not evidence that the
plugin can use it through a supported API. Its Wayland documentation also shows
the importance of application identity and desktop integration. A native sidecar
listener avoids depending on Obsidian private main-process IPC.

### Microphone and external output are separate questions

The global listener should initially leave microphone capture in the plugin.
Moving capture into a new native microphone owner would add permission and
packaging work: Apple's [capture authorization documentation](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos)
requires an appropriate usage description and authorization handling. A hotkey
proof alone does not verify background `getUserMedia`, minimized-window audio
processing, or final text delivery; exercise those through the installed plugin.

Typing into the focused application is materially broader than dictating into a
background Obsidian note. On Windows, [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
is constrained by process integrity and held keyboard state. On macOS, an
[Apple framework engineer explains](https://developer.apple.com/forums/thread/103992)
that posting events requires explicit user permission. Clipboard plus manual
paste is a possible later convenience, but background clipboard access, ownership,
and preservation of user clipboard contents still require deliberate behavior.

## Recommended proof before committing to support

1. With Obsidian still running, register one opt-in chord in the sidecar and route
   an activation event over existing stdio. Do not activate or raise Obsidian.
2. Toggle a real existing dictation session while another app is focused, then
   repeat with Obsidian minimized. Confirm recording starts, stops, and writes to
   the intended note without stealing focus.
3. Exercise conflicts, repeated presses, sidecar restarts, unload/quit, microphone
   denial, destination closure, and multiple vaults competing for a chord.
4. Check idle CPU and listener lifetime. A registered shortcut must remain ready
   when inference workers are idle; this need not keep models loaded or mic open.
5. Validate Windows and macOS first if desired, while explicitly reporting X11
   and Wayland capabilities. Cross-platform builds alone do not verify OS behavior.

## Repository assessment and proposed acceptance criteria

Assessed against `92019a96` on `main`. The issue's two baby steps fit one bounded
feature: control dictation globally while keeping Obsidian open as the destination.
Making Obsidian optional would require replacing more than its window.

### What exists today

- [Command registration](../../src/commands/register-commands.ts) exposes toggle,
  start, stop, and cancel through Obsidian's `addCommand`. There is no global OS
  shortcut registration or external command endpoint in this path.
- [AudioCaptureStream](../../src/audio/audio-capture-stream.ts) captures the
  microphone using `getUserMedia` and an `AudioWorklet`, then forwards PCM through
  the plugin. The sidecar owns native **system audio**, not microphone capture.
  Neither the capture stream nor the [dictation controller](../../src/dictation/dictation-session-controller.ts)
  stops recording on window blur. This supports investigating background use,
  but does not prove minimized-window capture works in the installed host.
- [Session](../../src/session/session.ts) captures a specific editor and file at
  session creation. Its fallback can use the open active Markdown note and append
  at its end if no active cursor is available. It keeps projecting to that target
  as the active tab changes; closing/replacing the target or deleting its file
  cancels the session. A Markdown editor must remain open. This is not an
  arbitrary-file background writer.
- [Existing session tests](../../test/session.test.ts) cover continued projection
  into a locked background tab. That is useful evidence of target ownership,
  not an operating-system focus or microphone test.
- [Automatically copy finalized utterances](../../src/dictation/finalized-utterance-auto-copy.ts)
  is already an opt-in setting. Each accepted finalized phrase replaces the
  clipboard; it does not produce one complete-session clipboard result or type
  into another application. [Main](../../src/main.ts) supplies
  `window.navigator.clipboard`. Background success must be tested rather than
  inferred from this setting; the [Clipboard specification](https://w3c.github.io/clipboard-apis/#privacy)
  discusses focus and permission restrictions. A native clipboard adapter is a
  possible follow-up if the host rejects background writes.
- [Startup](../../src/main.ts) checks the sidecar after layout. Its
  [process adapter](../../src/sidecar/sidecar-process.ts) owns piped stdio, and the
  [native main loop](../../native/src/main.rs) exits on EOF. A listener can use
  this existing private transport; it needs no localhost server. The current
  main loop polls at 10 ms intervals, so measure idle behavior when adding a
  persistent native event loop rather than calling it free.

### Proposed first implementation

Add an optional **Global dictation shortcut** in Speech Kit settings, distinct
from ordinary Obsidian hotkeys. Keep it disabled until configured. The native
listener reports registration state and activation over framed stdio; the plugin
calls its existing dictation controller. The listener must be ready before a
dictation session starts, and registration must be restored after an intentional
sidecar restart or update. Debounce/serialize activations, including presses
during asynchronous startup, so one press cannot produce duplicate sessions.

Use the last active eligible Markdown editor in the owning vault, then keep that
target for the session. If no eligible target or installed model is available,
fail without opening a picker or stealing focus. Use unobtrusive feedback that
can be perceived outside Obsidian for actual recording start, stop, and failure.
Choose and validate that feedback during the proof. Stop must remain available
when another app is focused. Multiple vaults must never broadcast a press into
multiple notes; report chord conflicts rather than silently rerouting ownership.

Keep microphone capture, note insertion, formatting, and optional AI processing
in the plugin. Native hotkey ownership extends the boundary in
[ADR 0001](../adr/0001-separate-plugin-and-native-runtime-responsibilities.md),
so record that choice in an ADR if adopted. Native commands/events also require
a sidecar-bearing release under
[ADR 0007](../adr/0007-decouple-plugin-and-sidecar-releases.md). Review dependencies
before adoption. Start with Windows and macOS runtime proofs; expose unsupported
Linux sessions honestly until their native backend passes equivalent checks.

Acceptance: from another focused app, one configured chord starts recording into
the intended open note and a second stops it, with no focus change. Repeat while
Obsidian is minimized and verify audio continuity, final transcript delivery,
and microphone release. Test setup/permission failure, occupied chords, rapid
presses, note closure, multiple vaults, restart, disable, unload, and quit. No
hotkey or open microphone may survive its owner. Measure idle CPU and wakeups;
the shortcut alone must not load speech models or activate the microphone.

### Validation and remaining uncertainty

`npm run test -- test/session.test.ts test/audio-capture-stream.test.ts
test/register-commands.test.ts test/finalized-utterance-auto-copy.test.ts` passed:
4 files, 89 tests. These are existing automated tests with mocked host/audio
surfaces. No runtime code or dependencies changed. No global shortcut prototype,
installed Obsidian background-recording trial, Windows trial, or Linux trial was
performed in this investigation. The feature is feasible based on source and
platform APIs; its end-to-end behavior remains unverified.
