---
status: accepted
supersedes: 0009-experimental-youtube-helper
---

# Import existing YouTube captions as text

The YouTube command retrieves existing timed captions through Obsidian's
`requestUrl`. It requests player metadata for a validated video ID, selects a
caption track in the job's language, and fetches that track. Creator captions
take priority over automatic captions; an unrelated language or translated
track is never substituted silently. The command validates the response and
stages the complete formatted transcript before one safe note insertion.

This supersedes the helper-based YouTube media source in ADR 0009. YouTube
caption import does not download video or audio, start a native speech model,
use `yt-dlp`, or create a `MediaLease`. ADR 0008's lease boundary continues to
govern encoded media acquisition for local files. Caption retrieval is a text
source and therefore enters the workflow after that boundary. The optional AI
step receives plain transcript text and bounded note context only. It runs
after the complete raw transcript is inserted, with the existing preview and
target-safety rules.

The caption endpoint is unofficial and can change. Missing, inaccessible,
invalid, or incomplete captions produce an error without changing the note;
there is no automatic audio fallback. A shared deadline and response-size
check bound accepted caption data. Obsidian's `requestUrl` materializes a
response before the plugin can check its size, so the size check is a
post-receipt bound. Cancellation prevents insertion even if an in-flight
`requestUrl` call cannot be interrupted. The command is available on supported
desktop platforms without a platform-specific YouTube executable. Previously
installed helper files are left in place rather than deleted during upgrade.
