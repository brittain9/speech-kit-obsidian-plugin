# Extended maintenance validation — November 2026

## Native workflow checks

Test environment: Apple M2 Pro, 16 GiB RAM, macOS 27.2, Obsidian 1.15.0. Only the designated test vault was used. The initial native build is recorded in [the first maintenance brief](maintenance-2026-11-08.md).

| Check                                                              | Observed result                                                                                                   | Limit                                                                                                                        |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Cancel during dictation startup, then start and stop again         | Capture returned to idle and a later session reached listening.                                                   | This does not simulate an unresolved operating-system permission prompt; deterministic regression tests cover that ordering. |
| Read aloud, pause, resume, stop, then restart                      | Toolbar showed the expected states; playback completed and the toolbar disappeared.                               | Pocket TTS English with Alba only in this pass.                                                                              |
| Translate while read aloud is running, then cancel translation     | Translation showed its local processing state, cancellation was explicit, and read aloud continued to completion. | HY-MT 2 1.8B Q4_K_M, English to Spanish; no translation inserted.                                                            |
| Preserve source note through playback and translation cancellation | Saved note matched the complete expected 216-byte public test passage.                                            | This is one bounded workflow, not a claim about every concurrency sequence.                                                  |

## Stopped-process baseline

A 30.29-second sample used seven process snapshots at five-second intervals. Capture, playback, and translation were stopped. The test note and provider sidebar remained open. Other development work ran on the same machine, so these results are descriptive process observations.

| Process                           | CPU time gained | Average CPU, one core = 100% | Final resident memory |
| --------------------------------- | --------------- | ---------------------------- | --------------------- |
| Test-vault sidecar                | 0.14 s          | 0.46%                        | 94.73 MiB             |
| Obsidian and its helpers combined | 0.04 s          | 0.13%                        | 381.1 MiB             |

The sidecar's resident memory was 94.75 MiB at the start and 94.73 MiB at the end. The renderer accumulated no measurable CPU time at the snapshot precision. This short sample does not establish a leak, a long-session memory ceiling, energy consumption, or a battery-life improvement. It gives no evidence of a persistent high-CPU idle loop in this configuration.

An earlier exploratory sample included changing process residency and was not used as the stable baseline. Raw observations stay local; they contain process identifiers and are not required to reproduce the method.

## Repeat the baseline

1. Stop dictation, read aloud, translation, and media transcription.
2. Keep the same note, sidebar state, installed build, and loaded model history.
3. Record CPU time and resident memory for Obsidian, its helpers, and the child sidecar over a fixed interval. Calculate CPU-time differences, rather than using process-lifetime CPU percentages.
4. Compare matched runs before drawing a performance conclusion. Use dedicated power measurements for an energy or battery claim.

## Capture fix native check

Installed the frontend built from `5b97ee0` into the test vault. Enabled microphone recording with system audio off, started capture, stopped and immediately restarted it, then cancelled the second session. The first session produced one native recording player. The cancelled replacement produced no extra embed. The player entered playback and advanced to 0:03 before it was paused. The Opus file reports 48 kHz mono audio. Both source-note boundary markers remained present exactly once.

The browser MediaRecorder output does not contain a fixed format-duration field in the streaming WebM header. Native playback progress, rather than that absent metadata field, established playback. No recording or note content from this microphone test is included in the repository.

The saved settings confirm microphone recording and system audio are off after this check. Deferred permission responses, failing AudioContext teardown, recording writer delay, and stale startup errors were checked with public-interface regression tests; these browser-failure cases were not forced in native Obsidian.

## Sustained read-aloud check

A 396-word public test note completed reading with Pocket TTS English and Alba. Changing speed from 1× to 1.25× restarted from the current passage and continued to completion. A subsequent reading started successfully. Speed was restored to 1×, playback was stopped, and the saved 2,509-byte source matched the original test passage exactly.

During a 45.44-second active sample, the sidecar accumulated 21.16 CPU-seconds, averaging 46.6% of one core. Sampled resident memory rose from 513.0 to 514.6 MiB, with a 514.6 MiB sampled peak. During a later 30.29-second stopped sample, it accumulated 0.11 CPU-seconds, averaging 0.36% of one core. Resident memory remained about 515 MiB. The loaded model stayed resident; this test does not establish that all allocations were released, nor does it measure a long-session memory ceiling.

This bounded reading check and the stopped CPU sample passed. They do not establish an energy improvement, universal leak freedom, or behavior on other hardware and voices.

## Corrected Tiny live editing

The corrected seven-file Tiny bundle passed the native external-file validation using the Moonshine loader. With that selection, a slowed public JFK fixture played through QuickTime and system capture while a marker was typed and a public example URL was pasted into the note. Live partials continued, and stopping drained the final speech. The saved note retained both original boundary markers, the typed marker and the URL exactly once. It contained no zero-width-space characters; accessibility text from live editor widgets was not treated as saved note content.

This check establishes that the corrected model works through native live dictation and preserves concurrent editing. It is not an accuracy benchmark: playback was slowed and mixed with the microphone. The controlled public-fixture comparison is recorded separately in the Tiny validation report. No microphone transcript or recording from this check is published. Capture, microphone recording and system audio were off afterward. A later managed Reinstall check completed successfully; see the model replacement section below.

## Combined lifecycle build

The isolated integration build combines the native TLS lockfile patch, corrected Tiny catalog, capture fixes, translation startup cancellation and use-lease changes, read-aloud startup cleanup, and ASR model-release barrier. A strict clean install under Node 24.22.2/npm 11.19.1 reported zero npm vulnerabilities. Both typechecks, both linters, 1,780 frontend tests (10 skipped), the Metal sidecar build, and build-output verification passed.

After stopping the test-vault plugin and confirming its child had exited, the frontend and sidecars were installed. SHA-256 checks confirmed that the installed frontend and native executable matched the build. The native executable hash is `c7f96bb3438ebd1b1c9c92926e09fcdc69b6a047ff0857a680ba91fca8bcf8a0`.

HY-MT translated the 396-word public passage, cancelled an immediately restarted translation, and completed a subsequent translation. Closing the preview during processing left visible background progress. Restart was correctly refused at block 4 of 12. Once translation completed, restart succeeded and the child process changed; the health command confirmed readiness. The original source stayed byte-for-byte unchanged. An inaccurate maintenance-only busy notice found during this check was changed to generic engine-busy wording; verification of the revised wording belongs to the final UI pass.

Pocket TTS on this combined build started, paused, and stopped normally. AudioContext construction failure remains a deterministic controller test rather than an injected native failure. These checks do not replace the final Reinstall UI and final-main verification.

## Idle translation helper

A fresh short public note completed HY-MT translation. After dismissal, the helper remained resident at 1,125.5 MiB. No new translation or application restart occurred during the observation. At a later sample 332.7 seconds after the first process snapshot, the helper was gone and the same parent sidecar remained running at 21.3 MiB. This confirms normal idle helper shutdown in this configuration. It is not a direct power measurement or a new performance improvement.

## Translation preview source and reviewed text

Two test notes contained identical public text. A translation from the first note was manually reviewed, closed with Escape, then reopened after its editor view moved to the second note. The preview retained the edited draft, displayed its original source path, and offered only Copy and Dismiss. Apply and retry were unavailable for the other file.

Returning to the original source and renaming it in Obsidian retained the draft. The preview showed the renamed path and allowed application. Replace wrote the reviewed draft only to the renamed source; the second note kept its exact original bytes. This native check confirms Obsidian's TFile identity behavior across this rename.

The revised generic engine-busy notice was observed while a background translation prevented restart. A temporary input timing error added one character to the public long test note; it was removed through the editor, and the saved note again matched the original 2,509 bytes. The translation's changed-source guard prevented application after that edit.

## Reinstall isolation and active-use guard

A separate model store was prepared from the preserved Tiny incumbent, with seven verified artifacts and its install manifest. No shared model files were changed. The sole installed model was selected. Native dictation reached listening, and its Reinstall action refused to start with an instruction to stop active work. Cancellation returned capture to idle without changing the public test note.

Changing the store setting initially left cached installed lists from the previous folder. That issue was fixed in #518. Subsequent native checks covered explicit Apply, an empty store, invalid paths, restoration of the default store, and refusal while capture was active. [Store-switch details](2026-11-model-store-switch.md).

The Reinstall workflow was then exercised with the sole installed model selected. Partial-download cancellation preserved the incumbent, selection and note. A completed replacement installed and remained usable. Automated native tests cover cancellation during the worker release barrier and preservation of incumbent files on failure. Actual Windows file-handle behavior remains unverified in native Obsidian.

## NVIDIA streaming profiles

On the same Mac test environment, the English Nemotron ONNX export, Nemotron 3.5 multilingual 160 ms profile, and Parakeet Unified English 1,120 ms profile were selected and probed in Obsidian. Public fixture playback through system capture produced visible partials, a final result and a normal stop for each option. The multilingual check used German speech. The managed default model and store were restored afterward. These checks establish the workflow on this machine, not comparative accuracy or behavior across platforms.

Real-model adapter and sidecar tests also exercised silence, reset, cancellation and final speech. The reviewed combined platform CI run [42541345783](https://github.com/brittain9/speech-kit-obsidian-plugin/actions/runs/42541345783) passed its frontend, Linux, Windows x64/ARM and macOS Metal jobs. [English and multilingual profile details](../research/2026-11-nemotron-model-integration.md); [Parakeet profile and sustained worker results](../research/2026-11-nvidia-asr-options.md).

The English Nemotron ONNX files and Parakeet ONNX files are pinned by artifact revision and hash, but neither third-party export proves the exact source checkpoint revision. No comparative model-quality claim is made. The 1,120 ms Parakeet profile uses buffered context and CPU inference; its chunk setting is not an end-to-end latency guarantee. The 560 ms Parakeet profile was not selected for normal use after a sustained worker run accumulated a growing delay.

## Settings, modal and processing-status checks

On macOS, the merged settings and modal changes passed native normal- and half-width layout checks. Changing the timestamp option retained focus. The picker opened on the selected Tiny model's family. An empty test store showed the selected read-aloud model as not installed; returning to the default store restored the selected voice. Settings groups used native spacing. A synthetic local provider completed a transformation, and a controlled authentication failure showed recovery feedback without discarding the raw transcript. These checks do not establish screen-reader or other-platform behavior.

A 120-second public-speech playback used a local test-only slow 560 ms Parakeet profile to exercise workflow-status work (#524). The native UI showed listening and growing backlog, then showed finishing after Stop while accepted speech drained. The final fixture phrase appeared; a typed marker and pasted public URL remained once each, and the temporary pin cleared. Recording was off. This is a bounded functional drain check, not an accuracy or performance comparison, and it does not change the production 1,120 ms profile. The final #524 head passed its exact-head [platform CI](https://github.com/brittain9/speech-kit-obsidian-plugin/actions/runs/42551420748) on `10d222a`, then merged.



## Sustained live dictation

With the production native engine and Moonshine Tiny, a 300-second public speech replay completed while the session stayed listening. A further 47 seconds included a typed marker and pasted public URL. After Stop, accepted speech drained and the temporary pin was removed. The original note prefix, typed marker, and URL were preserved; each manual addition appeared once. The saved text contained the expected 29 repeat markers and no zero-width spaces. Recording was off, and system audio was turned off afterward. This 347-second functional check is not an accuracy, battery, or hours-long reliability benchmark.

## Grouped model picker

The replacement grouped picker (#533) passed native checks for all three tasks, task-wide search, per-task language and disclosure choices, empty results, scrolling, and optional voice controls. Normal and narrow app viewports, larger text, long labels, and task keyboard navigation passed. A follow-up made the narrow task controls three equal columns; its native retest passed. The [exact-head platform CI](https://github.com/brittain9/speech-kit-obsidian-plugin/actions/runs/42553319793) passed on `b48868c`. The PR merged at `9e65f23`; #531 was closed as superseded. Actual operating-system window resizing was not verified; the narrow viewport was exercised inside Obsidian.

The combined QA frontend built from `2b91533` passed 1,912 tests with 10 skipped, both typechecks, both linters, and the production build. The installed frontend and stylesheet had SHA-256 prefixes `00df2430` and `cf32690c`; the production native sidecar had prefix `1ee843`. These identify the tested candidate only. The final integrated build and installed identity are still being established.

## Translation status and retained partial recovery

A native HY-MT translation of a public 396-word note continued after its progress view was closed. The status button reopened the view; closing it returned keyboard focus to the button. The completed preview was dismissed, and the source note remained unchanged. This checks native focus behavior, not screen-reader output.

A cancelled public audio-file job retained an incomplete transcript. After closing and reopening its recovery dialog, Copy and Insert were available with a warning that a new job clears the partial. Inserting while another note was active was refused and left both notes unchanged. Returning to the original target inserted the partial once and cleared the recovery status. The merged clipboard-feedback change (#532) was checked natively on a cancelled public file: Copy showed the inline confirmation, kept keyboard focus, and did not change the note. Closing and reopening allowed another successful Copy. Insert in the original target added the incomplete result once, preserved existing source text, and cleared the attention status. The clipboard was not read during the check. Rejection and late-completion handling were covered by real-DOM tests rather than an injected native permission failure.

## Remaining validation

A native check of the merged caret-order fix (#527) preserved the first transcript and recording as the prefix of a second consecutive session, with both recording links in chronological order. The dropdown model-picker prototype (#531) was rejected. Its grouped replacement (#533) passed native and platform checks and merged. Workflow status (#524) is merged. Clipboard feedback (#532) is merged and passed the native check above. The user-selected Models settings summary passed native checks. Release metadata and final CI remain pending. Push-to-talk is deferred by explicit user direction: the required configurable hold shortcut needs key-release information unavailable through the public command callback, and no separate shortcut framework is being added in this pass. A clean main checkout passed dependency installation, frontend checks, build, and output verification; the installed candidate is recorded below. Native Windows, Linux, mobile and screen-reader behavior are not established by the Mac checks above. No battery or energy saving has been demonstrated.



## Models settings summary candidate

The selected Models settings design groups speech, read-aloud, and translation summaries under one Manage models action. It uses accessible status indicators and preserves task-specific picker, details, and external-file actions. The final source candidate `3881d47` passed review and the full frontend gate: 1,929 tests passed, 10 skipped, with both typechecks, both linters, and the production build.

Native checks covered all three picker routes with no selection in an empty store. A real managed Tiny installation downloaded and verified its seven artifacts, selected the model, and showed Installed and Streaming. Closing the picker returned focus to the newly rendered row. A separate missing-model fixture showed missing status without a false Streaming indicator. The checked frontend SHA-256 was `75dd68f101a35ef35e40b8b572c2780699bfd7d4f0a0ca1ef19e22fb6c3399d2`; the checked stylesheet SHA-256 was `649f64641ae6b8ecb7732e233b3165f373a3023f3a4099af6169dc88de32e6f5`. These identify the earlier tested candidate, not the final documentation batch.

A later candidate passed native first-run wording checks: all three tasks showed no selection, and speech offered a choose-or-install hint. A real seven-artifact Tiny install verified 51,441,771 bytes, selected the model, and returned focus to its new row when the picker closed. Native checks also confirmed red indicators for missing models, the model details and import-cancel actions, and restoration of the default store. After reloading the plugin, normal and compact layouts passed, with menu controls separated and labels wrapping. The installed frontend SHA-256 was `f537963c1502bcde6fc53fd2136c70fa446b4ef51ce8198124ea55281aee3aaa`; the installed stylesheet SHA-256 was `c20239dbb1b50e3f6b8b5f809e85bffd0bec1cdfe4e6851f3f2086104161061e`. The production native sidecar remained unchanged. The Settings sidebar microphone icon was not visible after reload; the user deferred that cosmetic issue until after release. The UI scale had not yet been restored when the check was interrupted.

## Test environment restoration

After the recovery check, the original test note was returned to its prior blank and pinned state. Test-created notes and their associated recordings were organized in the existing QA folder. The synthetic provider was stopped. A settings check confirmed microphone recording and system audio off, temporary pinning enabled, and the prior provider, model, timing, timeout, and active preset restored. This describes the test environment, not a release installation.
