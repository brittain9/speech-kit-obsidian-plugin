# Practical ASR model opportunities, 2026-11-08

The corrected English Moonshine Tiny export is merged and validated through a fresh managed install and real streaming inference. It improves the small public-fixture sample at nearly unchanged download cost. [Local measurements and limits](../quality/2026-11-08-moonshine-tiny-refresh.md).

Later work added the [English Nemotron export and multilingual 160 ms profile](2026-11-nemotron-model-integration.md), plus [Parakeet Unified English 1,120 ms](2026-11-nvidia-asr-options.md). The remaining candidates below are proposals. Parakeet TDT is a separate batch model; it is not the integrated Unified model.

Research baseline: `db75b7e`; catalog version 9. No weights were downloaded, converted, loaded, or benchmarked during this research pass. Remote reads covered source, model metadata, two small configs, two tokenizers, and bounded availability checks. No personal vault was accessed.

## Existing execution paths

The pre-refresh catalog at `db75b7e` has five Whisper variants, three English streaming Moonshine variants, multilingual Nemotron 3.5 ASR 560 ms, and three English Cohere Transcribe variants. German already works through Whisper Turbo and Nemotron. Adding German is therefore a resource/latency choice, not first German support. Baseline model-file totals are:

| Existing family                        |                                      Download bytes | Relevant behavior                                 |
| -------------------------------------- | --------------------------------------------------: | ------------------------------------------------- |
| Whisper Tiny/Base/Small/Medium English | 43,550,795 / 81,781,811 / 190,098,681 / 539,225,533 | Batch; CPU, Metal, or packaged CUDA path          |
| Whisper Large V3 Turbo Q8_0            |                                         874,188,075 | Batch; ten product languages; segment/word timing |
| Moonshine Tiny/Small/Medium English    |              51,131,795 / 164,689,974 / 303,329,727 | Streaming; CPU                                    |
| Nemotron 3.5 ASR 560 ms INT8           |                                         682,215,356 | Streaming; nine catalog language tags; CPU        |
| Cohere FP16/INT8/Q4                    |       4,133,550,259 / 3,069,676,797 / 2,127,668,654 | English batch; CPU                                |

Sources: [catalog](../../native/catalog.json), [Whisper adapter](../../native/src/adapters/whisper.rs), [Moonshine adapter](../../native/src/adapters/moonshine.rs), [Nemotron adapter](../../native/src/adapters/nemotron_asr.rs), and [CPU-only ONNX runtime](../../native/src/runtimes/onnx.rs). The baseline Nemotron description omitted Croatian from its count. That copy is now corrected; the nine enabled languages are unchanged.

The native dependencies are `whisper-rs 0.16.0` / `whisper-rs-sys 0.15.0` and `ort =2.0.0-rc.12`. A common file extension does not imply adapter compatibility. External imports select an explicit family and probe the real model. Moonshine requires `frontend.ort` plus six siblings. Nemotron now validates English 560 ms and multilingual 160/560 ms contracts. The HY-MT helper accepts text, not audio. Sources: [dependencies](../../native/Cargo.toml), [lockfile](../../native/Cargo.lock), [import UI](../../src/models/external-model-file.ts), and [translation helper](../../native/src/bin/translation_helper.rs).

## Ranked candidates

Ranking favors live dictation, modest downloads, and reuse of working execution paths. Memory descriptions are planning estimates, not measured RSS. Quantized file size excludes runtime tensors, caches, and dequantized weights. No battery or accuracy improvement is established for Speech Kit.

| Rank | Candidate and user benefit                                                                                                 | Integration class                                 | Recommendation                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| 1    | Corrected English Moonshine Tiny, July 30 monolithic export: small-fixture accuracy gain at nearly unchanged file size     | Catalog-only; merged                              | See measured limits above                                      |
| 2    | Multilingual Whisper Small Q5_1: smaller multilingual batch option than Turbo; optional Base Q5_1 for constrained machines | Catalog-only candidate                            | Validate Small in English and German; defer Base unless needed |
| 3    | Whisper Turbo Q5_0: 300,146,880 fewer download bytes than current Q8_0                                                     | Catalog-only candidate                            | Validate if download/memory saving matters; no speed claim     |
| 4    | German/Spanish streaming Moonshine Tiny or Small: compact live alternatives to Nemotron                                    | Small adapter within existing ONNX runtime        | Next useful feature; validate one language/model first         |
| 5    | primeLine German Whisper Turbo fine-tune: targeted German quality candidate                                                | Offline conversion, then existing Whisper adapter | Defer until German fixtures show a need                        |
| 6    | Nemotron 80 ms INT8: lower encoder chunk latency than current 560 ms                                                       | Small adapter; new validated shape profile        | Defer until measured live delay identifies a need              |
| 7    | Parakeet TDT 0.6B v3 INT8 ONNX: multilingual batch and token timing opportunity                                            | New family adapter within ONNX runtime            | Defer; overlaps existing Nemotron/Turbo                        |
| 8    | Qwen3-ASR 0.6B GGUF: broader language/dialect coverage                                                                     | New audio architecture/helper integration         | Separate architectural work; not a catalog addition            |

### 1. Corrected English Moonshine Tiny

The catalog uses `moonshine-ai/moonshine-voice-assets` revision `015f7269048251aff164cb60df02bfea76884c8f`, directory `model/tiny-streaming-en/quantized_26_07_30/`. Its seven required files total **51,441,771 bytes**, versus the pre-refresh 51,131,795. It retains the monolithic frontend contract. Config parsing found the expected 320-dimensional model, six decoder layers, BOS/EOS 1/2, and 32,768 vocabulary entries. The tokenizer parsed all 249,974 bytes into exactly 32,768 tokens. The subsequent managed-install and inference checks passed. [Pinned asset tree](https://huggingface.co/moonshine-ai/moonshine-voice-assets/tree/015f7269048251aff164cb60df02bfea76884c8f/model/tiny-streaming-en/quantized_26_07_30), [inventory](https://huggingface.co/moonshine-ai/moonshine-voice-assets/blob/015f7269048251aff164cb60df02bfea76884c8f/FILES.tsv).

Required assets: `frontend.ort`, `encoder.ort`, `adapter.ort`, `cross_kv.ort`, `decoder_kv.ort`, `streaming_config.json`, and `tokenizer.bin`. The optional attention decoder is excluded. English-only streaming; MIT. The Rust adapter loaded these files without an inference change. Measured RSS and the original 1 GiB investigation threshold are recorded in the validation report. [Current loader](../../native/src/adapters/moonshine.rs), [upstream license](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/LICENSE).

Upstream reports Tiny LibriSpeech test-clean WER falling from 7.57% to 4.83% after per-channel quantization; Small and Medium changes were smaller. Those are upstream whole-utterance results with VAD disabled. The paper's floating-point leaderboard figures are different tests. Our later eight-clip protocol comparison measured 25 versus 16 word edits across 215 reference words; this is a small fixture sample, not a general accuracy result. [Local comparison](../quality/2026-11-08-moonshine-tiny-refresh.md), [quantization method and results](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/quantization.md), [accuracy methodology](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/accuracy.md).

Latest English exports use a split frontend. They are not the catalog-only choice described here. Do not mix July 30 and newer graph files.

### 2–3. Official Whisper GGML variants

All three files are already present at the same `ggerganov/whisper.cpp` revision used by the current catalog: `5359861c739e955e79d9a303bcbc70fb988958b1`. Each is a self-contained **GGML `.bin`**, including vocabulary; no separate tokenizer or Python runtime is required. The runtime's own download list supports these variants. MIT; retain upstream notices. [Official files](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1), [runtime model documentation](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md), [download script](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.sh).

| File                           |       Bytes | SHA-256                                                            |
| ------------------------------ | ----------: | ------------------------------------------------------------------ |
| `ggml-small-q5_1.bin`          | 190,085,487 | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` |
| `ggml-base-q5_1.bin`           |  59,707,625 | `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898` |
| `ggml-large-v3-turbo-q5_0.bin` | 574,041,195 | `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2` |

These are batch models. Whisper.cpp supports multilingual files without `.en`; Speech Kit must advertise only its ten reviewed product languages until new fixtures and language review exist. Metal/CUDA can use the existing Whisper path. No CPU/GPU speed comparison was run. Lower bit width does not prove lower latency or battery use. Expect low-GiB working sets for Small and multi-GiB for Turbo; investigate peaks above 2/4 GiB respectively. [Product language contract](../../native/src/adapters/whisper.rs), [GPU selection](../../native/src/runtimes/whisper_cpp.rs).

Small offers a lower resource tier for languages currently served only by the larger multilingual models. Turbo Q5_0 saves **34.3% of model-file bytes** against current Q8_0; its recognition tradeoff needs matched tests. Neither option changes streaming behavior.

### 4. Multilingual streaming Moonshine

Start with German Tiny, then Small only if quality requires it. Spanish and Japanese are the next compatible product languages. Upstream also publishes Arabic, Mandarin, Tagalog, and Vietnamese streaming models, but Speech Kit does not yet expose those dictation languages. The current available-model table lists these streaming models as MIT. Legacy non-English non-streaming models retain different Community terms. [Available models](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/docs/models/available-models.md), [license scope](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/LICENSE).

The pinned mirror snapshot above has `model/{tiny,small}-streaming-{de,es}/quantized_26_11_07/`. German totals are **32,219,068 / 121,586,543 bytes**; Spanish totals are **32,218,637 / 121,586,112 bytes**. Each requires `frontend.model.ort`, `frontend.weights.ort`, `encoder.ort`, `adapter.ort`, `cross_kv.ort`, `decoder_kv.ort`, config, and tokenizer. German Tiny's config/tokenizer agree on 12,288 entries. These totals exclude optional assets. [Pinned inventory](https://huggingface.co/moonshine-ai/moonshine-voice-assets/blob/015f7269048251aff164cb60df02bfea76884c8f/FILES.tsv), [German model card](https://huggingface.co/moonshine-ai/moonshine-streaming-tiny-de).

The split frontend requires loading/dequantizing the weights model once, then passing its float outputs into the compute graph. Renaming a file to `frontend.ort` cannot implement this. Add graph validation and model-specific language reporting; today's family capability is English-only. Keep CPU execution until the actual exports prove an accelerator benefit. Planning memory: hundreds of MB for Tiny, potentially over 1 GiB for Small; measure, especially the reconstructed float frontend. [Upstream split loader](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-streaming-model.cpp), [current adapter](../../native/src/adapters/moonshine.rs).

Do not promise the upstream German/Spanish error rates on live Obsidian dictation. They use 400-clip public panels with VAD off. Japanese uses CER, not WER. Current ORT compatibility remains unverified until all graphs run on our pinned runtime.

### 5. primeLine German Whisper Turbo

Revision `9e7012dad9247f07553aac8a99c4d50ad7c3d36d` provides **1,617,825,448-byte `model.safetensors`**, config, Whisper vocabulary/merges, tokenizer configuration, and preprocessing configuration. It is a Transformers checkpoint, not a directly importable GGML file. The model card labels it Apache-2.0 and reports a German panel aggregate of 2.628% WER versus 3.649% for original Turbo. This comparison belongs to that panel and precision/runtime, not our quantized plugin. [Author's model card](https://huggingface.co/primeline/whisper-large-v3-turbo-german), [pinned files](https://huggingface.co/primeline/whisper-large-v3-turbo-german/tree/9e7012dad9247f07553aac8a99c4d50ad7c3d36d).

Whisper.cpp documents HF-to-GGML conversion. Export once, quantize deliberately, then test through existing import/probe/inference. Conversion and tokenizer parity are unverified. Preserve Apache attribution/notices and record conversion changes. Inference remains German batch with the current Whisper CPU/Metal/CUDA path. Expect multi-GiB working memory; conversion also needs the source checkpoint, output, and framework overhead. Defer the download until a concrete German failure justifies it. [Converter instructions](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md).

### 6. Nemotron 80 ms

Exporter revision `2ac5952ae18a2cc010c25e3fd96ad20cf254bd09` has `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`, totaling **682,215,469 bytes**. It uses the same source model as our current 560 ms export. OpenMDW-1.1 applies; distributions retain the agreement and origin notices. [Export and files](https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-80ms-int8-2026-06-11/tree/2ac5952ae18a2cc010c25e3fd96ad20cf254bd09), [NVIDIA card](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b), [license](https://openmdw.ai/license/1-1/).

The adapter supports multilingual 160/560 ms, and rejects this 80 ms graph. Another exact profile needs separate shape validation and real inference tests. Keep the current verified language subset. CPU memory is likely similar to the other Nemotron profiles and exceeds stored weights; measure against a 2 GiB investigation threshold. Smaller chunks can increase scheduling/decoder work, so lower advertised chunk latency does not prove faster end-to-end output or lower energy. No runtime change is needed, but inference code and tests are.

### 7. Parakeet TDT 0.6B v3

NVIDIA's batch model covers 25 European languages and supplies punctuation and token timing. It is CC-BY-4.0. The exporter-owned ONNX revision `8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce` needs `encoder-model.int8.onnx`, `decoder_joint-model.int8.onnx`, `nemo128.onnx`, `vocab.txt`, and `config.json`: **670,719,803 bytes**. Its vocab format and TDT duration decoder are not our Nemotron RNNT contract. [NVIDIA card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [exporter card](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), [pinned export](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/tree/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce).

This is a new family adapter on existing ONNX Runtime, not a catalog addition and not a need for Python in production. Attribution, license link, and modification notice are needed if distributing a modified export. Use CPU first; GPU speed from another app/export is not transferable. Budget a few GiB working memory pending measurement. Validate frontend normalization, duration advancement, silence, long audio, and timestamps before considering integration. Streaming is not established by this batch export.

### 8. Qwen3-ASR 0.6B

The official model covers 30 languages plus 22 Chinese dialects and offers offline/streaming inference in its own toolkit. Apache-2.0. Original revision `5eb144179a02acc5e5ba31e748d22b0cf3e303b0` contains 1,876,091,704-byte safetensors plus tokenizer vocab/merges, config, chat template, and preprocessor config. [Qwen card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), [official toolkit](https://github.com/QwenLM/Qwen3-ASR).

Prefer investigating the runtime maintainer's existing GGUF export over adding PyTorch: `ggml-org/Qwen3-ASR-0.6B-GGUF` revision `928ab958557df9aa2ef1c93e0e83c7ad0933fae2` has `Qwen3-ASR-0.6B-Q8_0.gguf` plus `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`, **1,019,141,728 bytes** combined. Tokenizer metadata is in GGUF. llama.cpp supports audio through `libmtmd` and lists Qwen3-ASR. [Export](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/tree/928ab958557df9aa2ef1c93e0e83c7ad0933fae2), [multimodal runtime interface](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md).

Speech Kit's HY-MT helper has no audio/projector API. An audio helper, preprocessing, prompts, transcript parsing, cancellation, and capability work are needed. Existing `llama_cpp` metadata does not make this a small adapter. Upstream toolkit streaming does not establish streaming through our pinned llama bindings. Expect multiple GiB of memory and per-platform acceleration validation. Defer to a separate design decision with a specific unmet language need.

## Availability and evidence limits

On November 8, bounded **GET** requests with `Range: bytes=0-4095` succeeded for all seven incumbent Tiny files (HTTP 206; total sizes matched the catalog). The old UsefulSensors Tiny model-card URL returned HTTP 200 and redirected to `moonshine-ai`; link failure was not reproduced. Plain GET of guessed dated CDN config paths returned 403. The official pinned HF mirror served the two configs and tokenizers. Do not treat a HEAD failure or a guessed URL as proof that installation is broken.

There is upstream snapshot drift: the inspected GitHub catalog (`d8d8fa29…`) names November 2 / August dated paths, while the current mirror uses November 7 paths. Its README also has older blanket non-English Community-license wording; the current repository LICENSE explicitly includes streaming models under MIT. Pin one complete asset snapshot and its applicable license. Do not derive URLs from an architecture name or mix files between dates. [Upstream catalog](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-model-catalog.cpp), [mirror](https://huggingface.co/moonshine-ai/moonshine-voice-assets), [current license](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/LICENSE).

## Original bounded validation route

1. Start with candidate 1 only. Reuse an installed incumbent if available. Otherwise download at most **103 MB** combined for incumbent/candidate Tiny; use repository public fixtures. Verify SHA-256 and exact file sizes. No queue of further downloads.
2. Write the catalog selection test first. Check the complete pinned artifact set, English streaming capability, license, and install/probe behavior. Keep existing model IDs/cache paths stable. Do not silently substitute weights on a hash mismatch.
3. Run the existing native streaming and framed-protocol path on the same eight English fixtures, silence, short speech, and repeated start/stop. Compare normalized WER, first-partial time, final-drain time, real-time factor, and peak RSS. Run three warm repetitions per model in alternating order. Record hardware, binary/dependencies, thread count, fixture revisions, and cold/warm state.
4. Accept only a useful measured gain with no material latency, memory, or transcript regressions. Upstream benchmarks alone are insufficient. A small public-fixture sample is descriptive, not a general accuracy claim. Measure energy separately only if the available counters and background load support comparison.
5. For German batch, test candidate 2 against installed Turbo on the checked-in German fixture plus at least two additional public utterances. Cap the added Small download at **191 MB**. Its success does not validate all ten languages. Candidate 3 needs another **575 MB** only after the first result identifies a reason.
6. For multilingual Moonshine, first implement split-frontend and language-reporting tests. Cap German Tiny validation at **33 MB**, run English rejection/selection plus German streaming, and compare to installed Nemotron. Do not download the whole language family. Full native Obsidian QA remains a distinct validation step.

Candidate 1 is now implemented and locally validated; see the linked validation report. Candidates 2–8 remain proposed. No release, tag, version bump, training, or paid infrastructure was created.
