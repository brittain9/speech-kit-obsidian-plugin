# Hide optional tools

Open **Settings → Speech Kit → Advanced → Customize tools** and choose
**Customize** to turn off **Translation**, **Read aloud**, or **AI transformations**.
All three are enabled by default, preserving existing setups.

Hidden tools lose their command-palette entries, editor context-menu actions,
model summary rows, and detailed settings. Reopen **Customize tools** to bring a
tool back. Models, selected voices, provider settings, presets, and hotkeys are kept. **Manage models** still lists installed models for inspection
and removal, including models for hidden tools.

An operation already in progress keeps its status and stop/cancel controls.
Read aloud can finish or be stopped. A retained translation preview can still be
copied, applied to its original unchanged source, or dismissed; it cannot start
a new translation or model request while hidden. Turning a tool off never
removes text already added to your note.

**AI transformations** is the overall AI switch. Turning it off hides
preset/provider controls and makes new media imports transcript-only, even if a
media preset was saved earlier. Disabling AI during optional processing keeps
the raw transcript and existing cancellation/recovery behavior. Dictation,
transcription, and the Speech Kit view remain available without AI features.

**Transform new dictation** is narrower: it controls automatic transformation of
new speech. It can stay off while you explicitly choose a preset for a file or
YouTube transcript, as long as **AI transformations** is on.

The same **Customize tools** dialog has one **Dictation control** choice:
**Ribbon**, **Status bar**, **Both**, or **Commands only**. Ribbon is the default.
Changing it keeps an active session running. The command palette and assigned
hotkeys can always start or stop dictation, including when both quick controls
are hidden. The status-bar button offers Dictate, Stop, and Retry without
opening the optional sidebar.
