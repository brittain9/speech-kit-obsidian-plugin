---
status: approved
---

# Local audio-file transcription v2

## Goal

Add a local **Transcribe audio file** command that lets a user choose one audio
file, transcribe it without microphone capture, and insert the completed local
transcript into the Markdown note that was active when the command began.

The workflow is local-only. The selected file bytes and decoded PCM are read by
the plugin renderer and sent only to the local Rust sidecar over its framed
stdin pipe. No audio-file path, encoded audio, or decoded audio is sent to an
LLM, translation provider, telemetry service, or any network endpoint.

## Supported input

The command uses a local browser file input with `accept="audio/*"`. The
authoritative format contract is therefore:

> Speech Kit accepts an audio file only when the AudioContext implementation in
> the running Obsidian desktop runtime can decode that file's actual container
> and codec.

The plugin does not infer support from an extension and does not promise a
static codec matrix. WAV, MP3, M4A/AAC, Ogg/Opus, FLAC, and WebM are expected
only to the extent that the active Obsidian/Electron Web Audio implementation
decodes them. A decode failure is reported as an actionable local error that
asks the user to convert the file to a format their Obsidian runtime can
decode. Tests use generated WAV data to exercise the complete source and frame
path independently of platform codec availability.

The feature is desktop-only because its local speech engine is a native sidecar.
It does not use a remote file URL or `fetch`; only the `File` selected by the
user is read.

## Memory and duration contract

`decodeAudioData` decodes the complete input in memory. Speech Kit therefore
makes no support claim for files outside this conservative budget:

| Limit | Value | Enforcement point |
|---|---:|---|
| Encoded file size | 64 MiB | Before reading, using `File.size` |
| Decoded PCM | 192 MiB | Immediately after decode, calculated as `channels × frames × 4` |
| Decoded duration | 30 minutes | Immediately after decode, using `AudioBuffer.sampleRate` and `length` |
| Model duration | Model's declared `maxAudioDurationSecs`, when present | Immediately after decode and before session start |

The decoded-memory calculation uses the logical `AudioBuffer.length`, not the
possibly larger allocation behind a channel view. Exceeding a limit rejects the
file and overwrites decoded channel data. The plugin does not create a second
whole-file mono buffer: it processes bounded channel slices, mixes a bounded
slice to mono, resamples it, and emits fixed 16 kHz mono PCM16 frames.

These are product guardrails, not estimates of every platform's decoder memory
overhead. Web Audio may temporarily consume additional memory while decoding.
The low caps are intentional: renderer stability takes precedence over accepting
arbitrarily long recordings.

## Vertical seam

The approved seam is:

```text
local File selection
  -> preflight snapshot (target + model + language + speech lease)
  -> abortable encoded read
  -> abortable Web Audio decode and budget validation
  -> preflight revalidation after selection/decode
  -> local speech session start
  -> bounded channel mix/resample
  -> backpressure-aware 640-byte sidecar writes
  -> graceful session stop and transcript drain
  -> one atomic editor insertion path through Session
  -> session disposal and lease release
```

Normal microphone dictation continues to use `AudioCaptureStream` and its
existing real-time worklet path. File audio uses a separate source and does not
change microphone frames, resampling, or capture settings.

## Start and ownership rules

1. The command synchronously marks a new file workflow busy so a concurrent
   dictation or read-aloud start cannot slip past arbitration.
2. Before opening the picker, the workflow validates:
   - an active/fallback Markdown editor target;
   - an available validated speech-to-text model;
   - a non-streaming (batch) model family;
   - support for the configured dictation language;
   - no active microphone/file capture; and
   - availability of the current sidecar lifecycle speech lease.
3. The target is captured as an exact `(file, CodeMirror view, target kind)`
   token. Merely finding another Markdown note later is not sufficient.
4. The speech lease is retained while the pending start unwinds. The pending
   start owns an `AbortController`; cancellation aborts picker/read/decode work
   and cannot release the underlying lease early.
5. After selection, model selection and capabilities are revalidated. The
   model/language is resolved again rather than trusting a snapshot taken while
   a modal was open.
6. Read aloud is stopped before the local file session starts. A failure to stop
   it aborts the workflow without starting another speech workload.
7. The target and model are checked again after decode and immediately before
   `start_session`. A changed target or model rejects the stale workflow.
8. The file workflow and microphone dictation are mutually active. Read aloud
   also treats either microphone or file capture as conflicting speech input.
9. Existing sidecar lifecycle behavior remains unchanged: speech sessions may
   drain together, while mutations (restart/removal) wait until native speech
   work is finished.

Opening the file picker and reading audio do not start a sidecar session, but
they remain inside the retained speech lease so a cancelled asynchronous start
cannot overlap a sidecar mutation.

## Cancellation

One signal is threaded through the whole local path:

- the picker removes its temporary input and rejects as cancelled;
- an abort-aware file reader cancels its `ReadableStream` reader;
- the decoder wrapper races pending read/decode work against the signal and
  always closes its `AudioContext`;
- frame production checks the signal between bounded channel chunks and frames;
- the bounded sidecar write rejects while waiting for stream drain; and
- the active session is cancelled rather than gracefully stopped when the user,
  plugin disposal, a terminal target failure, or an overload aborts the source.

Cancellation is silent when initiated by disposal/user intent. A race that wins
after a real terminal failure does not replace the first actionable notice.

## Frame flow and backpressure

Decoded channels are consumed in bounded slices. `PcmFrameProcessor` performs
the same linear resampling and PCM16 quantization used by microphone capture.
Each output is exactly:

- 16,000 Hz;
- mono;
- signed 16-bit PCM;
- 20 ms / 320 samples / 640 bytes per frame.

The pump awaits each sidecar write. `SidecarConnection` exposes a dedicated
bounded audio write that waits for Node stdin drain when the writable buffer is
full; it accepts an `AbortSignal` so cancellation never leaves an unbounded
plugin-side frame queue.

Sidecar queue tiers add session-level flow control:

- `normal` permits the next frame;
- `catching_up` continues while writes remain bounded;
- `falling_behind` and `saturated` pause before the next frame; and
- `utterance_queue_overload` aborts the source immediately.

A backpressure pause has a finite deadline. If the queue does not return to
`normal`, the source is aborted and the session is cancelled rather than waiting
forever. Graceful stop is requested after all accepted frames are written. If
the sidecar fails to acknowledge stop before the configured command timeout,
cancellation is attempted and local resources are still released.

## Session and editor completion

The file workflow creates a normal `Session` from the captured target, so it
uses the same atomic projection, external-edit detection, note close/delete
callbacks, formatting, timestamps, and cleanup guarantees as dictation. Partial
revisions are projected if a model emits them; final revisions complete their
tracked span. The sidecar's `session_stopped` event is the authoritative end of
the audio stream.

On normal completion the pump sends every accepted frame, requests a graceful
stop, waits for admitted transcript work, and disposes the editor session. A
single complete `transcript_ready` therefore produces one insertion through
`Session.acceptTranscript`; multiple phrase revisions use the normal tracked
span behavior.

The file workflow does not run LLM text cleanup. This keeps the feature focused
on a complete raw local transcript and avoids sending file-derived text to an
optional provider merely because file transcription was invoked. Existing
microphone LLM behavior is unchanged.

## Failure handling

All feature-owned failures have localized, actionable copy:

| Failure | User guidance |
|---|---|
| Missing/unvalidated model | Open the model manager and select a speech-to-text model |
| Streaming-only model | Select a batch model for file transcription |
| Language mismatch | Choose a model that supports the configured dictation language |
| Missing/stale target | Return to the original open Markdown editor and run the command again |
| Read failure | Check file access and retry |
| Decode failure | Convert to a locally decodable format and retry |
| Encoded size/memory/duration | Choose a shorter/lower-bitrate file or split it externally |
| Sidecar start/runtime failure | Check the local speech engine/model and retry |
| Queue overload/backpressure timeout | Split the recording or choose a faster model, then retry |
| Target close/edit desync | Open/restore the intended note and run the command again |

A file picker cancellation is a normal no-op. Every `AudioContext` created by
the decoder is closed on success, decode failure, read cancellation before
context creation, and cancellation while decode is pending.

## Verification

Automated coverage must include:

- generated WAV bytes through decode, channel mixing, real resampling, and fixed
  frame output;
- fake-decoder cancellation before read, after read, and while decode is pending;
- encoded-size, decoded-duration, decoded-memory, and model-duration rejection;
- bounded sidecar write and source abort on overload;
- speech lifecycle lease acquisition, retention, release, and conflict;
- pending-start cancellation and stale target/model rejection;
- configured language and selected batch-model payload;
- microphone capture regression; and
- one complete transcript insertion followed by session disposal.

Focused tests, TypeScript type checks, both lint stacks, Obsidian floor type
checks, and the frontend production build are required before merge.
