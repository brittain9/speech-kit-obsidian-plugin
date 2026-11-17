# Qwen ASR native feasibility and prototype

The user's latest request explicitly authorizes Qwen ASR investigation and implementation, superseding the earlier exclusion in the workflow spec. The target is a useful additional local model with honest streaming behavior, not a model-card-only addition.

## Primary sources and runtime choice

- [Official Qwen source](https://github.com/QwenLM/Qwen3-ASR/tree/7c6daf77a2421100f5fb066495372c00129d39ff), reviewed at this immutable revision. [Streaming implementation](https://github.com/QwenLM/Qwen3-ASR/blob/7c6daf77a2421100f5fb066495372c00129d39ff/qwen_asr/inference/qwen3_asr.py) accepts PCM chunks, retains accumulated audio and text, and re-feeds all accumulated audio with prefix rollback. That API is vLLM-only; it does not establish a persistent encoder-state cache. No timestamps are provided in streaming mode.
- Official Apache-2.0 checkpoints: [0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B/tree/5eb144179a02acc5e5ba31e748d22b0cf3e303b0) and [1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B/tree/7278e1e70fe206f11671096ffdd38061171dd6e5). Their documented language set includes the product's en/es/de/fr/pt/it/nl/ja, but not Croatian or Serbian. Timestamp alignment is a separate model, not a free property of ASR output. Server throughput figures are not Mac predictions.
- [llama.cpp Qwen audio implementation](https://github.com/ggml-org/llama.cpp/blob/9581154a2250cc9e6948e4c2a2fc4b4e19d1a57e/tools/mtmd/models/qwen3a.cpp) and [MTMD API](https://github.com/ggml-org/llama.cpp/blob/9581154a2250cc9e6948e4c2a2fc4b4e19d1a57e/tools/mtmd/mtmd.h). More directly relevant, the project's already pinned Rust wrapper 0.1.160 and system crate 0.1.161 contain the Qwen audio implementation, an optional MTMD feature, and safe audio tokenization/evaluation helpers. No dependency revision change is needed to prototype it. Text and encoder weights are separate GGUF artifacts and other projects' monolithic GGUF layouts are incompatible.
- [MLX-Audio Qwen source](https://github.com/Blaizzy/mlx-audio/blob/9dda053fe7de81cc8403d91d40e22efdd2f0d843/mlx_audio/stt/models/qwen3_asr/qwen3_asr.py) supports local Apple Silicon transcription. Its token-stream output over an already supplied recording should not be confused with incremental audio input. Adopting it here would add another runtime/distribution surface and a Mac-specific path.
- The reviewed [Candle tree](https://github.com/huggingface/candle/tree/cfcbd7186d13271843ce7eb41d25659bd0835850) has Qwen text and vision implementations but no Qwen ASR implementation was found. Reusing the text decoder alone would still require an audio encoder/frontend integration.
- [ONNX Runtime GenAI proposal #2885](https://github.com/microsoft/onnxruntime-genai/issues/2885) is open and points to an implementation draft. Existing ONNX Runtime could also run third-party custom exports, but that would require owning encoder/embedding/decoder contracts and preprocessing. The existing native MTMD path is the smaller initial foundation.

Graphify queries for `EngineRegistry`, `LoadedModel`, and `worker_main` located the registration and inference seams; current source inspection verified them. The native adapter owns prompt/output semantics and per-request limits; the existing worker owns utterance identity, finalization, and session cancellation. [ADR 0013](../adr/0013-use-native-llama-cpp-for-qwen-asr.md) records the choice before implementation.

## Download plan recorded before transfer

Host verified: Apple M2 Pro, 17,179,869,184 bytes RAM, approximately 56 GiB free on the data volume. Initial Qwen-only budget: 4 GB network transfers / 10 GB added disk. No paid resources or training. Model inference is serialized with the other model worker and yields to native capture QA.

First candidate: [ggml-org's 0.6B Q8 export](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/tree/928ab958557df9aa2ef1c93e0e83c7ad0933fae2), converted from the official checkpoint. Fetch exactly two files once and verify pinned Hugging Face LFS size/SHA-256 before use:

| Artifact                        |       Bytes | SHA-256                                                          |
| ------------------------------- | ----------: | ---------------------------------------------------------------- |
| Qwen3-ASR-0.6B-Q8_0.gguf        | 804,749,248 | bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971 |
| mmproj-Qwen3-ASR-0.6B-Q8_0.gguf | 214,392,480 | 41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d |

Total planned initial weights: **1,019,141,728 bytes**. Installer replays should use these verified local files to avoid another remote transfer.

The conditional 1.7B Q8 pair is 2,520,744,288 bytes at [ggml-org revision 36a678687ba7d07a74ca70ccb0e36902e005fb80](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/tree/36a678687ba7d07a74ca70ccb0e36902e005fb80). It is not queued until 0.6B runtime/quality validation succeeds. Both pairs together would total 3,539,886,016 bytes; any additional material transfers must be recorded before exceeding the budget.

## Smallest vertical slice

A feature-gated Qwen ASR `ModelFamilyAdapter` supervises a version-matched native ASR helper which loads the pair through the existing llama.cpp runtime and receives actual bounded PCM from the worker. Start with public failing family-resolution and real short/natural English/German tests. Verify conditioning and automatic-language output parsing, suppress model control tokens, reset between requests, preserve VAD/session cancellation, and prove a production managed install/probe/remove path before catalog recommendation. Then evaluate a separately described progressive re-decoding prototype using paced chunks and the same finalization boundary. Findings and measurements remain pending until executed.

ADR 0005 requires process isolation from Whisper because of GGML symbol collisions. The new helper follows the existing translation-helper packaging and supervision patterns, with a separate protocol/lifetime; it does not import the main library. The initial pair transferred once (1,019,141,728 bytes), and both size/hash checks passed. No inference had run at this checkpoint.

Initial native proof: the standalone isolated helper and the public Rust registry/adapter path both transcribed the pinned 5.4-second German fixture with zero normalized WER; manual selection and automatic `de` output passed, without control tokens or invented word timestamps. Public tests failed before family support and passed after implementation. Broader quality, managed-install, cancellation, and partial-transcription acceptance remain pending.

## Historical wrap-up, 16 November

The 0.6B pair is the only Qwen weight download (1,019,141,728 bytes). The public
registry/adapter German manual and automatic tests passed. Eight short language
cases passed their provisional screens; natural German WER was 18.5% and 7.7%.
A new natural English recording scored 25.7% raw WER against the provisional
20% screen, with proper-name errors and numeral-format differences. That screen
is not a user requirement or a sole adoption veto; exact error alignment and a
matched installed-Turbo comparison remain pending. No primary normalizer or
threshold was changed.

Peer review found a FIFO companion could block public probing before helper
timeouts; the public AppState regression failed by timeout before the regular-file
guard and passes after it. The helper now monitors owner stdin on a separate
thread and exits on EOF even when the inference thread is occupied. Its busy
subprocess fixture closes owner stdin and verifies successful bounded exit/reap.
The reviewer inspected these fixes without reporting another source blocker;
test execution was performed by the implementing worker.

The user requested stopping at this point. No 1.7B weights or additional model
inference were started. The authorized disk allowance was raised to 18 GB after
shared MTMD build caches grew substantially; approximately 43 GiB remained free
at that checkpoint. Unrelated/shared caches were preserved.

## Resumed integration, 17 November

The native prototype is now integrated with frontend family parsing/persistence
and an optional managed 0.6B pair entry. Both pinned artifacts are required.
Existing defaults are unchanged. The integrated full frontend gate passed
(2,060 passed, 16 skipped). All-engine Metal debug binaries built successfully from `75459ec5`.

The public loaded-model test passed real in-flight cancellation, bounded helper
termination/reaping, a different-language retry using a fresh helper PID, and
replacement cleanup. The combined build also passed Qwen-helper/parent-Whisper
coexistence with real models, plus German manual/automatic output: three selected
tests passed serially in 9.53 s. CPU was requested for inference; these results
make no Metal speed or quality claim. The independent busy-owner-EOF fixture
remains a process-lifecycle test, distinct from actual request cancellation.

The full all-engine Metal Rust gate passed: formatting, all-target Clippy with
warnings denied, and 434 tests passed / 40 ignored. The integrating reviewer
reported normal managed pair download, selection/readiness, and real German and
English file transcription in TestVault, preserving the existing note prefix.
Managed removal/reinstallation also passed, leaving Qwen installed and Moonshine
Tiny English selected. The two normal managed pair downloads plus the original
research download total approximately 3.057 GB against the 4 GB allowance.
Platform checks and integration review remain separate merge checks; manual
full-sidecar file-command cancellation was not exercised in the UI.
Exact alignment/matched baseline and the 1.7B model were not run. The raw English screen remains an informational observation,
not a user acceptance threshold. Streaming and model-derived word timestamps
remain unsupported. See the current
[integration evidence](../quality/2026-11-16-qwen-asr-prototype.md).

## Optional 1.7B model, 17 November

The user subsequently authorized adding the larger model beside 0.6B. Both remain
optional; existing defaults and saved selections are preserved. This uses the
same helper and batch capabilities: text appears after voice-detected phrases,
with no live partial text or model timestamps. Eight product languages and
automatic detection remain available. No new runtime, dependency, or streaming
implementation is introduced.

The pinned [ggml-org export](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/tree/36a678687ba7d07a74ca70ccb0e36902e005fb80)
identifies the official Qwen 1.7B base. The immutable API metadata and both actual
downloaded files independently match these sizes and SHA-256 values:

| Artifact                        |         Bytes | SHA-256                                                          |
| ------------------------------- | ------------: | ---------------------------------------------------------------- |
| Qwen3-ASR-1.7B-Q8_0.gguf        | 2,165,034,944 | 58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57 |
| mmproj-Qwen3-ASR-1.7B-Q8_0.gguf |   355,709,344 | 46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d |

One pair transfer consumed 2,520,744,288 bytes. The incremental allowance is
5.1 GB network, including a subsequent normal managed install, and 7 GB disk,
including its managed copy. Approximately 33 GiB was free before the transfer.
Existing 0.6B files and shared build caches were preserved.

[Raw observations](../quality/2026-11-17-qwen17-observations.json) retain exact
hypotheses and fixture hashes. Both sizes transcribed the same public 5.4-second
German and 11.125-second English clips on CPU and Metal, returned control-free
text, accepted a second request in the same helper, and shut down/reaped. On this
single Apple M2 Pro run, 1.7B CPU requests took 1,610/1,647 ms versus 812/859 ms
for 0.6B; Metal requests took 786/812 ms versus 349/520 ms. These descriptive
observations are not a controlled benchmark or a broader accuracy claim.

The first GPU attempts failed for both sizes because the restricted tool process
had no accessible Metal device. A temporary Rust-only diagnostic helper exposed
`failed to create command queue`; the same helper passed outside that sandbox
with Apple M2 Pro detected. No C++ configuration, production native behavior, or
CPU fallback was changed to conceal the failure. This does not qualify Windows
CUDA or Linux GPU behavior.

Catalog and managed-manager regressions cover the required pair, stable saved
0.6B/1.7B selection, unchanged default, install completion/probe, speech task
routing, selected-model removal protection, and clear-then-remove. Actual normal
managed download and native Obsidian selection/transcription remain pending the
combined build and root's UI verification.
