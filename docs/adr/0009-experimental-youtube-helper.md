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
fixed argument arrays. The runner uses detached POSIX process groups, bounds
cumulative output, and clears process-tree and forced-kill timers on
settlement. Cancellation and timeout wait for the child's `close` event (or a
bounded close deadline) after signalling; a child that cannot close is
cleanup-failed and cannot produce a media handoff. It never starts synchronous
process scans; POSIX cleanup uses the detached process group, and normal
descendant cleanup starts at the child `exit` event before `close` so PID reuse
cannot receive a post-close kill. The experimental YouTube source is disabled
on Windows: the command is hidden, settings show a localized unsupported
message, and neither `yt-dlp` nor cleanup children are spawned. The command ignores
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
only an opaque validator-created descriptor bundle; recursive cleanup accepts
only an opaque job-root capability created from the owner marker and held root
descriptor. The validated file and job-root descriptors are retained and
fchmod'd, so later path replacements cannot change the bytes read by the lease
or authorize deletion of a replaced root. Its stream is pull-driven, pending
outer reads are errored on release, and release is an idempotent, best-effort
shared promise. Startup cleanup is age/mtime based, uses a stable owner marker
with process-start metadata and a heartbeat, and does not trust a PID-only
owner marker; recent or actively heartbeated jobs are preserved while stale
jobs remain sweepable even when their recorded PID has been reused. Heartbeat
validation rejects malformed markers, invalid instance/PID/start identities,
future timestamps beyond a small clock-skew allowance, and stale timestamps.
Startup sweeping requires the same valid identity-checked marker; corrupt or
foreign prefix matches are retained for manual recovery rather than deleted.
On supported macOS and Linux runtimes, recursive contents cleanup runs in a
bounded, shell-less child using the current Electron executable in Node mode
(`ELECTRON_RUN_AS_NODE=1`) and a fixed built-in `-e` script. The held root
directory descriptor is inherited as fd 3; the child `fstat`s that descriptor,
`stat`s its `/dev/fd/3` cwd, and exits without deletion if their identities
differ. It removes only `readdir` entries relative to that stable cwd. The
parent keeps the root descriptor open, bounds the child and waits for its
actual close, and after success revalidates the root pathname against the held
descriptor before removing only the empty root. The original replaceable
pathname is never passed to recursive deletion. If descriptor inheritance is
unavailable, cleanup fails closed and leaves the private root for manual
recovery; there is no pathname-recursive fallback. The command modal returns the selected helper, probed version, and consent only
after a non-canceled submit; closing it invalidates probes and persists neither
value. A tracked modal registry prevents repeated concurrent command probes
and closes every session on disable. Disabling the source rechecks the kill
switch before provider acquisition and cancels active provider work through
the provider-specific controller signal, including post-ready decode, ASR,
formatting, and optional LLM work. The existing controller then runs the exact local decode → VAD → batch ASR →
timestamps/diarization → smart formatting → optional text-only LLM path. The
LLM never receives the URL, title, channel, helper, path, provenance, or media
bytes. Cleanup runs on success, failure, cancellation, and disposal.

The managed one-click helper installer, platform binary distribution,
subtitle sidecars, authenticated access, and retention controls are explicitly
out of scope for this PR. Future changes to this boundary require a new ADR.
