# Model and hardware support

Use the [family/platform matrix](../../README.md#models-and-acceleration) to choose
an execution path. It describes the current source and supported sidecar build
configuration, not a benchmark ranking. Your installed sidecar determines which
families actually appear in Manage models. Source additions may precede a release.

## Platforms and packages

| Platform | Packaged architecture  | Available sidecar paths                   |
| -------- | ---------------------- | ----------------------------------------- |
| macOS    | Apple silicon (ARM64)  | CPU and Metal in the same package         |
| Windows  | x86-64                 | CPU package; optional NVIDIA CUDA package |
| Windows  | ARM64                  | CPU package                               |
| Linux    | x86-64, glibc          | CPU package; optional NVIDIA CUDA package |
| Linux    | ARM64, glibc, ARMv8.2+ | CPU package                               |

Windows ARM64 builds also target ARMv8.2+. There is no packaged Intel Mac,
32-bit, musl Linux, mobile, or ARM64 CUDA sidecar. These boundaries come from the
[release target matrix](../../.github/workflows/release.yml) and
[ARM build configuration](../../.github/actions/setup-sidecar-rust/action.yml).
See [Linux support](linux-support.md) for glibc, audio-service and sandbox details,
and [CUDA setup](cuda-setup.md) for GPU/driver requirements and the separate variant.

Models are separate downloads. Their download size is not a RAM or VRAM
requirement: inference needs working memory as well as weights. Manage models
shows each model's size, language coverage, license and installed availability.

## How the families use hardware

- **Whisper:** local batch dictation and file transcription through whisper.cpp.
  CPU is available everywhere above; Apple builds include Metal, and x86-64
  CUDA packages include the NVIDIA backend. English-only and multilingual
  checkpoints remain distinct. [Adapter](../../native/src/adapters/whisper.rs),
  [runtime](../../native/src/runtimes/whisper_cpp.rs).
- **Qwen3 ASR:** batch speech recognition through a separate llama.cpp helper.
  The managed decoder and audio encoder are installed together. CPU, Metal and
  CUDA routes follow the package matrix; there is no live partial text or model
  word timing. The current main catalog has 0.6B; 1.7B is a
  [pending candidate](https://github.com/brittain9/speech-kit-obsidian-plugin/pull/573)
  using the same adapter. [Adapter](../../native/src/adapters/qwen_asr.rs),
  [helper model](../../native/src/qwen_asr_model.rs).
- **Moonshine, NVIDIA Nemotron and Parakeet Unified:** live speech recognition
  through CPU ONNX Runtime. Moonshine and Parakeet are English-only in this
  catalog; Nemotron has English and multilingual choices. NVIDIA branding does
  not require an NVIDIA GPU. [Family registration](../../native/src/engine/registry.rs),
  [model catalog](../../native/catalog.json).
- **Cohere Transcribe, Pocket TTS and Supertonic 3:** CPU ONNX Runtime for English
  batch transcription and model-dependent local voices. Installing the CUDA
  variant does not change these families to GPU execution.
  [CPU session builder](../../native/src/runtimes/onnx.rs).
- **Firefox Translations:** local CPU inference in its isolated Bergamot
  WebAssembly worker, with language-direction packs selected separately.
  [Runtime](../../native/src/runtimes/bergamot_wasm.rs),
  [adapter](../../native/src/adapters/firefox_translations.rs).
- **Tencent HY-MT 2:** local translation through a separate llama.cpp helper,
  with CPU and the package-dependent Metal/CUDA routes. Larger models use more
  resources; they are optional choices, not replacements for the smaller model.
  [Adapter](../../native/src/adapters/tencent_hy_mt.rs),
  [helper](../../native/src/bin/translation_helper.rs).

CPU-only execution is intentional for the ONNX families. Their production
session builder does not enable a generic CUDA provider; upstream ONNX GPU
support is not automatically an available Speech Kit path.

## GPU boundaries

Metal/CUDA in the matrix means the backend is wired into the relevant family
and build. Actual operation depends on the device, driver, available memory,
model and access permissions. A configured GPU label is not a measurement of
successful offload or a guaranteed speedup. CPU remains an explicit option.

AMD/Intel GPU acceleration through Vulkan, ROCm or DirectML, and NPU/CoreML
providers, are not configured in these builds. Those machines can use the CPU
paths on a supported platform. Custom source builds are outside the packaged
support matrix. [Native features](../../native/Cargo.toml),
[shared build features](../../scripts/lib/sidecar-features.mjs),
[acceleration selection](../../native/src/app.rs).

## Validation coverage

| Evidence                               | Current coverage                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated build and correctness checks | Linux x86-64/ARM64, Windows x86-64/ARM64 and macOS Apple silicon; macOS checks use the Metal feature graph. Native-relevant changes select these lanes. |
| Recorded real model and app checks     | Dated Apple M2 Pro checks include managed Qwen 0.6B and multilingual Whisper; the Linux guide separately records Fedora KDE/Flatpak and Ubuntu VM use.  |
| Model-specific measurements            | Public fixtures and scoped quality/timing observations, with their stated host and execution context.                                                   |

CI builds and model-free protocol checks are useful coverage, not proof that
every checkpoint, GPU driver, audio device or desktop session was exercised.
There is no all-model/all-device certification claim. Useful evidence includes
[Qwen integration](../quality/2026-11-16-qwen-asr-prototype.md),
[Whisper Small checks](../quality/2026-11-16-compact-multilingual-whisper.md),
[Linux coverage](linux-support.md#current-test-coverage), and the
[actual CI lanes](../../.github/workflows/ci.yml).

The feature/backend grouping follows the useful distinction in
[Speech Note's public README](https://github.com/mkiol/dsnote/blob/main/README.md#flatpak-packages).
Its Python, architecture and GPU-addon support is specific to that application;
Speech Kit's entries above come from its own source and packaging configuration.
