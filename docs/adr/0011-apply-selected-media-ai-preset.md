---
status: accepted
supersedes: media AI preview behavior in 0008-media-acquisition-boundary and 0010-youtube-caption-import
---

# Apply selected media AI presets after transcription

Selecting an AI preset in a file or YouTube transcription job authorizes that
job to apply the preset's configured replace, add-above, or add-below behavior
after the complete raw transcript has been inserted. There is no second preview
confirmation. The modal discloses the chosen provider, model, and whether
transcript text leaves the device before the job starts.

The shared media AI processor sends transcript text and any explicitly enabled
bounded note context. It rechecks settings and cancellation before application,
rejects empty and bare refusal responses, and applies output only if the
original editor range is still safe. A failed or declined provider response
leaves the raw transcript in the note. Replacement records a recovery receipt;
additive output leaves the transcript untouched and is undoable. Audio and
video bytes are never sent to the AI provider.
