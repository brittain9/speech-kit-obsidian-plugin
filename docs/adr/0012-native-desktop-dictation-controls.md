---

## status: accepted

# Native desktop controls for Obsidian dictation

The Rust sidecar owns optional OS shortcut registration and native status menus.
The plugin owns destination selection, microphone capture, dictation lifecycle,
settings, feedback, and editor insertion. Desktop actions and status use the
existing framed stdio connection; no local network control service is added.
This extends the native responsibilities described in ADR 0001.

An exclusive per-user OS-backed lock limits desktop controls to one enabled
vault. Another vault reports the conflict instead of taking over. Native
resources follow their owning connection and are released on disable or EOF.
Restarting controls never restarts microphone recording automatically.

Background dictation snapshots the last active eligible open Markdown target
before asynchronous startup. It retains that target until completion and fails
if it becomes invalid. Desktop controls never choose another note silently.
Only explicit open-note/settings actions bring Obsidian forward.

Native event handling must not block speech or protocol processing. macOS uses
its main-thread application event loop; protocol output remains serialized.
Wayland shortcuts use the desktop portal and Linux icons use StatusNotifierItem,
so neither X11 key grabbing nor GTK is required for the Linux acceptance target.
Tray availability and shortcut availability are independent capabilities.

The master Desktop integration switch lives in Capture, alongside a native settings modal, and
defaults off. It gates registrations and feedback while retaining saved preferences. Obsidian remains required, and a missing GNOME tray host
does not prevent shortcut use. This keeps the integration useful without adding
a standalone application lifecycle or arbitrary-application text injection.

Native and protocol changes require a sidecar-bearing release under ADR 0007.

Connection-scoped controls observe persistent process lifecycle events, while
session-scoped stop listeners remain one-shot. Every process loss invalidates
native configuration and action generations. Intentional maintenance does not
immediately respawn the process; a later successful startup restores enabled
controls without restarting microphone capture.

## Shared dictation glyph (direction A)

The desktop icon extends the ribbon's Lucide audio-lines identity; the existing
ribbon SVG and animation remain intact. In the native 24-point grid, Ready has
six quiet short strokes. Recording has six separated strokes at x=2/6/10/14/18/22,
with centerline lengths 3/11/18/7/13/3 and round 2-point strokes. Finishing has
three short equal strokes; Starting retains its three dots and Unavailable its
cross. These static shapes reflect lifecycle state, not a fabricated audio meter.
One pure renderer supplies RGBA for macOS/Windows and network-order ARGB for
Linux StatusNotifierItem; Linux uses the supplied pixels rather than a theme
microphone icon. macOS keeps native template tinting.
