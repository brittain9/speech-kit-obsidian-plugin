# Configurable dictation quick control

Advanced → Customize tools offers one Dictation control preference: Ribbon,
Status bar, Both, or Commands only. Missing or invalid saved values use Ribbon,
preserving existing users' layout. Commands and hotkeys remain registered in all
modes. The optional sidebar stays available explicitly; setup does not open it.

The status-bar alternative reuses the existing dictation status item with a
compact native button for starting, cancelling startup, stopping, and retrying.
It delegates to the same controller toggle used by commands and the ribbon.
Older local/provider work can finish beside a new capture session without
changing that session's Start/Stop action. One mounted button preserves focus
and listener identity across status and preference updates.

Changing the preference hides only Speech Kit's own ribbon/status controls.
The hidden ribbon stops animation and speech-tail timers and releases its
reduced-motion observer; showing it restores the current state. No global
Obsidian ribbon setting, microphone ownership, accepted text, recovery, or
session lifecycle changes. Existing passive Listening/Finishing/provider status
remains available even when its action button is hidden. Plugin unload removes the status click listener
before asynchronous teardown. No new capture state owner is introduced.

Public tests cover default/invalid preference normalization, save and reopen,
all status actions, hide/show identity and listener stability, hidden ribbon
observer cleanup, and stopping an active session through the shared public
command toggle after controls are hidden. Setup explains choosing the status
bar and using command/hotkey alternatives without assuming the ribbon is visible.
New copy keys use English fallback until translated.

Before the preference was added, native verification by the shared QA owner
passed with the ribbon hidden and sidebar closed: Dictate starts Listening,
Space on the focused button stops, finishing status stays separate, and idle
Dictate returns. The control fit the native half-screen window. The new
preference still needs native switching checks in the combined build, plus the
owner's remaining light-theme and sizing checks. This remains an exploratory
draft pending that review.
