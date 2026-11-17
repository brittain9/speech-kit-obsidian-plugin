# Compact German streaming Moonshine

## Candidate and bounded validation plan

German Tiny adds a compact local streaming alternative to the existing larger
multilingual models. The existing ONNX Runtime is reusable, but the frontend
adapter must support the official split compute/weights graph pair.

Sources refreshed November 16:

- [Official asset snapshot](https://huggingface.co/moonshine-ai/moonshine-voice-assets/tree/e318117203f245fda2ca0142db6b8c057d86671c/model/tiny-streaming-de/quantized_26_11_07)
  contains eight files totaling 32,219,068 bytes.
- [Upstream loader](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-streaming-model.cpp)
  executes the no-input weights graph once, validates float outputs, and passes
  them by name as additional compute-graph inputs for every frontend chunk.
- [License scope](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/LICENSE)
  includes streaming models under MIT.

Before any weight download: limit this candidate's model assets to 33 MB and
extra working disk to 4 GB. Download one complete immutable German Tiny snapshot,
verify sizes and hashes, and validate through the adapter and managed production
sidecar. Use public German audio, silence, reset, cancellation, and English
selection rejection. Measure load/inference time and peak RSS. No comparative
accuracy or battery claim follows from a small fixture test. Spanish and larger
models wait until this candidate is validated. No paid resources or release.

The upstream config lacks a language field. Language identity must remain
model-specific; directory names alone are insufficient evidence.

## Export compatibility finding

The first downloaded November 7 mirror snapshot loads its split frontend but
has a newer cached encoder contract (`features`, `cache`, `cache_valid`). The
inspected official runtime implements the stateless windowed encoder and its
[official catalog](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-model-catalog.cpp)
selects German from `quantized_26_08_24` on the vendor CDN. Bounded GETs of that
exact published path succeeded. Before a second download, expand the total
asset ceiling to 66 MB for both complete exports of this one German Tiny model.
Validate the runtime-matched official snapshot; keep its own complete file set
and pin measured hashes. Do not guess cached-encoder semantics or mix snapshots.

## Decision

Retain split-frontend loading as an explicit external-import experiment, with
the complete official August 24 candidate in test-only metadata. Do not add
German Tiny to the shipping managed catalog: the raw 27/32.4-second repeated-clip
quality checks fail even though the short clip and actual capped VAD recording
work. [Measurements and reproduction](../quality/2026-11-16-german-moonshine-experiment.md).

For language identity, reuse the existing adapter probe override and recognize
the exact verified German tokenizer SHA-256, after validating its graph layout.
Neither a filename nor a vocabulary size is enough to identify a language.
Unverified split tokenizers fail probe and load; reporting them as ready with
unknown language would conflict with runtime language validation. Monolithic
English imports retain compatibility. A new companion metadata file derived
from the managed catalog would require new installation/import semantics and
still would not independently verify external artifacts, so it adds complexity
without improving this bounded experiment. No new runtime, protocol, or metadata
schema is introduced.
