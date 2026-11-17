# German Moonshine external-import experiment

## Disposition

Experimental external import only. German Tiny is **not in the shipping managed
catalog**. Its small download and quick first output are useful, but the measured
unsegmented long-utterance failures do not justify recommending it for daily
dictation. Keep the existing German Nemotron/Whisper choices available.

The adapter now supports official split frontend weights, the decoder variant
without unused cross-cache echoes, full graph validation during probe, and
model-specific language validation. Monolithic English imports retain their
existing language contract. Unverified split tokenizers fail probe and load with
a clear invalid-model diagnostic.

## Provenance and resource bound

See [source research](../research/2026-11-16-moonshine-german-streaming.md).
The runtime-matched complete official `quantized_26_08_24` export is 32,317,004
bytes; every measured SHA-256 and URL is in the test-only
[candidate metadata](../../native/tests/fixtures/moonshine/german-tiny-experimental.json).
The newer November mirror's cached encoder is rejected rather than silently
misinterpreted. No files are mixed across exports.

The first two complete exports used 64.5 MB of model assets. Fresh installer
checks repeat the same 32.3 MB candidate transfer; total stays below the initial
1 GB investigation allowance. No other new model was downloaded for this
experiment. The comparison reuses the installed Nemotron 560 ms model.

## Observed behavior

Mac: Apple M2 Pro, 16 GB RAM, macOS 27.2.1. CPU-only ONNX Runtime through the
repository's pinned Rust dependencies. Public checked-in German FLEURS sentence
1577, 5.4 seconds, CC BY 4.0; its reference and provenance are in
`native/tests/fixtures/multilingual.json`. Repeating that same clip is a stress
case, not representative natural continuous speech. These are descriptive local
observations on a shared computer, not a controlled accuracy or battery study.

| Check                                   | Observed result                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fresh installer and model probe         | Complete, SHA-256-verified eight-file install; ready probe                                                        |
| Production VAD/worker short clip        | Eight partials; exact reference words in the final; 280 ms cumulative reported processing                         |
| Direct adapter short clip               | 9.1% WER, an extra final word; roughly 0.25–0.26 s computation                                                    |
| First useful partial, direct short clip | Moonshine 1.0 s of accepted audio, Nemotron 2.5 s; no real-time pacing in this computation measurement            |
| Direct 27 s, five repeated clips        | Moonshine 30.9% WER; repeats extra clauses; failed the exploratory 30% floor                                      |
| Direct 32.4 s, six repeated clips       | Moonshine 207.6% WER, Nemotron 0%; this also exceeds the product's 30 s per-utterance cap                         |
| Actual Patient-VAD 32.4 s recording     | 33.24 s paced test; two final utterances, 9.1% WER, no errors; the cap contains but does not eliminate extra text |
| Silence through production VAD          | No partial or final speech output                                                                                 |
| Direct neural model on zeros            | Hallucinates `Vielen Dank.`; silence safety depends on the existing VAD path                                      |
| Cancellation and silent restart         | Clean stop and restart, no stale speech output                                                                    |
| Mutated unrecognized split tokenizer    | Invalid probe; English fallback start rejected before graph loading                                               |
| Existing English monolithic Tiny        | Existing real-fixture streaming/finalization regression passed                                                    |

The standalone long-stress process peaked around 1.21 GB for Moonshine and
1.32 GB for Nemotron. These include test-process/runtime allocations and long
decoding. They do not establish normal Obsidian memory savings. Short-only matched
resource observations are recorded separately when available.

Short-only matched observations used three alternating fresh processes per
family, warm filesystem caches, the same 5.4 s clip, CPU-only adapters, and the
same debug test binary. They include one model load and per-0.5 s partial decode;
audio was supplied faster than real time. `/usr/bin/time -l` measured each whole
test process. Background work on the Mac was not controlled.

| Short-only observation               | German Tiny  | Installed Nemotron 560 ms |
| ------------------------------------ | ------------ | ------------------------- |
| WER, all three runs                  | 9.1%         | 0%                        |
| First useful partial, accepted audio | 1.0 s        | 2.5 s                     |
| First useful partial, computation    | 16.9–17.9 ms | 395–401 ms                |
| Model load                           | 81–94 ms     | 730–816 ms                |
| Finalization                         | 34–35 ms     | 53.8–54.1 ms              |
| Real-time factor                     | 0.049–0.050  | 0.170–0.172               |
| Whole-process peak RSS               | 149–156 MB   | 1,209–1,330 MB            |

This supports further exploration of a compact German path, while the separate
long-utterance failures remain a reason to keep it out of the shipping catalog.

## Reproduce

The export is intentionally external. Use `frontend.model.ort` as the entry and
keep all eight exact files together. There is no model auto-download on app startup.

```sh
MOONSHINE_GERMAN_MODEL_PATH=/path/to/frontend.model.ort \
cargo test --manifest-path native/Cargo.toml --no-default-features \
  --features engine-moonshine --test moonshine_german_e2e \
  german_split_frontend_streams_finalizes_and_resets -- --ignored --nocapture
```

The same test binary has explicit install/probe, cancellation, unknown-tokenizer,
Patient-VAD long-recording, and resource-comparison cases. Resource comparison
requires `STT_COMPARE_FAMILY=moonshine|nemotron_asr` and `STT_COMPARE_MODEL`; it runs
the short fixture by default. `STT_COMPARE_LONG_REPEATS=5` or `6` reproduces the
known failing raw-utterance quality gates. Keep those failures visible.

Native Obsidian verification of the experimental German import remains pending.
No package release, release tag, or version bump was made.

## Independent probe-contract review

The first implementation advertised an unrecognized split tokenizer as ready
with unknown language support, while runtime language selection rejected every
language. An authoritative `AppState` probe regression reproduced that false
ready result. Probe and load now reject unverified split exports before loading
graphs or frontend weights. The shared unknown-language policy is unchanged.

The mutated real-artifact probe/start regression, a model-free early-rejection
test, the known German short-stream/finalize/reset test, and the existing English
monolithic adapter fixture test pass. The catalog-verified English suite rejected
the older installed Tiny artifact before inference because its hash differs from
the current catalog pin; that suite was not exercised against a fresh download.
This correction does not address the documented long-utterance quality failures
or expand the shipping catalog.
