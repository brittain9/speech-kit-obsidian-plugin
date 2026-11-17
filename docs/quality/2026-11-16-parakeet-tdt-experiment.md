# Parakeet TDT v3 int8: excluded experimental candidate

The managed catalog and default models are unchanged. This isolated adapter is not a production recommendation. The pinned third-party export passed short multilingual fixtures but failed natural long German speech, both directly and through actual native sessions. No managed installer/UI claim is made: evaluation stopped before catalog adoption.

The first public registry test failed because the distinct TDT family did not exist. A real German recognition test failed at family resolution before the adapter was implemented. The completed CPU adapter loads the actual graphs, validates companion configuration/tokenizer and graph I/O, runs feature extraction/encoder/joint decoder, emits bounded model-derived word timing, and resets recurrent state for each inference. Native AppState tests exercise real VAD, model loading, worker execution, and final transcript events.

The 11-case direct evaluation used the existing English fixture, seven existing multilingual fixtures, German automatic transcription, and two public natural German recordings. Established quality floors remain English WER <=20%, others <=45%. English scored 3.8%, Dutch 11.1%, the other short cases 0%. Long German scored 40.7% and 92.3%; the latter fails. Real native VAD sessions on the same recordings scored 88.9% and 96.2%, with one final each and no lifecycle errors. No artificial repeated-audio construction was used for these failures.

An independent NumPy/ONNX Runtime decoder reproduced the direct German outputs exactly, including mixed English/German and omitted clauses. It used the published reference recurrence: commit predictor state only for nonblank tokens, advance by predicted duration, and bound zero-duration emissions to ten tokens per encoder frame. A focused regression caught argmax ties selecting the last index in Rust instead of NumPy's first index; it was corrected before these measurements. Graph inspection confirms int32 targets, int32 target lengths, 8,193 vocabulary classes plus five duration classes, and four decoder outputs (including prediction lengths).

This implicates this pinned export/model combination for these fixtures. It does not establish that NVIDIA's original float model, another exporter, or other languages have identical quality. No further weights were downloaded. Raw latency around 0.03 RTF on these CPU clips does not justify adopting a model that loses speech. Peak RSS, battery use, Metal performance, and native UI behavior were not measured.

Pinned artifacts and budget: see [research](../research/2026-11-16-parakeet-tdt.md). Raw public-fixture results: [measurements](2026-11-16-parakeet-tdt-measurements.json). Architecture: [experimental ADR](../adr/0012-use-parakeet-tdt-batch-adapter.md).

Reproduce with `STT_COMPARE_MODEL` pointing to `encoder-model.int8.onnx` beside its four pinned companions:

```sh
cargo test --manifest-path native/Cargo.toml --no-default-features --features engine-parakeet-tdt --lib parakeet_tdt::tests
cargo test --manifest-path native/Cargo.toml --no-default-features --features engine-parakeet-tdt --test parakeet_tdt_e2e
# Passing real German fixture and bounded word timing:
cargo test --manifest-path native/Cargo.toml --no-default-features --features engine-parakeet-tdt --test parakeet_tdt_e2e local_model -- --ignored --nocapture
# Intentionally failing natural-long diagnostics; do not weaken their floors:
cargo test --manifest-path native/Cargo.toml --no-default-features --features engine-parakeet-tdt --test parakeet_tdt_e2e parakeet_tdt_quality -- --ignored --nocapture
cargo test --manifest-path native/Cargo.toml --no-default-features --features engine-parakeet-tdt --test parakeet_tdt_e2e external_tdt_natural -- --ignored --nocapture
# Independent Python parity diagnostic; existing NumPy and ONNX Runtime required:
python native/tests/fixtures/parakeet-tdt/reference-greedy.py
```

The candidate remains opt-in behind `engine-parakeet-tdt`; production build scripts do not enable it. Preserving this experiment does not commit the project to maintaining or shipping the adapter.

Validation of the preserved code: all-engine plus experimental-feature Clippy passed with warnings denied; the library suite passed 365 tests with two ignored. The real short German recognition/word-timing test passed. The two natural-long diagnostics remain intentionally failing and are excluded from ordinary CI through explicit ignored-test markers.

A fresh source review found no blockers in recurrence/state ownership, graph contracts, reset, or timing bounds. The word times are model-derived estimates; bounds checks do not establish forced-alignment accuracy. The reviewer did not rerun inference.
