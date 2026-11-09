# Local workflow status

The status bar reports dictation startup, listening, native transcription when the engine reports it, and finishing while accepted speech drains after capture stops. Listening and an older finishing session can appear together. Queue pressure uses the sidecar's actual utterance tiers; it is not an estimate of audio lag or remaining time. Provider processing is labeled separately because it can use a remote provider.

A retained partial media transcript shows an attention action that opens the existing recovery interface. Routine raw-transcript undo receipts do not raise an attention status. Detached translation uses a keyboard-operable button and a separate polite live region. Reduced-motion settings stop the existing progress animations.

A one-sentence completion or timeout now releases microphone capture when the sidecar stops the session. The stop path waits for any recording save before it embeds the recording and disposes the session. Tests reproduced both stop reasons and the delayed recording save.

Controller and presentation tests cover overlapping sessions, queue tiers, accepted work after native stop, provider processing, recovery clearing, and translation focus. Native Obsidian verification remains required for visual layout, live announcements, recovery activation, and rapid stop/restart.
