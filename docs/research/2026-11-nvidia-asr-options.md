# NVIDIA speech recognition options

Reviewed 2026-11-08. NVIDIA provides three relevant 0.6B speech recognition models. Their published contexts are model settings, not measured end-to-end latency.

| Model                                                                                                | Release                | Scope and license                  | Available local route                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [Nemotron Speech Streaming English](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b) | March 13, 2026 (v2603) | English; NVIDIA Open Model License | NVIDIA provides a GGUF model for NeMo-Speech.cpp. The sherpa-onnx project also publishes a separate streaming ONNX export.       |
| [Parakeet Unified English](https://huggingface.co/nvidia/parakeet-unified-en-0.6b)                   | April 7, 2026          | English; NVIDIA Open Model License | NVIDIA provides a NeMo checkpoint. Sherpa-onnx publishes separate buffered-streaming ONNX exports, including a 1,120 ms profile. |
| [Nemotron 3.5 ASR Streaming](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)          | June 4, 2026           | Multilingual; OpenMDW 1.1          | NVIDIA provides a GGUF model for NeMo-Speech.cpp. The existing adapter uses a separate sherpa-onnx streaming ONNX export.        |

NVIDIA's [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/asr/models.md) supports both Nemotron models. Its [build instructions](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/main/docs/build.md) describe CPU, Metal, CUDA and Vulkan builds. Speech Kit's current ONNX Runtime adapter runs on CPU; those native backends are not capabilities of the ONNX adapter. A native integration would need its own runtime and distribution work. No cross-model accuracy or speed ranking follows from the published model cards.

Speech Kit integrates the pinned English Nemotron ONNX export and multilingual 160/560 ms profiles through its existing adapter. The English conversion does not record its exact NVIDIA checkpoint; the upstream v2603 release label does not prove the conversion's source. The multilingual 160 ms option uses the existing 3.5 model. See the [integration and provenance record](2026-11-nemotron-model-integration.md).

## Parakeet Unified export

The [1,120 ms export](https://huggingface.co/csukuangfj2/sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-1120ms/tree/615bf8c5ad39692dc96cf1105afde73ec3eb2a59) is a third-party ONNX conversion of NVIDIA's model. It contains four required files, totaling 663,048,980 bytes. The catalog pins the revision, sizes and SHA-256 hashes. The export points to the NVIDIA model, but its published metadata does not pin the source checkpoint revision. NVIDIA's [model card](https://huggingface.co/nvidia/parakeet-unified-en-0.6b/tree/fe53cd885760c96b6a5f51a0bfd362cb4584a98b) specifies the NVIDIA Open Model License; the weights do not use this project's MIT license.

The graph's 1,120 ms profile uses 560 ms chunks, 560 ms right context and up to 5.6 seconds of left context. It recomputes the encoder over that buffered context. NVIDIA recommends those parameters in the model card. It is a different graph from Nemotron 3.5: it has two encoder inputs, no language prompt or encoder cache, and requires per-feature normalization.

The [upstream buffered-streaming correction](https://github.com/k2-fsa/sherpa-onnx/pull/4133) was open on the review date. It reports issues involving initial context, feature computation, predictor state across endpoint resets and final partial hops. The adapter computes features for each actual audio window, uses sample-variance normalization, retains predictor state across chunks and sends the final buffered audio to the encoder. Speech Kit starts a fresh model utterance at each VAD boundary; it does not claim the cross-endpoint continuity of that proposed upstream change.

## Validation scope

The pinned files were hash-checked before native tests. Tests exercise loading, speech partials and final output, the VAD and worker path, silence and utterance reset using public audio fixtures. Only the 1,120 ms profile is in the production catalog. The 560 ms profile was excluded after an optimized 66.75-second continuous public-speech run accumulated 106.403 seconds of inference. The 1,120 ms profile completed the same worker run without a queue error and accumulated 19.496 seconds; the final phrase was present. These are small-corpus functional observations, not a general accuracy or speed ranking. Live CPU performance depends on the machine and workload.

Native Obsidian selection, live partials, final output and normal stop passed on macOS arm64. The later [combined platform matrix](https://github.com/brittain9/speech-kit-obsidian-plugin/actions/runs/42541345783) passed the portable, Linux ARM, macOS Metal and Windows x64/ARM build/test lanes. Real-model execution on Windows and Linux remains unverified here. No battery measurement or release is claimed.
