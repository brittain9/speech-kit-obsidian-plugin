# Desktop dictation controls

Desktop controls let you dictate into an open Obsidian note while another app
has focus. Obsidian must remain running with Speech Kit enabled. This feature
requires the compatible native sidecar shipped with the plugin.

## Setup

1. Install a dictation model and complete microphone setup inside Obsidian.
2. Open the Markdown note that should receive dictation.
3. In Speech Kit settings, open **Advanced → Customize tools** and turn on
   **Desktop integration**. Its Capture settings then let you configure a
   **Global dictation shortcut**, enable **Show desktop status icon**, or use both.
   No shortcut is assigned automatically. **Play recording sounds** is optional.
4. Confirm that shortcut registration succeeded. A saved shortcut is not proof
   that the OS accepted it; another app may already own that combination.
5. Switch to another application and use the shortcut or desktop menu to start
   and stop dictation.

The destination is the last active eligible open Markdown note in this vault.
Starting fixes the destination for that session. Closing its editor or deleting
the note ends the session rather than sending text to another note. Background
starts with missing setup or a missing destination report a failure; return to
Obsidian to resolve it.

## Desktop menu

macOS places the status icon in the menu bar. Windows places it in the system
tray, possibly inside the overflow area. Linux exposes a StatusNotifierItem to
the desktop's tray host.

Left-clicking the macOS icon opens a compact native popover with the destination
note first, its vault and folder below, and a single Start/Stop action. The gear
opens settings; the arrow opens the destination note. Right-clicking opens the
native menu. Windows and Linux use native menus.

The menu-bar mark changes shape with session state: a quiet horizontal mark when
ready, a speech-shaped mark while listening, dots while starting, and equal bars
while finishing. It does not animate or claim to show input amplitude.

The menu shows the destination and recording state, Start/Stop dictation, Open
target note, and Settings. Starting can be cancelled. Finishing means the
microphone is off while remaining transcript work completes. Wait for that work
before starting another session from desktop controls.

Starting and stopping leave the foreground application in place. Open target
note and Settings deliberately bring Obsidian forward. Sounds signal actual
capture transitions, and desktop notifications provide background feedback.
Notifications do not include transcript text or note contents.

## Fedora and Omarchy

The Linux acceptance targets are Fedora Workstation's GNOME Wayland session and
Omarchy's Hyprland session. Shortcut registration uses the GlobalShortcuts portal;
the desktop can request consent and choose the effective shortcut.

GNOME needs a compatible AppIndicator/StatusNotifierItem extension to display
tray icons. Without a tray host, the shortcut and desktop feedback remain usable.
Speech Kit does not install shell extensions automatically.

Hyprland needs its desktop portal backend and a tray host such as Waybar's tray
module. Use the desktop's shortcut configuration when requested. A successful
Linux build alone does not verify either desktop environment.

## Multiple vaults and shutdown

One enabled vault owns desktop controls at a time. Another vault reports the
conflict and continues to offer ordinary Obsidian commands. Disable controls in
the owner before explicitly retrying from another vault.

Turning off **Desktop integration** removes native registrations and disables
recording feedback. Its configuration rows disappear; saved shortcut, icon and
sound preferences remain available when it is re-enabled. Ordinary in-app
recording can continue and remains controllable in Obsidian.

Disabling desktop controls removes their native registrations. Closing Obsidian
or unloading Speech Kit stops capture and releases native controls. A sidecar
recovery restores controls only; it never resumes microphone recording.

## Vorssaint on macOS

Vorssaint's optional Dynamic Island notification mirroring may show Speech Kit's
ordinary recording/error banners when enabled by the user. Speech Kit does not
change Vorssaint settings or permissions. Notification delivery and attribution
are controlled by macOS and Obsidian, so this coexistence path is not a verified
persistent activity integration.

The reviewed Vorssaint version exposes no external activity API for a dictation
card or Stop button. Speech Kit's own controls work independently. See the
[source assessment](../research/555-vorssaint-integration.md) for the integration
boundary and possible upstream extension.

## Development installation and validation

Build both components and install into a disposable test vault:

```sh
npm run build:frontend
npm run build:sidecar
npm run install:dev -- --vault /absolute/path/to/test-vault --sidecars --enable
```

Reload Speech Kit in that vault. Verify start/stop while another app is focused,
then while Obsidian is minimized. Use synthetic speech and a disposable note;
check complete final text, the intended destination, preserved foreground focus,
and microphone release. Repeat conflict, cancellation, missing-target, restart,
and unload checks. Record OS, desktop, installed build, and results separately
from automated test results before claiming platform support.
