# Nemotron English and 160 ms integration

The existing ONNX Runtime adapter now runs the pinned English export published April 25, 2026 and an optional 160 ms multilingual profile. The existing Nemotron 3.5 560 ms model keeps its ID and artifacts. The 160 ms option is an additional encoder-chunk profile for that existing model. Functional tests passed on public English and German speech. No comparative quality, latency, or battery claim is made.

## Sources and licenses

| Model                  | Upstream model reference                                                                                                                        | Runtime export                                                                                                                                                                 | License                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| English export, 560 ms | [NVIDIA English model](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/tree/ebe59e5a817142986528bbbee5dba8db7b38ed50)           | [sherpa int8 `52056fdc`](https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25/tree/52056fdc070914a48dcd68b31b44d6a6f5b85902) | [NVIDIA Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/) |
| Multilingual 160 ms    | [existing 3.5 revision `f3d33339`](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/tree/f3d333391852ba876df169dcc9ba902d25b6ab0b) | [sherpa int8 `b3a4dbde`](https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11/tree/b3a4dbde84fba1a13cb4270e6730b525ac6a2db6)   | [OpenMDW-1.1](https://openmdw.ai/license/1-1/)                                                                      |

As checked on November 8, the [English model card](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/blob/ebe59e5a817142986528bbbee5dba8db7b38ed50/README.md) identifies March 13 as the updated checkpoint release. The official `.nemo` artifact at March revision `ac0580bb7d3d6e39c4361db6afe28db9211793e4` and current revision `ebe59e5a` has the same SHA-256, `283638054c44f6794e74fe9af9048d78a6d9d6c058c12131856c7859a62ac9cd` (2,473,041,920 bytes). Hub metadata establishes that identity, but does not establish which checkpoint generated the published ONNX export. The original checkpoint was not downloaded.

The [successful April 25 conversion run](https://github.com/csukuangfj/sherpa-onnx/actions/runs/24928745025) is recorded at fork revision `f992821e1d2037d1b4b4642bd24b02b667104d85`. Its logs have expired, so a restored Hugging Face snapshot or checkpoint hash could not be recovered. The association with the March checkpoint is an inference from the publication timeline and upstream model link. This integration does not claim a verified v2603 conversion. Its English catalog ID and label identify the English streaming profile without asserting that source version.

The current [3.5 model card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/blob/ea30d66debe3740a08b573244286791d423d6b3e/README.md) still describes the June 4 checkpoint. Its `.nemo` SHA-256 remains `210214ed94039bf6bfbb9a047c7fa289628db75b103e2bf6381fa78285436a74`, matching the [existing artifact record](../specs/nemotron-asr-stage-a.md). The published 560 ms export remains at `ab43d895f5985b1bbab8b6eac8607fcdc05343f3`, with unchanged artifact hashes.

The [sherpa runtime documentation](https://k2-fsa.github.io/sherpa/onnx/nemo/nemotron-streaming.html) lists these compatible encoder-chunk exports. The [English exporter](https://github.com/k2-fsa/sherpa-onnx/blob/4fa889824497c22a874fb3cbf5fbd58425da89bb/scripts/nemo/nemotron-speech-streaming-en-0.6b/export_onnx.py) loads the NVIDIA model by name. Its upstream recipe does not pin every conversion dependency. The runtime guarantee here is the exact published ONNX bytes and observed execution; byte-identical regeneration is not claimed.

English uses NVIDIA's custom agreement, including its use and redistribution conditions. Manage Models links to those terms through the existing terms-review control. The multilingual profile retains OpenMDW-1.1. See [notices](../../THIRD_PARTY_NOTICES.md). Model weights are fetched directly from the pinned upstream exports.

## Verified graph contracts

All profiles use `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`. The entry file remains `encoder.int8.onnx`. They run on CPU through the existing ONNX Runtime. No additional runtime, service, or model conversion is needed.

| Contract                       | English export 560 ms         | Multilingual 160 ms            | Existing multilingual 560 ms |
| ------------------------------ | ----------------------------- | ------------------------------ | ---------------------------- |
| Encoder type                   | `EncDecHybridRNNTCTCBPEModel` | `EncDecRNNTBPEModelWithPrompt` | same prompted type           |
| Input feature frames / shift   | 65 / 56                       | 25 / 16                        | 65 / 56                      |
| Channel cache, excluding batch | 24 × 70 × 1024                | 24 × 56 × 1024                 | 24 × 56 × 1024               |
| Time cache, excluding batch    | 24 × 1024 × 8                 | 24 × 1024 × 8                  | 24 × 1024 × 8                |
| Vocabulary, including blank    | 1,025                         | 13,088                         | 13,088                       |
| Language prompt                | absent; English only          | validated prompt dictionary    | existing prompt dictionary   |

The adapter checks the supported profile dimensions, ordered graph ports, element types, tensor ranks, tokenizer size, and terminal blank token. English probing reports English-only support and disables automatic detection. Select **English** as the dictation language for that model. The 160 ms profile retains the same nine enabled language tags and automatic detection as the existing profile.

Chunk labels describe encoder configuration. End-to-end dictation latency also includes audio collection, inference, and speech-boundary detection. The 160 ms label is not a measured latency promise.

The shared tokenizer, log-mel frontend, and tensor helpers are in `nemo_rnnt.rs`. The original NeMo frontend oracle tests moved with that code without changing their tolerances. Model-specific graph and cache rules stay in the Nemotron adapter.

## Acquisition and functional checks

English requires **661,919,416 bytes**. The 160 ms multilingual model requires **682,215,471 bytes** for a fresh install. Its decoder, joiner, and tokenizer are byte-identical to the existing 560 ms files. Validation reused those installed files and downloaded only the new encoder. Total new artifact transfer was **1,319,520,934 bytes**. All sizes and SHA-256 values matched; English's non-LFS tokenizer also matched its pinned Git blob. [The catalog](../../native/catalog.json) records every artifact URL, size, and digest.

Public adapter tests first failed on the English encoder type and the shorter multilingual profile. Catalog tests first failed because the entries were absent. After the implementation, direct model tests passed for English streaming, German transcription, language rejection/selection, reset, and silence. Tests use explicit local model directories and do not download weights.

An actual debug sidecar, SHA-256 `0f313d5c8bb24c2c598e41193331a53a8327e940b83523a62f677da11927ef67`, was driven through framed stdin/stdout on an Apple M2 Pro with 16 GiB and macOS 27.2. CPU ONNX received checked-in 16 kHz mono PCM in 640-byte frames paced every 20 ms, followed by 1.2 seconds of generated silence. Each process then ran a separate silence session and a real-speech cancellation session.

| Profile / language                    | Public fixture    | Live partials | Finals | Silence | Speech cancellation  |
| ------------------------------------- | ----------------- | ------------: | -----: | ------- | -------------------- |
| English export / English              | `7021-79740-0000` |            16 |      1 | empty   | 3 partials, no final |
| Multilingual 160 ms / German          | `de-fleurs-1577`  |            16 |      1 | empty   | 6 partials, no final |
| Multilingual 160 ms / auto            | `7021-79740-0000` |            36 |      1 | empty   | 7 partials, no final |
| Existing multilingual 560 ms / German | `de-fleurs-1577`  |             6 |      1 | empty   | 3 partials, no final |

Every completed speech run emitted increasing revisions with a preserved prefix and one final. Every stop and cancellation reached its matching terminal event. All four processes exited successfully. The German profiles produced the expected fixture sentence. These small functional checks establish that the selected artifacts execute through the product path. They do not establish comparative model quality. [Curated results](../quality/2026-11-08-nemotron-profiles.json) contain public-fixture text and protocol outcomes only.

After integration with the current Parakeet and model-store changes, the local Rust gate passed formatting, Clippy with warnings denied, and 418 tests, with 32 opt-in tests ignored. All five real-profile tests passed again, including the VAD/worker revision path for both new profiles. The combined Metal sidecar build and build-output verification passed. A clean Node 24.22.2 dependency install preceded the frontend checks. The combined frontend gate passed both typechecks, both linters, 1,844 tests with 10 skipped, and the production bundle.

Public UI tests first failed on the former 3.5-only external-file guidance and raw terms-review badge. They now pass with a generic Nemotron family name, all three supported profiles, and localized **License terms** text.

Native Obsidian checks passed with the pinned English export and the multilingual 160 ms German profile in a combined build. Public speech fixtures played through system capture produced live partials, a final, and a normal stop. Model selection and language configuration were restored afterward, with capture and system audio off. Acoustic playback verifies the workflow; it is not an accuracy comparison.

To repeat the real-model checks, set `STT_TEST_NEMOTRON_ENGLISH_DIR` and `STT_TEST_NEMOTRON_160MS_DIR` to verified local model directories, then run:

```sh
cargo test --manifest-path native/Cargo.toml --no-default-features \
  --features engine-nemotron-asr --test nemotron_profiles \
  -- --include-ignored --test-threads=1
```

The [combined platform CI](https://github.com/brittain9/speech-kit-obsidian-plugin/actions/runs/42541345783) passed on source revision `1dbc428`: portable Linux, Linux ARM, macOS Metal, and Windows x64/ARM. Those build and test lanes do not establish real-model performance on each platform. Real-model inference and native Obsidian checks above ran on macOS arm64. A release must still ship matching native binaries under [ADR 0007](../adr/0007-decouple-plugin-and-sidecar-releases.md).
