# YouTube transcription source acquisition

Primary-source review completed 2026-09-24 against `origin/main` at `a1fc7ba`.
This is product and policy research, not legal advice. YouTube publishes
region-specific API Terms; counsel must review the terms for every market in
which a build is distributed.

## Executive answer

**No: a pasted, arbitrary public YouTube URL cannot be acquired as media bytes
through an official YouTube API.** Speech Kit can parse the URL to a video ID
and use official APIs for some metadata, but the documented official surfaces
do not expose a public-video audio/video download method:

- The YouTube Data API's `videos.list` returns metadata such as title, duration,
  caption availability, license, region restrictions, and (only to the owner)
  original-file details. It does not return a downloadable copy of a public
  video. See the official [`video` resource](https://developers.google.com/youtube/v3/docs/videos)
  and [`videos.list`](https://developers.google.com/youtube/v3/docs/videos/list).
- `captions.list` and `captions.download` are authorized caption-management
  methods, not general public transcript/media APIs. `captions.download`
  expressly says the user must have permission to edit the video, requires
  `youtube.force-ssl` or `youtubepartner`, and costs 200 quota units. See
  [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download).
- The IFrame Player API controls an official player—queueing, playback, seeking,
  state, and limited video information. It documents no raw-media or file
  acquisition operation. See the official
  [IFrame Player API reference](https://developers.google.com/youtube/iframe_api_reference)
  and [player parameters](https://developers.google.com/youtube/player_parameters).
- YouTube's help UI can show a transcript for a captioned public video, but that
  UI is not a developer API. See
  [View video transcripts](https://support.google.com/youtube/answer/15930243?hl=en).
- YouTube offers an official download of a user's **own** uploaded video from
  YouTube Studio and explicitly says other users' videos cannot be downloaded
  that way. This is a user-owned acquisition route, not an arbitrary-public-URL
  API. See
  [Download YouTube videos that you've uploaded](https://support.google.com/youtube/answer/56100?hl=en).
- Premium offline downloads, purchased/rented movie downloads, and app-managed
  offline playback are features of YouTube applications. They are not an
  official developer API that emits a file for arbitrary third-party
  transcription. See [Premium offline downloads](https://support.google.com/youtube/answer/11977233?hl=en),
  [purchased-content downloads](https://support.google.com/youtube/answer/10005180?hl=en),
  and the [Paid Service Usage Rules](https://www.youtube.com/t/usage_paycontent).

“Public” is therefore a visibility state, not a media-download license. The
YouTube API agreement requires documented access methods, forbids undeclared
third-party rights, and grants no reproduction/distribution right outside the
API agreement. The API Developer Policies separately prohibit downloading,
importing, backing up, caching, or storing YouTube audiovisual content without
YouTube's prior written approval. Relevant provisions are sections 3.1, 5, 12,
16.3, and 24.3 of the [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service),
and sections III.D.7, III.E.1, and III.E.6 of the
[Developer Policies](https://developers.google.com/youtube/terms/developer-policies#e-handling-youtube-data-and-content).
The consumer [YouTube Terms of Service](https://www.youtube.com/t/terms) likewise
limit viewing/listening to personal, non-commercial use, require express
authorization or permission for downloads and automated access, and prohibit
circumventing features that restrict copying or use.

The defensible product position is therefore:

> Speech Kit does not promise “paste any public YouTube URL.” Its stable default
> accepts local media. A separate, authorized-captions path may import caption
> tracks for videos the user can edit. An unofficial local helper may be offered
> only as an advanced, optional integration after explicit legal/platform and
> maintainer approval, with no promise of universal access.

## Capability matrix

| Desired result | Official route? | Authorization and limits | Product disposition |
| --- | --- | --- | --- |
| Parse a public watch/Shorts URL to a video ID | Yes, locally | Accept only an allowlisted YouTube host/path and canonical 11-character ID; reject playlist/channel/live control URLs | Safe |
| Fetch public metadata | Yes, Data API | `videos.list`; public metadata does not imply access to media | Optional metadata only; obey storage/display rules |
| Fetch a public video's caption track | **No general API** | `captions.list` and `captions.download` require a user who can edit the video | Offer only for the user's authorized/managed videos |
| Fetch a user's own uploaded media | Yes, YouTube Studio/Takeout | Studio download is 720p or 360p depending on source and has content/download limits; not a Data API media endpoint | Recommend export, then local import |
| Fetch public media bytes/audio | **No documented official API** | API agreement grants no reproduction/download right; public status is not permission | Do not promise or emulate it in the official connector |
| Play a public video through the official player | Yes, IFrame Player API | Official playback only; uploader/embed, age, region, and policy restrictions remain | Not a file source; optional user-driven system-audio capture only |
| Use Premium/purchased content offline | In YouTube apps only | Account-, device-, location-, rental-, and app-managed restrictions | Fail closed; do not extract app-managed copies |
| Download with yt-dlp | No; unofficial client | Uses undocumented/current site behavior; cookies, PO tokens, JS challenges, and platform changes | Optional helper only, after approval |

## Official surfaces in detail

### Data API metadata is not media acquisition

`videos.list` can return a video's title, description, channel, duration, audio
language, whether captions exist, region restriction, content rating, license
(`youtube` or `creativeCommon`), and embeddability. The resource documentation
also says `fileDetails`, which describes the originally uploaded file, “can
only be retrieved by the video owner”; `videos.list` returns 403 for improper
attempts to access that part. See the official
[`video` resource](https://developers.google.com/youtube/v3/docs/videos#fileDetails)
and [`videos.list` errors](https://developers.google.com/youtube/v3/docs/videos/list#errors).

These fields are useful for preflight and attribution, but:

- a Creative Commons video license answers a copyright-license question for the
  work; it does not grant a new right to reproduce bytes through an undocumented
  YouTube endpoint. YouTube's [CC help page](https://support.google.com/youtube/answer/2797468?hl=en)
  says YouTube cannot grant rights to someone else's uploaded content;
- `embeddable=true` authorizes official embedding, not file acquisition. The
  same video resource warns that policy or third-party claims can still block
  embedded playback;
- public metadata does not bypass age, membership, purchase, private, embed, or
  territorial restrictions.

If the plugin uses `videos.list`, it still becomes an API Client. It must link
YouTube's Terms, present a privacy policy, use one API project for this client,
explain data use, avoid undocumented endpoints, and follow the storage,
refresh, deletion, branding, and revocation requirements in the API Terms and
Developer Policies. The policies require active consent, prohibit collecting
YouTube login credentials, require a straightforward deletion path, and
generally limit non-statistical Authorized Data to the active consent period
and no more than 30 calendar days. They also contain a broad restriction on
using API Data to create derived data or metrics; legal review is required
before a caption import is transformed, compared, summarized, or persisted.

### Authorized caption download is real but narrow

The official [captions implementation guide](https://developers.google.com/youtube/v3/guides/implementation/captions)
supports listing and downloading a caption track through OAuth. The detailed
contract is narrower:

- [`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list)
  returns track metadata, not caption text, and costs 50 units.
- [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download)
  **requires permission to edit the video**, accepts
  `youtube.force-ssl` or `youtubepartner`, and costs 200 units.
- It can return the original format or request `sbv`, `scc`, `srt`, `ttml`, or
  `vtt`; `tlang` requests a machine translation.
- The caption resource identifies `ASR`, `forced`, and `standard` tracks,
  language, audio-track type, and synchronization metadata. See the official
  [`caption` resource](https://developers.google.com/youtube/v3/docs/captions).

This supports a **managed-video caption connector**, not a connector for any
public video. It is also text-only: it supplies no audio for VAD, local ASR, or
diarization. YouTube warns that automatic captions can misrepresent speech
because of pronunciation, accents, dialects, and background noise, and should
be reviewed. See [Use automatic captioning](https://support.google.com/youtube/answer/6373554?hl=en).

`youtube.force-ssl` is broad: Google describes it as permission to see, edit,
and permanently delete the user's videos, ratings, comments, and captions. A
desktop client therefore needs an approved OAuth and client design, secure
token storage, explicit consent, revocation, deletion, privacy disclosure, and
ongoing Google policy monitoring. The policy also says clients must not obtain
or store the user's YouTube login credentials. OAuth is the supported path;
it is not interchangeable with copying browser session cookies.

### The official player is playback, not extraction

The [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
can queue content, play/pause/stop, seek, set volume/rate/size, retrieve
current time/duration and some video information, and receive player events.
Its byte-count methods are documented as deprecated approximations. It does
not return a media stream or file. Errors explicitly cover missing/private
videos and owner-disabled embedding, and YouTube Help says age-restricted
videos are generally redirected away from third-party embeds. See
[Embed videos & playlists](https://support.google.com/youtube/answer/171780?hl=en).

If Speech Kit ever embeds the player, it must also follow the current
[Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality),
including app identity, appropriate `Referer`/`origin`, player branding,
visibility/autoplay rules, and the prohibition on overlays. That route is
unsuitable as unattended local-file acquisition.

### User-owned and app-managed downloads are distinct

For a user's own upload, YouTube Studio provides an MP4 at 720p or 360p
(depending on the source) or the user can use Google Takeout. The help page
lists removal, copyright/Community Guidelines strikes, pre-approved audio,
and five-downloads-per-video-per-24-hours limits. Speech Kit should link the
user to that official export and then ingest the selected local file. It
should not attempt to turn ownership knowledge supplied by the user into
network retrieval from YouTube.

Premium offers official offline viewing in YouTube applications. Purchased and
rented films/shows can also be downloaded for offline viewing in supported
YouTube apps, subject to account/device/rental rules. The Paid Service Usage
Rules describe an authorized device and controlled streams; they do not
promise a developer-usable media file. These routes must fail closed in an
acquisition adapter.

## Optional yt-dlp helper evaluation

### Technical assessment

yt-dlp can technically retrieve audio for many public, non-DRM YouTube videos
and is the only practical optional local helper identified by this review. It
is **not a YouTube API**, and its own maintainers document the moving nature of
YouTube support:

- The latest stable release at review time was
  [`2026.08.19`](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19),
  commit `3a08bea`. The README says stable is often stale relative to site
  changes, recommends nightly for regular users encountering breakage, and
  warns versions older than 90 days. See
  [`README: update channels`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md#update-channels).
- The [known-issues index](https://github.com/yt-dlp/yt-dlp/issues/3766) listed
  current YouTube page-reload, embed-disabled, and age-restricted-format
  failures, subtitle 429s, SABR-only formats, and account/IP blocks at review
  time.
- The [PO Token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
  says YouTube was rolling out video and subtitle PO-token enforcement. Tokens
  are externally generated, often video-bound, and supplied by unaffiliated
  plugins/providers. The guide itself does not maintain or support those
  providers.
- The [extractors wiki](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)
  warns that cookie use can result in temporary or permanent account bans and
  documents rate limits and guest/account behavior.

Therefore the helper can be a best-effort advanced source, not a dependable
core dependency or an availability promise.

### Installation and version pinning

If approved, prefer a Speech Kit-managed, platform-specific helper bundle with
an exact manifest rather than an arbitrary executable from `PATH`:

1. Pin the yt-dlp tag and immutable commit, not `latest`.
2. Pin one official release asset per supported OS/architecture. The upstream
   matrix includes a universal macOS binary, Windows x64/x86/ARM64, Linux
   glibc and musl x86_64/ARM64 (plus selected ARMv7), and a platform-independent
   Unix zipimport binary requiring Python. See
   [`README: release files`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md#release-files).
3. Download the corresponding `SHA2-256SUMS` and signature from the same pinned
   release. Upstream publishes both and documents verifying its GPG public key;
   see [`README: release files`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md#release-files).
   Verify the signature with a maintainer-reviewed, pinned key fingerprint,
   then the digest, before making the file executable.
4. Store the executable outside the vault in Speech Kit's private application
   data. Never overwrite an executing binary in place; install by versioned
   directory and atomically switch the manifest pointer after validation.
5. Run a readiness probe that checks the exact `--version`, platform/arch,
   approved `ffmpeg`/`ffprobe` paths, EJS availability, and JavaScript runtime.
   The current `2026.08.19` project pins `yt-dlp-ejs==0.8.0`; see its immutable
   [`pyproject.toml`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/pyproject.toml).
6. Pin `ffmpeg`, `ffprobe`, and the JavaScript runtime independently. Their
   licenses and builds differ. Do not accept an arbitrary same-named binary
   from the working directory or mutable `PATH`.

Upstream says `ffmpeg`/`ffprobe` and `yt-dlp-ejs` plus a supported JavaScript
runtime are highly recommended, with EJS required for full YouTube support. Its
[EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS) recommends Deno because
its code path runs with restricted permissions, while warning that Bun has no
permission restrictions and that older QuickJS creates temporary EJS files
with a theoretical TOCTOU risk. Bundle EJS with the official executable or pin
the matching package; do not silently fetch remote EJS components at runtime.

**Licensing decision:** yt-dlp's repository is Unlicense, but upstream explicitly
states that PyInstaller-bundled executables include GPLv3+ components and the
combined binary is GPLv3+; ffmpeg licensing depends on the build. Running a
separately installed executable does not by itself answer distribution,
source-offer, notice, or plugin-ecosystem questions. Maintainers must obtain a
license decision before Speech Kit redistributes either binary. Requiring a
user-managed installation avoids redistribution but weakens reproducibility and
increases PATH hijacking risk.

### Command and filesystem boundary

The adapter should spawn a fixed executable with an argument array and
`shell: false`. It should never concatenate a command string. Parse and
canonicalize the user's input first, then construct a fresh URL from a validated
video ID rather than forwarding arbitrary text.

A policy-owned argument baseline should include the equivalent of:

```text
--ignore-config
--no-config-locations
--no-cache-dir
--no-plugin-dirs
--no-remote-components
--no-cookies
--no-playlist
--no-mark-watched
--no-live-from-start
--use-extractors youtube
--format bestaudio
--paths <private-job-directory>
--output source.%(ext)s
--max-filesize <job-policy-limit>
--concurrent-fragments 1
--ffmpeg-location <approved-private-tools-directory>
-- <https://www.youtube.com/watch?v=VALID_ID>
```

The concrete implementation must pin more limits (duration, total bytes,
socket/extractor/fragment retries, rate, wall time, one concurrent job) and
must not expose arbitrary format selectors or extractor arguments to the user.
Set a private working directory and sanitized environment so user yt-dlp
configuration, `.netrc`, cookies, proxy variables, and plugin directories are
not inherited. Use the native downloader only. Do not enable `aria2c`, `curl`,
`--exec`, `--netrc-cmd`, postprocessor arguments, impersonation, geo-verification
proxies, XFF spoofing, file URLs, playlists, comments, thumbnails, archives,
or shortcut-file output.

yt-dlp documents `--ignore-config`, cache/plugin controls, playlist and
mark-watched controls, output templates, format selection, cookies, external
downloaders, and the fact that `--write-info-json` may contain personal
information. See the pinned
[`README`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md).
In particular, do not persist `info.json`: it can retain direct media URLs,
visitor/session data, and other fields. Print only an allowlisted metadata
record such as ID, canonical page URL, title, channel ID/name, duration,
timestamp, and selected codec/container. Never log signed media URLs, PO
tokens, cookies, OAuth tokens, or verbose headers.

### Temporary media lifecycle

Create a random per-job directory under the OS application-data temp area, not
inside the vault. Apply owner-only permissions (`0700` directory / `0600`
files where the OS supports it). Use fixed generated names; never interpolate
an untrusted title or uploader into a path. Retain `.part` files only inside
that directory.

Before decoding, require the result to be a regular, non-symlink file beneath
the job root and enforce byte, duration, stream-count, and codec limits with
the approved `ffprobe`. Decode from the lease into normalized 16 kHz mono PCM;
do not trust the extension. Delete media and partials in `finally`, on
cancellation, after the final transcript revision, and through a startup
sweep for abandoned jobs. Retaining downloaded media requires a separate
explicit setting and must never be the default. If a crash can leave files
behind, document that limitation and make cleanup best-effort across all
supported OSes.

### Audio-only selection

Select a best available audio-only stream (`bestaudio`/`ba`) and pass the
container/codec to the normal local decoder. This minimizes transfer and
preserves the source quality without an unnecessary lossy re-encode. Do not
invoke yt-dlp's audio extraction to MP3/WAV by default: Speech Kit's local
decoder can read supported source containers and can normalize to the pipeline
PCM format once. Any ffmpeg conversion must be explicit, bounded, performed by
an approved binary, and justified by a decoder capability gap.

For live content, v1 should reject it or use only a clearly labeled bounded
recording with a hard duration. `--live-from-start` is experimental and should
not be exposed.

### Metadata and provenance

The adapter should return a small provenance value, not upstream's full JSON:

- provider and adapter version;
- canonical YouTube video ID and public watch URL;
- title, channel ID/name, publication timestamp, duration, and declared audio
  language where available;
- access class: public guest, user-authorized, user-owned, or unknown;
- license metadata as an **upstream claim**, not legal clearance;
- selected container/codec and any DRM/paywall/region warning;
- acquisition time, whether temporary media was used, and the user consent ID.

This record feeds the note's source block and optional LLM context. It must be
visible to the user and distinguish Speech Kit's derived transcript from
YouTube-supplied metadata/captions. Do not cache API Data beyond the policy
window and do not calculate engagement metrics from it.

### Subtitle fallback and comparison

A caption track is a sidecar, not ground truth. Parse it as text into the
existing timestamped segment model. WebVTT is the W3C format for time-aligned
text tracks, and its cues associate text with start/end intervals; the current
W3C Candidate Recommendation is
[WebVTT, 20 May 2026](https://www.w3.org/TR/2026/CRD-webvtt1-20260520/).
Strip styling/markup into plain transcript text, retain the original cue times,
and never render remote WebVTT content as active HTML.

Track provenance must include:

- `standard` versus `ASR`, `forced`, translated, or unknown;
- language and audio-track type;
- original versus auto-synchronized timing;
- official API, yt-dlp, or user-supplied origin;
- caption track ID only when policy permits retaining it.

Fallback policy:

1. If authorized official captions exist, offer **Use captions** as a fast,
   caption-only path. It cannot run VAD, local ASR, or diarization, and the UI
   must say so.
2. If local audio acquisition succeeds, run the normal local file pipeline.
   Keep a caption track as a comparison sidecar when available.
3. Never silently substitute ASR captions for audio or splice caption and ASR
   text. Present a language-aware normalized-token diff and timing comparison;
   let the user choose captions, local ASR, or edit a reviewed merge.
4. If caption parsing, timing sanity, or media decoding fails, fall back to the
   other complete path—not to a partially trusted merge.
5. When yt-dlp supplies subtitles, label them **unofficial helper captions**,
   not YouTube API captions. Subtitle requests can themselves require PO
   tokens, and the upstream issue tracker records current 429 failures.

### Cookies, authentication, and privacy

Default to guest access and no cookies. Never call
`--cookies-from-browser` in v1. yt-dlp's FAQ warns that exporting browser
cookies to a file can export cookies for **all sites**, even when a single URL
is supplied. Reading a normal browser profile also creates OS keychain/DPAPI
permissions, browser-lock, decryption, and account-isolation problems.

If maintainers later approve authenticated private/age/member content, it needs
a separate threat model and explicit user action:

- never request a YouTube password;
- do not scrape the watch page or undocumented login endpoints;
- prefer an official OAuth path for managed videos;
- for an unofficial helper, consider only a user-supplied, YouTube-scoped
  cookie file in a private `0600` location, with session-only lifetime,
  immediate deletion, no diagnostics containing its path, and a warning about
  account bans/invalidation;
- never read all sites from a browser profile or persist netrc data;
- never use cookies to cross region, age, paywall, membership, DRM, or
  private-content boundaries beyond the user's lawful access;
- offer immediate revoke/forget controls and delete the cookie file, temp
  media, metadata, and caption cache.

The official API policies separately prohibit collecting or storing YouTube
login credentials, and the yt-dlp maintainers warn that using an account can
lead to bans. These are strong reasons to keep authentication out of the
helper's first release.

### Sandbox and process security

yt-dlp is an executable that downloads and parses attacker-influenced site
metadata, invokes JavaScript challenges, and can call ffmpeg and other helper
programs. Run it with least privilege:

- fixed absolute paths and a sanitized environment;
- no shell and no inherited user configuration/plugins;
- OS sandbox/container where feasible: non-admin user, no vault access, private
  temp/home/cache, restricted filesystem, process/job limits, and egress
  controls;
- HTTPS-only network policy with a maintainer-reviewed YouTube/Google media
  host allowlist and redirect review; reject file/local/magnet inputs;
- one job at a time, byte/rate/time/duration caps, and hard cancellation that
  kills the process tree;
- a minimal Deno permission profile for EJS; never enable Bun's unrestricted
  mode;
- no external downloaders or arbitrary postprocessors;
- bounded stderr, redacted diagnostics, and no default `-vU` output;
- startup version/hash/tool checks and an emergency disable switch.

This is not hypothetical. yt-dlp's official security page lists recent high
severity issues involving shortcut-file command execution, aria2c manifest
option injection, and dangerous file creation, plus a cookie leak through
`curl`. The current stable includes the June/July 2026 fixes, but the adapter's
allowlist remains necessary. See the official
[security advisories](https://github.com/yt-dlp/yt-dlp/security),
[GHSA-6v4j-43gg-vj32](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-6v4j-43gg-vj32),
[GHSA-vx4q-3cr2-7cg2](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-vx4q-3cr2-7cg2),
[GHSA-f7j3-774f-rfhj](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-f7j3-774f-rfhj),
and [GHSA-c6mh-fpjc-4pr3](https://github.com/yt-dlp/yt-dlp/security/advisories/GHSA-c6mh-fpjc-4pr3).

### Update and maintenance policy

Do not call `yt-dlp -U` during a user job. A Speech Kit release should pin the
entire tested tuple:

- yt-dlp tag and commit;
- per-platform executable SHA-256;
- yt-dlp-ejs version;
- ffmpeg/ffprobe build and digest;
- JavaScript runtime version and digest;
- adapter policy/argument schema version.

Monitor upstream releases, the security page, and the known-issues index. Test
a pinned release against maintainer-owned short fixtures covering ordinary,
CC BY, manual captions, ASR captions, Shorts, unavailable, private, age,
region-blocked, members-only, purchase-required, and DRM cases. Do not copy
third-party fixtures. Stage updates first in CI/canary, then release them with
Speech Kit. An upstream emergency security update should disable the helper
immediately if a tested fixed build is not yet available.

This is ongoing product maintenance, not a one-time integration. The helper
requires a named owner, release monitoring, security response, platform binary
updates, policy review, and an end-of-life plan. If Speech Kit cannot fund
that, it should omit the helper.

## Provider-neutral acquisition design

Keep URL parsing, authorization, network retrieval, file lifetime, and
provenance behind a small module. The transcription pipeline must not know
whether bytes came from a file chooser, an approved future provider, or yt-dlp.

### Core `MediaSource` contract

The important invariant is: **a successful `MediaSource` returns a short-lived
local media file lease, never provider URLs, response bodies, or credentials.**

```ts
type SourceRef =
  | { kind: 'local_file'; fileToken: string }
  | { kind: 'youtube_video_id'; videoId: string };

type MediaSourceId = 'local_file' | 'youtube_yt_dlp' | (string & {});

type RightsEvidence =
  | { kind: 'user_supplied_file' }
  | { kind: 'official_user_owned_export' }
  | { kind: 'platform_permission'; permissionId: string }
  | { kind: 'declared_license'; license: string; evidence: string }
  | { kind: 'maintainer_approved_eligibility'; policyVersion: string };

interface MediaPlan {
  sourceId: MediaSourceId;
  displayName: string;
  canonicalUrl?: string;
  durationMs?: number;
  estimatedBytes?: number;
  access: 'local' | 'public_guest' | 'authenticated' | 'unknown';
  restrictions: readonly string[];
  warnings: readonly string[];
  requiresConsent: boolean;
}

interface MediaProvenance {
  sourceId: MediaSourceId;
  adapterVersion: string;
  acquiredAt: string;
  sourceRef: SourceRef;
  canonicalUrl?: string;
  title?: string;
  channel?: { id?: string; name?: string };
  durationMs?: number;
  language?: string;
  container?: string;
  codec?: string;
  licenseClaim?: string;
  rights: RightsEvidence;
  temporaryMedia: boolean;
}

interface LocalMediaLease {
  readonly mediaId: string;
  readonly provenance: MediaProvenance;
  openReadStream(): Promise<Readable>;
  release(): Promise<void>;
}

type AcquisitionEvent =
  | { type: 'plan'; plan: MediaPlan }
  | { type: 'progress'; bytes?: number; totalBytes?: number; phase: string }
  | { type: 'ready'; lease: LocalMediaLease }
  | { type: 'warning'; code: string; message: string };

type AcquisitionFailureCode =
  | 'invalid_or_unsupported_url'
  | 'not_found_or_private'
  | 'region_restricted'
  | 'age_restricted'
  | 'membership_required'
  | 'purchase_required'
  | 'drm_protected'
  | 'authentication_required'
  | 'rate_limited'
  | 'extractor_changed'
  | 'rights_not_established'
  | 'tool_unavailable'
  | 'resource_limit'
  | 'cancelled';

interface AcquireRequest {
  ref: SourceRef;
  consentId: string;
  rights: RightsEvidence;
  maxDurationMs: number;
  maxBytes: number;
  signal: AbortSignal;
}

interface MediaSource {
  readonly id: MediaSourceId;
  readonly adapterVersion: string;
  inspect(ref: SourceRef, signal: AbortSignal): Promise<MediaPlan>;
  acquire(request: AcquireRequest): AsyncIterable<AcquisitionEvent>;
}
```

`openReadStream()` can initially resolve to the local path inside the trusted
media runtime while that path remains opaque to UI and model code. Releasing
the lease must be idempotent. The orchestrator must release it in `finally`,
including after decode, ASR, comparison, cancellation, and failed LLM stages.
Do not expose a provider `release()` to the renderer or LLM.

### Separate authorized transcript sidecars

Captions are not media, so they should not pretend to satisfy `MediaSource`:

```ts
interface TranscriptAssetSource {
  readonly id: 'youtube_official_captions' | 'youtube_helper_captions' | 'local_vtt';
  list(ref: SourceRef, signal: AbortSignal): Promise<TranscriptTrack[]>;
  acquire(
    track: TranscriptTrack,
    consentId: string,
    signal: AbortSignal,
  ): Promise<TranscriptAssetLease>;
}
```

`TranscriptTrack` carries origin, track kind, language, audio-track type,
sync status, and duration bounds. `TranscriptAssetLease` has the same release
semantics. A transcript-only job may use smart formatting and optional LLM,
but must be labeled **Caption import** and must not claim VAD, local-ASR, or
diarization provenance.

### Unified file pipeline

For every successful media lease:

1. The file-source job opens the lease and decodes locally to the existing
   16 kHz mono PCM representation, preserving an absolute media time base and
   honoring codec delay/container timestamps.
2. VAD produces speech regions; file end flushes the final region. The
   orchestrator uses a high-quality batch ASR family, not a live dictation
   model, and keeps all timestamps relative to media start.
3. ASR segment timestamps, optional diarization, and caption cue times enter
   one timestamp model. Do not use caption boundaries as ASR ground truth.
4. Existing smart/space/new-line/paragraph formatting, timestamp density,
   speaker labels, note insertion, and optional LLM stages run unchanged.
5. The note records source/provenance. The LLM continues to receive text—not
   media—and only when the user has explicitly enabled that provider.

This gives local files, future approved providers, and the optional helper the
same local decode → VAD → high-quality batch ASR → timestamps/diarization →
smart formatting → optional LLM path. The provider only chooses the temporary
input file and sidecars.

## Recommended staged UX

### Stage 0: local media (ship first)

Offer **Transcribe media file** as the default. It works with a file the user
owns or is authorized to use, needs no YouTube integration, and proves the
file pipeline, resource cleanup, timestamps, diarization, formatting, and
progress UX.

For a YouTube upload the user owns, add guidance rather than a downloader:
“Download an MP4 from YouTube Studio or Takeout, then choose it here.” Preserve
the source URL/title in the note as user-entered metadata if desired.

### Stage 1: authorized YouTube captions (separate decision)

Only after API/legal/privacy approval, add **Import captions from my YouTube
videos**. The user explicitly connects an account, sees the broad scope and
storage/deletion terms, selects a video they can edit, chooses a standard/ASR/
forced/language track, previews cue timing, and imports the caption-only
transcript.

This must be a distinct, clearly YouTube-branded action. It must never become a
generic public transcript endpoint. Add Connect, Disconnect, Forget stored
data, and Google-permission revocation. Implement token revocation and the
policy deletion windows before release.

### Stage 2: optional yt-dlp helper (experimental and off by default)

Do not put “Paste any YouTube URL” in the stable command palette. If legal and
maintainer review approves an initial scope, expose **Advanced: import permitted
YouTube audio** with all of the following:

- explicit explanation that the helper is unofficial, contacts YouTube using
  yt-dlp, and may stop working;
- a maintained eligibility/rights gate and a copy of the applicable terms;
- explicit per-job consent to network transfer and temporary local storage;
- no guest bypass for private, member, age, purchase, region, or DRM content;
- a preflight showing video ID/title/channel/duration and requested access;
- pinned tool versions and visible helper health;
- no cookies in the first version;
- fixed audio-only extraction into a private temporary directory;
- cancellation, byte/time limits, and guaranteed best-effort cleanup;
- provenance and helper version in the output;
- a visible experimental badge and easy removal of helper data.

Eligible categories require maintainer/legal definition. “Public,” “CC BY,” or
a user checkbox is not automatically sufficient: CC addresses the work license,
while YouTube platform/API/download terms remain separate. The safest initial
scope, if approved at all, is user-owned/public-domain/CC-BY or explicitly
licensed creator media for which the user can document rights. The product
should not attempt region, paywall, DRM, membership, age, anti-bot, or
SABR/PO-token circumvention.

### Stage 3: official player plus user-controlled capture (optional)

A future “play and capture system audio” UX can use the official IFrame player
and existing system-audio capture. It remains a user-visible, real-time
playback/session feature, not URL-based file acquisition. It must obey player
branding, identity, visibility/autoplay, age/embed, and privacy policies. The
UI should call it **Record while playing**, not **Download**.

## Decisions required before implementation

### Legal/platform approval

- Obtain counsel review in each target jurisdiction; do not treat this report
  as clearance.
- Decide whether Speech Kit will seek YouTube's prior written approval for any
  API-Client audiovisual caching/download workflow.
- Define eligible content, jurisdictions, personal-use/commercial boundaries,
  and whether a transformed note can be retained/shared.
- Decide whether CC BY/public-domain/own-content evidence is sufficient for
  the optional helper, recognizing that it does not override YouTube's own
  platform permissions.
- Prohibit circumvention features and proxy/header spoofing by policy and test.
- Decide whether the official caption connector's Authorized Data may be
  formatted, compared to ASR, summarized by an LLM, and retained in notes under
  the broad API Data/derived-data language.

### Product and maintainer ownership

- Is an unofficial helper worth ongoing YouTube breakage, security response,
  per-platform binary releases, and policy monitoring? Assign an owner and
  service-level policy or do not ship it.
- Define support for live streams, Shorts, very long media, playlists, and
  simultaneous jobs. v1 should be single-video, on-demand VOD only.
- Choose strict duration/size/rate/concurrency limits from benchmarked hardware
  and disk budgets.
- Choose whether downloaded media is always temporary or may be explicitly
  retained, and how crash cleanup is verified on every OS.
- Decide whether helper subtitle tracks are supported in the first release or
  only after caption provenance/comparison UX is complete.
- Decide whether a failed helper attempt may ever retry with cookies, PO
  tokens, another client, or a proxy. Recommended answer: no automatic retry.

### Security, packaging, and privacy

- Approve or reject redistribution of the GPLv3+ PyInstaller yt-dlp binary;
  approve exact ffmpeg/ffprobe builds and notices.
- Choose managed binaries versus a user-installed helper after evaluating PATH
  trust, setup burden, and update control.
- Define the pinned GPG-key rotation process and whether signatures are
  mandatory on every platform.
- Specify OS sandbox/egress capabilities. If a meaningful sandbox or private
  process boundary cannot be implemented on a supported platform, do not enable
  the helper there.
- Prohibit third-party plugins and remote EJS components by default. If a PO
  Token provider is ever allowed, treat it as a separately installed,
  separately consented, separately pinned executable/plugin with its own legal
  and security review.
- Minimize telemetry: local job state and versions only; never source URLs,
  media metadata, caption text, cookies, tokens, signed URLs, or user notes.
- Require a privacy-policy update, YouTube Terms link, consent record, deletion
  path, and Google OAuth verification/review where applicable.

## Final recommendation

1. **Ship local-file transcription first** and prove the shared long-form media
   pipeline.
2. **For own YouTube videos, use the official Studio/Takeout export and local
   import.** This is the clearest safe acquisition path.
3. **Treat official caption download as a separate authorized transcript
   connector**, not as media acquisition. It is viable only for videos the user
   can edit and only after API-policy/privacy implementation is complete.
4. **Do not claim that an arbitrary public URL can be acquired through an
   official API.** No documented official endpoint supports that claim.
5. **Evaluate yt-dlp only as an optional, isolated, pinned, audio-only helper.**
   It is technically useful but unofficial, legally sensitive, operationally
   fragile, and not a core dependency. Do not ship it as “paste any public URL.”
6. **Fail closed for DRM, purchase, membership, private, age, and region
   boundaries.** Never use proxies, spoofed headers, alternative clients, or
   token plugins to defeat them.
7. **Keep acquisition behind `MediaSource` + `TranscriptAssetSource`.** Every
   approved media adapter returns a temporary local file lease, so all local
   decoding, VAD, high-quality batch ASR, timestamps/diarization, formatting,
   and optional LLM behavior stays provider-neutral.

## Primary sources

### YouTube official API, policy, and help

- [YouTube API Services Terms of Service](https://developers.google.com/youtube/terms/api-services-terms-of-service)
- [YouTube API Developer Policies](https://developers.google.com/youtube/terms/developer-policies)
- [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality)
- [API Terms revision history](https://developers.google.com/youtube/terms/revision-history)
- [YouTube Terms of Service](https://www.youtube.com/t/terms)
- [YouTube Paid Service Usage Rules](https://www.youtube.com/t/usage_paycontent)
- [`videos.list`](https://developers.google.com/youtube/v3/docs/videos/list) and
  [`video` resource](https://developers.google.com/youtube/v3/docs/videos)
- [`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list),
  [`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download),
  and [`caption` resource](https://developers.google.com/youtube/v3/docs/captions)
- [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
  and [player parameters](https://developers.google.com/youtube/player_parameters)
- [OAuth 2.0 overview](https://developers.google.com/youtube/v3/guides/authentication)
  and [web-server OAuth scopes](https://developers.google.com/youtube/v3/guides/auth/server-side-web-apps)
- [Download your own uploaded videos](https://support.google.com/youtube/answer/56100?hl=en)
- [Premium offline videos](https://support.google.com/youtube/answer/11977233?hl=en)
- [Purchased-content offline viewing](https://support.google.com/youtube/answer/10005180?hl=en)
- [Public transcript UI](https://support.google.com/youtube/answer/15930243?hl=en)
- [Automatic-caption limitations](https://support.google.com/youtube/answer/6373554?hl=en)
- [Region restrictions](https://support.google.com/youtube/answer/92571?hl=en)
- [Age-restricted playback](https://support.google.com/youtube/answer/10070779?hl=en)
- [Private-video access](https://support.google.com/youtube/answer/77272?hl=en)
- [Members-only music](https://support.google.com/youtube/answer/9177241?hl=en)
- [Embed restrictions](https://support.google.com/youtube/answer/171780?hl=en)
- [Creative Commons licenses](https://support.google.com/youtube/answer/2797468?hl=en)
  and [copyright/fair use](https://support.google.com/youtube/answer/2797466?hl=en)

### yt-dlp official repository and project documentation

- [yt-dlp `2026.08.19` release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)
- [Pinned README](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md)
  and [`pyproject.toml`](https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/pyproject.toml)
- [Installation guide](https://github.com/yt-dlp/yt-dlp/wiki/Installation)
- [EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS)
- [YouTube extractor guidance](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#youtube)
- [PO Token guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
- [Known issues](https://github.com/yt-dlp/yt-dlp/issues/3766)
- [SABR-only formats issue](https://github.com/yt-dlp/yt-dlp/issues/12482)
- [TV-client DRM issue](https://github.com/yt-dlp/yt-dlp/issues/12563)
- [FAQ: cookies](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)
- [Official security advisories](https://github.com/yt-dlp/yt-dlp/security)

### Standard

- [W3C WebVTT Candidate Recommendation Draft, 2026-05-20](https://www.w3.org/TR/2026/CRD-webvtt1-20260520/)
