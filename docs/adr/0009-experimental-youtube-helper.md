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

`YouTubeMediaSource` implements the provider-neutral `MediaSource` contract.
It probes the explicitly selected absolute helper with `--version`, accepts a
pinned-compatible version, and spawns it with `shell: false` and a fixed
argument array. The command ignores user configuration, caches, plugins,
remote components, cookies, playlists, mark-watched/live behavior, metadata
sidecars, thumbnails, archives, postprocessors, and external downloaders. It
uses one audio-only stream, one fragment, fixed generated output names, a
private random job directory outside the vault, a sanitized environment, and
hard byte, duration, retry, rate, output, and wall-time limits. Raw helper
output is bounded and discarded; only allowlisted metadata and progress may
leave the adapter.

A successful acquisition returns a provider-neutral `MediaLease` over a
validated regular non-symlink file beneath the private job root. Its stream is
pull-driven, its release is an idempotent shared promise, and release removes
the complete job directory. The existing controller then runs the exact local
decode → VAD → batch ASR → timestamps/diarization → smart formatting →
optional text-only LLM path. The LLM never receives the URL, title, channel,
helper, path, provenance, or media bytes. Cleanup runs on success, failure,
cancellation, and disposal, with best-effort startup sweeping.

The managed one-click helper installer, platform binary distribution,
subtitle sidecars, authenticated access, and retention controls are explicitly
out of scope for this PR. Future changes to this boundary require a new ADR.
