# Vorssaint integration assessment

Source reviewed: official [vorssaint/vorssaint-utils](https://github.com/vorssaint/vorssaint-utils)
at commit `89d2626089d693bf0462ba29ea5d047d80c9da2e`. The installed application at
`/Applications/Vorssaint.app` reports version 3.4.4, matching this source's
version metadata. Source inspection does not establish that the installed binary
was built from that exact commit. No third-party source was executed or adopted.

## What can integrate today

The concrete existing route is ordinary macOS notification banners. Vorssaint's
optional [NotchNotificationService](https://github.com/vorssaint/vorssaint-utils/blob/89d2626089d693bf0462ba29ea5d047d80c9da2e/Sources/Vorssaint/Services/Notch/NotchNotificationService.swift)
observes Notification Center through Accessibility when the user enables its
notification feature and grants permission. It mirrors banners and can open the
source application. Its implementation deliberately avoids notification databases.

Speech Kit's generic recording/error notifications can therefore coexist with
that feature. This is an inference from the two implementations, not a verified
installed-app integration. Obsidian owns renderer notifications, so source
attribution may be Obsidian even when the notification title says Speech Kit.
Vorssaint settings, OS notification policy, and banner delivery affect visibility.
Speech Kit must not enable Vorssaint features or change its permissions silently.

This route supplies transient feedback. It does not supply a persistent recording
activity, waveform, session duration, destination display, or external Stop button.
Do not advertise those as implemented through notification mirroring.

## No published external activity interface found

The reviewed [NotchSupport](https://github.com/vorssaint/vorssaint-utils/blob/89d2626089d693bf0462ba29ea5d047d80c9da2e/Sources/Vorssaint/Services/Notch/NotchSupport.swift)
defines closed application-owned module and compact-activity enums. The
[NotchService](https://github.com/vorssaint/vorssaint-utils/blob/89d2626089d693bf0462ba29ea5d047d80c9da2e/Sources/Vorssaint/Services/Notch/NotchService.swift)
coordinates those internal services. Its capture controls refer to Vorssaint's
own recorder rather than arbitrary external microphone sessions.

Repository searches found no published plugin SDK, external activity registration
API, or generic activity IPC listener. The reviewed
[Info.plist](https://github.com/vorssaint/vorssaint-utils/blob/89d2626089d693bf0462ba29ea5d047d80c9da2e/Resources/Info.plist)
declares no custom URL scheme, and the
[AppDelegate](https://github.com/vorssaint/vorssaint-utils/blob/89d2626089d693bf0462ba29ea5d047d80c9da2e/Sources/Vorssaint/App/AppDelegate.swift)
has no external URL command handler. Distributed notification observers found in
the notch implementation handle system events and download completion, not an
external live-activity contract. Absence in this reviewed revision is not a
promise about future Vorssaint releases.

## Recommended next step

Keep Speech Kit's own status/menu usable independently. For a richer native
popover, design Speech Kit's own interface around recording state, elapsed time,
input level, destination, and Start/Stop; keep the existing controller authoritative.
Use Vorssaint as a quality reference, without copying its implementation or assets.

A genuine Vorssaint recording activity needs an upstream external-activity API or
an upstream Speech Kit adapter. Specify status updates, action callbacks, per-session
identity, expiry/crash cleanup, and a permission boundary before implementing it.
Keep transcript contents out of that contract by default. No upstream request or
pull request was sent during this investigation.

The source is GPL-3.0-or-later and its
[trademark policy](https://github.com/vorssaint/vorssaint-utils/blob/89d2626089d693bf0462ba29ea5d047d80c9da2e/TRADEMARKS.md)
reserves branding and trade dress. This assessment adopts no Vorssaint UI code,
branding, or assets into Speech Kit.
