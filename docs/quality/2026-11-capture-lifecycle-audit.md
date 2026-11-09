# Capture lifecycle audit — 2026-11-08

## Findings

- **High: stale microphone startup could stop a later session.** A pending permission request had no capture owner. Stop returned without cancelling it. A later start could claim capture, then the old start could replace its resources and the controller could stop the replacement. A real controller and capture regression test reproduces the listening state with no active capture on the original code.
- **High: setup could retain the microphone after stop.** A pending worklet installation held a stream outside capture teardown. A pending recording startup also delayed track release. Stop now releases acquired tracks without waiting for either operation.
- **Medium: recording startup failure left stale capture state.** The error path stopped the track but retained the track listener and capture fields. Cleanup now uses the normal teardown path and discards the incomplete recording.
- **Medium: a cancelled device request could retry.** A late device constraint error could start a default-device request after stop. The request now checks its owner before retrying.

## Lifecycle and ownership

The controller owns session creation, sidecar commands, UI state, transcript draining, and recording placement. Capture owns its pending microphone request, stream, audio graph, recording, and track-end listener. The recording owns its writer and saved file. The sidecar owns inference and system-audio capture.

| Stage                 | Entry and exit                                                   | Resource rule                                                                                                        |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Idle                  | No active capture owner                                          | No capture graph or microphone track is owned.                                                                       |
| Requesting            | Start begins; permission resolves or fails                       | Stop invalidates the owner immediately. A late stream is stopped. A cancelled request cannot retry.                  |
| Setting up            | Stream is acquired; worklet, graph, and optional recording start | Acquired resources belong to the current owner. Stop releases the stream and graph even if setup is pending.         |
| Capturing             | Setup completes                                                  | Only the current session accepts frames and track-end events.                                                        |
| Stopping              | Stop invalidates the owner and detaches capture resources        | Recording finalization can continue while another session starts. Old setup must not change or stop the new capture. |
| Draining or cancelled | Controller stops or cancels the sidecar session                  | Transcript and recording placement remain with the original session until disposal.                                  |
| Failed                | Any startup stage fails                                          | The owning capture releases its resources; stale failures do not affect a newer session.                             |

A focused ownership change is sufficient here. The capture interface already owns the complete microphone operation; tracking the pending owner and registering acquired resources closes the identified gaps. A wider state-machine rewrite would add coordination without addressing additional demonstrated failures.

The tests use simulated browser media and recording objects. Follow-up native Obsidian checks passed for one-sentence completion, the ten-second timeout, and saved-recording finalization. Microphone-permission prompts, device removal, and adversarial rapid stop/restart remain separate native checks. A recording finalization or sidecar operation that never settles can still delay that session's drain; this audit did not establish the cause or frequency of such a hang.
