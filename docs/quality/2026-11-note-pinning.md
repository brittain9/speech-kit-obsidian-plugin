# Optional note pinning and target identity

**Temporarily pin the target note** is enabled by default in Transcript output settings. It applies to the next dictation or file transcription. Speech Kit removes only pins it owns after processing ends. Pins set by the user remain in place. Turning the preference off leaves the tab unpinned; replacing its editor with another note stops dictation safely.

Review reproduced an existing safety gap: a reused CodeMirror editor could display another file while still passing the session's editor identity check. The session now requires the original file, editor, and leaf together. It checks before reading note context or modifying the editor, including late transcripts, batch transformations, additive output, and recording links. It also watches native file-open events. If the exact target cannot be resolved, projection stops instead of accepting another leaf that merely displays the same file.

Tests failed before implementation for disabled pinning, a reused editor with another file, late writes before navigation events, and context reads from a changed target. The full frontend gate passed with 1,815 tests and ten skipped, including both typechecks, both linters, and the production build. An independent review found no further concrete issue after the identity fix.

Native Obsidian QA passed with the combined store-switch and pinning frontend (1,839 tests; ten skipped):

- With pinning disabled, dictation reached Listening with the target tab unpinned. Opening another public QA note in that tab stopped dictation with a clear closed-or-replaced notice. Both notes retained their exact original bytes.
- With pinning enabled, the target tab gained a temporary pin during startup and listening. A normal stop removed it.
- A pin set manually through Obsidian remained after a listening session and normal stop. The test-created manual pin was then removed.
- The preference was restored to enabled. The shared model store was restored, and capture, recording, and system audio were left off.

The native check covered live-session pin behavior. File-transcription wiring and late transformation/recording safety were verified by integration and public Session tests; no claim is made that all third-party navigation extensions were exercised.
