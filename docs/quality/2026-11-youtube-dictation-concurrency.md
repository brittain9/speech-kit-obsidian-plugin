# YouTube captions during dictation

## Reproduced failures

Issue #540's caption import was blocked by `runYouTubeCaptionImport` checking
`isDictationBusy` and reporting that another media transcription was running.
The modal's media-job guard was not the dictation blocker. A controller test
reproduced this before the guard was removed.

Before enabling concurrent note writes, real CodeMirror tests exposed two
ownership problems:

- A newer transcript inserted at an older session's boundary extended the older
  span's end. Future speech and whole-session cleanup could include sibling text.
- A single shared processing range let a second session replace the first
  session's lock; clearing or disposing the second surface removed the first
  lock. Public editor operations reproduced both unwanted unlocks.

## Resulting behavior

Caption acquisition is independent of microphone dictation and native engine
maintenance. It starts no speech model, takes no inference lease, and does not
stop microphone capture. A caption job still excludes another media job.
Microphone start/restart can proceed while caption text is loading.

While dictation is active or draining, captions append at the original note's
end rather than at a cursor that may be inside live speech. Later dictation
remains before the imported caption block. Outside dictation, the configured
insertion placement remains in effect. The dialog explains this behavior.
Navigation to a different note rejects insertion with caption-specific guidance.
Cancellation ignores late caption results without stopping dictation.

Note surfaces now keep newer boundary inserts outside older regions, including
an inserted initial newline. Processing locks are keyed by surface owner, map
through editor transactions, and merge only for display/filtering. Clearing or
disposing an owner releases only that owner's lock; gaps remain editable.

Unavailable captions remain a caption-acquisition failure and leave the note
unchanged. ADR 0010's prohibition on automatic audio fallback is preserved.
Explicit local-file transcription still waits for dictation, including draining.

## Verification

- Failing controller checks established the dictation blocker, placement rule,
  false speech ownership, and misleading navigation failure before fixes.
- Controller tests cover available/unavailable captions, engine maintenance,
  repeat submission, cancellation with late results, and navigation.
- Real CodeMirror + Session tests cover partial-to-final revision, subsequent
  speech, both insertion placements, and cleanup preserving the caption block.
- Real editor tests cover independent processing locks, unrelated disposal,
  editable gaps, mapped positions, and sibling inserts at a locked boundary.
- `npm run check:frontend`: passed; 1,943 tests passed, 10 skipped. Type checks,
  Biome, Obsidian ESLint, and production frontend build passed.
- Native Obsidian: pending verification of the exact combined build by the
  shared QA owner. Unit/editor tests do not establish native or Linux results.
