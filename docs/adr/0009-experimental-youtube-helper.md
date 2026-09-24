---
status: accepted
---

# Keep the YouTube helper experimental and behind the media lease boundary

The optional YouTube VOD source uses a user-selected absolute `yt-dlp`
executable, but it is not a YouTube API connector and is not a core
availability promise. It is disabled by default and can be disabled from
Settings. The product must present it as experimental, disclose
that the unofficial helper contacts YouTube and may break, and require a
one-time confirmation that the user owns or is authorized to process the
video. Public visibility is not permission. The policy version is persisted
only after that explicit confirmation; the helper is not bundled, installed,
updated, or retained by Speech Kit in this change.

The adapter parses only allowlisted HTTPS YouTube watch, `youtu.be`, and Shorts
URLs and reconstructs a canonical watch URL from the validated 11-character
video ID. Playlists, channels, live controls, arbitrary URLs, authentication,
cookies, proxies, token plugins, alternative clients, region/paywall/DRM
bypass, subtitles, archives, and live capture fail closed.

`YouTubeMediaSource` implements the provider-neutral `MediaSource` contract;
YouTube-specific references, consent, metadata, and failures stay in the
YouTube module rather than the shared contract. It probes the explicitly
selected absolute helper with `--version`, accepts a pinned-compatible
version, and uses the shared bounded process runner with `shell: false` and
fixed argument arrays. The runner uses detached POSIX process groups and
fixed-argv Windows `taskkill` tree handling, bounds cumulative output, and
clears process-tree and forced-kill timers on settlement. It never starts
synchronous process scans; POSIX cleanup uses the detached process group, and
normal descendant cleanup starts at the child `exit` event before `close` so
PID reuse cannot receive a post-close kill. Windows `taskkill` uses an absolute
system executable and a sanitized environment rather than inherited `PATH`. The command ignores
user configuration, caches, plugins, remote components, cookies, playlists,
mark-watched/live behavior, metadata sidecars, thumbnails, archives,
postprocessors, and external downloaders. It uses one audio-only stream, one
fragment, fixed generated output names, a private random job directory outside
the vault, a sanitized environment, and hard byte, duration, retry, rate,
output, and wall-time limits. Raw helper output is bounded and discarded; only
allowlisted metadata and progress may leave the adapter.

Acquisition requires a typed YouTube consent grant with the current policy
version and consent ID. The helper must return an exact requested video ID,
allowlisted title/channel/channel ID/duration/container/public URL metadata,
`is_live: false`, and `live_status: not_live`; missing, malformed, mismatched,
or live metadata fails before media is accepted. A successful acquisition
returns a provider-neutral `MediaLease` over a validated regular, single-link,
non-symlink file beneath the private job root. The lease constructor accepts
only an opaque validator-created descriptor bundle; the validated file and
job-root descriptors are retained and fchmod'd, so later path replacements
cannot change the bytes read by the lease or authorize deletion of a replaced
root. Its stream is pull-driven, pending outer reads are errored on release,
and release is an idempotent, best-effort shared promise. Startup cleanup is
age/mtime based and does not trust a PID-only owner marker; recent jobs are
preserved and stale jobs remain sweepable even when their recorded PID has
been reused. The command modal returns the selected helper and consent only after
a non-canceled submit; closing it invalidates probes and persists neither
value. Disabling the source closes an open modal, rechecks the kill switch
before provider acquisition, and cancels active provider work. The existing
controller then runs the exact local decode → VAD → batch ASR →
timestamps/diarization → smart formatting → optional text-only LLM path. The
LLM never receives the URL, title, channel, helper, path, provenance, or media
bytes. Cleanup runs on success, failure, cancellation, and disposal.

The managed one-click helper installer, platform binary distribution,
subtitle sidecars, authenticated access, and retention controls are explicitly
out of scope for this PR. Future changes to this boundary require a new ADR.
