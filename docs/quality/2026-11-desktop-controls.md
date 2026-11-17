# Desktop controls validation

Issue: [#555](https://github.com/brittain9/speech-kit-obsidian-plugin/issues/555).
Scope: opt-in native controls for dictation into an open Obsidian note.

## Acceptance boundaries

- Windows/macOS native hotkeys and menus; GNOME Wayland and Hyprland portal
  shortcuts and StatusNotifierItem menus.
- Start snapshots the destination before permission/model/process awaits.
- Recording state follows actual capture; finishing has no open microphone.
- Starting/stopping preserves foreground focus. Explicit open actions reveal
  Obsidian.
- A per-user native ownership lock prevents competing vaults from controlling
  different notes with one press.
- EOF, disable, unload, quit, cancellation, and process failure release owned
  resources. Restoring controls does not restore recording.

## Runtime certification

Platform support requires installed-plugin trials, not just compilation or
mocked tests. The macOS host has an accessible Obsidian 1.15.1 test vault.
Windows, Fedora GNOME, and Omarchy Hyprland hosts are not available in this
session; their runtime certification remains pending.

For each platform, record the installed build, shortcut registration and consent,
another foreground app, minimized Obsidian, complete synthetic transcript,
microphone release, destination closure, missing prerequisites, repeat presses,
two vaults, tray-host loss, restart, unload, and idle CPU/wakeup measurements.

Automated results and observed runtime results are recorded separately below.

## Automated checks

- Both frontend typechecks, ESLint, and production frontend build passed.
- Full frontend suite passed 2,032 tests with 15 skips. The final focused controller,
  coordinator, plugin lifecycle and shared wire suites passed 151 tests.
- Native library/binary tests passed 314 tests; strict library/binary Clippy
  passed. The production TypeScript client against the real native executable
  passed all five integration checks.
- Linux desktop module typechecked against actual ashpd/ksni dependencies in an
  isolated check. Full Linux cross compilation was blocked by the missing GNU
  cross C compiler needed by the existing ring dependency. This is not Linux
  runtime certification.
- The aggregate frontend command encounters pre-existing nested Biome configs
  in unrelated local worktrees. Equivalent explicit-path Biome checks passed;
  unrelated worktree files were preserved.

## Native macOS smoke

The built debug sidecar, launched outside the sandbox, accepted
`Control+Alt+Shift+F12`, reported `shortcutStatus=registered`, `iconAvailable=true`,
and `owner=true`. Closing its stdio connection exited with status 0. The first
sandboxed attempt could not connect to macOS UI services; its exact process was
terminated during cleanup.

CUA could inspect the open Obsidian test vault, but the desktop was actively in
use and foreground-app selection encountered timeout/user-change guards. No
installed-plugin microphone, transcript, minimized-window, or focus-preservation
result is claimed. Existing test-vault plugin files and note contents were not
overwritten for this trial. Keep the implementation PR draft until platform
acceptance trials are complete.

## Visual follow-up

The initial macOS custom popover was added after reviewing Vorssaint as a design
reference. Alex prefers the earlier presentation to this first custom version;
the design remains unresolved and must be revisited before marking the PR ready.
Native registration and orderly exit were repeated successfully after adding the
popover. CUA could not target the bare sidecar status item; a temporary app
wrapper also failed to provide reliable UI access. No visual/accessibility
certification is claimed. Both smoke sessions were closed and exited with code 0.

Vorssaint has no external activity API in the source reviewed. Optional ordinary
notification mirroring is an inferred coexistence path, not a verified custom
Dynamic Island integration.

## November 17 integration pass

Main was merged into the desktop-controls branch. Alex selected the destination-first
popover: prominent note, secondary vault/folder, compact Start/Stop, and icon-only
Open note/Settings actions. A static shape-changing speech mark replaces the menu-bar
microphone. The Dynamic Bar image remains a future concept; no external activity
integration is implemented.

Desktop integration now has an off-by-default master switch in Advanced → Customize
tools. Regressions cover saved preferences remaining inert while off, explicit disable
without erasing them, destination identity when an editor is reused, and persistent
connection lifecycle observation across sidecar replacements. The last two cases
failed before the fixes. Installed background/minimized and popover checks are
recorded separately once observed.
