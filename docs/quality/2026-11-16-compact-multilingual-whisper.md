# Compact multilingual Whisper validation

## Result

Add **Whisper Small Multilingual** as an optional 190,085,487-byte managed model,
alongside the existing English-only Small and multilingual Turbo selections.
This is a compact resource choice with measured accuracy tradeoffs. Existing
model IDs, selections, and default settings remain unchanged. No release or
package version bump was made; only the catalog revision advances.

The pinned Small download is 684,102,588 bytes (78.3%) smaller than the installed
Turbo Q8_0 artifact. The existing Whisper runtime supplies CPU and platform
acceleration paths. This pass directly validated CPU execution on the Mac;
native Obsidian and Metal/CUDA/other-platform checks are listed separately below.

## Evidence

- The catalog-selection regression failed before the model entry and passed
  afterward. The exact official artifact size and SHA-256 were independently
  checked before activation.
- A fresh real-vendor download through the production installer completed;
  managed probe, German manual selection, automatic German detection, silence,
  cancellation, and removal passed through `AppState` and the real worker.
- A final installer replay used the same verified local weights over a temporary
  loopback endpoint, preserving the production size/hash checks and model probe.
  It additionally exercised a natural 23.1 s German recording. The replay helper
  was stopped after the test.
- All ten existing language-fixture floors passed: English WER ≤20%, remaining
  WER/CER ≤45%, with the existing Serbian transliteration scoring and ≥80%
  Cyrillic-output guard. German automatic detection returned German.
- Two additional natural German readings, 23.1 s and 26.58 s, passed the same
  quality floor. Their source, official references, conversion, and hashes are
  in `native/tests/fixtures/long-german.json`; CC BY 4.0 attribution is retained.
- Frontend type checks, both linters, 1,931 tests (10 skipped), and production
  frontend build passed under Node 24.22.2 with the clean locked dependency
  install. All-engine Rust formatting, Clippy with warnings denied, and tests
  passed under Rust 1.94.1. Heavy real-model cases are explicit opt-in tests.

## Matched local observations

The same CPU-only integration binary ran the same pinned language fixtures for
Small and the installed Turbo Q8_0 model. The final pair used fresh model loads
and warm filesystem caches after repository gates completed. Heavy local builds
and inference were paused for that pair, but ordinary OS activity was not
controlled. Hardware: Apple M2 Pro, 16 GB RAM, macOS 27.2.1; production thread
policy caps CPU inference at eight threads. These are observations from a small
public corpus, not universal speed, accuracy, memory, or battery claims.

| Observation                           | Small Q5_1 | Turbo Q8_0 |
| ------------------------------------- | ---------- | ---------- |
| German short-clip WER                 | 0%         | 0%         |
| Natural 23.1 s German WER             | 19.2%      | 15.4%      |
| Natural 26.58 s German WER            | 25.9%      | 14.8%      |
| Dutch short-clip WER                  | 11.1%      | 0%         |
| Croatian short-clip WER               | 33.3%      | 0%         |
| Serbian short-clip WER                | 36.4%      | 9.1%       |
| Short German compute time, final pair | 0.70 s     | 3.60 s     |
| Whole-process peak RSS, final pair    | 716 MB     | 1,561 MB   |

Full per-case measurements, including automatic detection and English, are in
[the machine-readable observations](2026-11-16-compact-whisper-measurements.json).
Batch output arrives after recognition; neither choice is a streaming model.

The separate stress test that concatenates the identical 5.4 s clip six times
fails for both models: Small 66.7% WER and Turbo 77.3%. Both suppress repeated
audio in this synthetic 32.4 s input. This known negative result remains an
explicit diagnostic test; it is distinct from the passing natural long-speech
checks and is not hidden by changing its quality threshold.

## Reproduce and native smoke route

```sh
STT_COMPARE_MODEL=/path/to/ggml-small-q5_1.bin \
cargo test --manifest-path native/Cargo.toml --test compact_whisper_e2e \
  compact_multilingual_whisper_quality_and_resources -- --ignored --nocapture

cargo test --manifest-path native/Cargo.toml --test compact_whisper_e2e \
  compact_whisper_managed_install_detects_transcribes_cancels_and_removes \
  -- --ignored --nocapture
```

The second command downloads the catalog's 190 MB model unless
`STT_TEST_MODEL_DOWNLOAD_URL` explicitly points to a local replay of the same
hash-pinned bytes. The repeated-audio diagnostic is named
`compact_whisper_repeated_audio_stress` and currently fails on both snapshots.

Native Obsidian QA remains pending: in the authorized test vault, open Speech
Kit's model manager, install/select Small Multilingual, transcribe the public
German short and long WAV fixtures into a synthetic note, retry automatic
language detection, cancel a job, and confirm the original note and previous
model choices remain available. Verify the narrow model-picker label too.
Metal, CUDA, Linux, Windows, and hours-long sustained use were not tested here.
