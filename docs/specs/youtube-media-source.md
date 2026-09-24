# Experimental YouTube media source

Status: active implementation spec

## Goal

Add an experimental, opt-in YouTube VOD source without changing the local-file
transcription path. The source is advanced and unofficial: a user explicitly
selects an absolute `yt-dlp` executable, acknowledges that the helper contacts
YouTube and may break, and confirms that they own or are authorized to process
the selected video. Public visibility alone is not permission.

## Public seams

1. URL inspection accepts one allowlisted watch, `youtu.be`, or Shorts URL,
   canonicalizes its 11-character video ID, and rejects playlist/channel/live
   and arbitrary URLs.
2. Acquisition emits provider-neutral plan/progress/ready events and returns a
   temporary path-backed `MediaLease` with bounded pull-driven bytes and
   idempotent release.
3. The existing media controller passes every ready lease through the exact
   local decode, VAD, batch-ASR, timestamp/diarization, formatting, and
   optional text-only LLM pipeline.
4. Cancellation, helper failure, process crash, and release clean temporary
   media best effort; acquisition maps failures to typed, non-sensitive errors.

## Fixed helper policy

The source accepts only an absolute selected executable. It probes `--version`
only after selection, accepts a pinned-compatible version, and never executes
PATH candidates during discovery. The acquisition command uses `shell: false`,
`spawn` with an absolute executable, one job, fixed generated output names,
private cwd/home/temp/cache, a sanitized environment, YouTube-only extraction,
`bestaudio`, no cookies/config/plugins/remote components/playlists/archive/info
JSON/postprocessors/external downloaders/redirects, and hard byte/duration/
wall-time/retry/rate limits. Raw stdout/stderr and signed URLs are never logged
or persisted; only bounded allowlisted metadata and progress are surfaced.

## Settings and policy

Store the selected path and the policy version only. Store the one-time rights
confirmation only after explicit consent. Show helper health/path/version and an
experimental badge; no retention setting, installer, bundled binary, login,
cookies, proxy, alternative client, token plugin, region/paywall/DRM bypass,
or live/archive/subtitle support belongs in this PR.

## Verification

Use local fake helper fixtures. Cover the URL matrix, consent, discovery,
version parsing, fixed args/env, child cancellation, temp validation/cleanup,
shared release, and local-file regressions. No tests contact YouTube.
