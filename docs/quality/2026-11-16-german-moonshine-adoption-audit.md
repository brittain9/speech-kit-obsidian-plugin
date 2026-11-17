# German Moonshine adoption audit

Neither candidate qualifies for the managed catalog. Both official August
streaming exports failed the existing 30% word-error ceiling on natural long
German speech. Keep their short-clip success and useful streaming behavior
separate from daily-dictation readiness. Catalog entries, defaults, and runtime
behavior are unchanged by this audit.

## Natural speech results

The same pinned, attributed public German FLEURS recordings used for Whisper
Small validation were decoded directly in 500 ms chunks and through actual
paced AppState/VAD/worker sessions. The latter uses Patient finalization and
real model inference. Each natural recording produced one final without native
session errors. The floor was not weakened.

| Export | Download                 | Natural clip  | Direct WER | Paced VAD WER |
| ------ | ------------------------ | ------------- | ---------- | ------------- |
| Tiny   | 32,317,004 bytes, cached | 1618, 26.58 s | 40.7%      | 29.6%         |
| Tiny   | same                     | 1617, 23.1 s  | 38.5%      | 57.7%         |
| Small  | 121,800,823 bytes        | 1618, 26.58 s | 44.4%      | 44.4%         |
| Small  | same                     | 1617, 23.1 s  | 30.8%      | 26.9%         |

These are two read-speech samples, not a general accuracy leaderboard. Scores
use the existing lowercase, punctuation-separated WER scorer; numeric formatting
and unit abbreviations are not normalized to semantic equivalents. No independent
native-speaker semantic review was performed. Failures
include changed names and omitted or substituted words, not lifecycle errors.
They justify keeping these exports out of this app's recommended catalog; they
do not prove every upstream model or other export has the same limitations.
Raw transcripts and observations are in the [audit data](2026-11-16-german-moonshine-adoption-observations.json).
The recording references, source revision, conversion, hashes, and CC BY 4.0
attribution remain in `native/tests/fixtures/long-german.json` and the notices.

## Bounded supported alternative

The [pinned official runtime catalog](https://github.com/moonshine-ai/moonshine/blob/d8d8fa29d05ca67441a7719e70099f9f48917a93/core/moonshine-model-catalog.cpp)
explicitly lists German Tiny and Small using `quantized_26_08_24`. Small uses the
same supported split layout and exact verified German tokenizer SHA-256. Its
configuration loads through the existing dynamic adapter without code changes.
The official catalog does not list a German Medium on this layout, so this audit
does not guess another export or rewrite the newer cached encoder.

Before weight transfer, the download plan recorded the approved 1 GB network /
3 GB disk ceiling and the eight expected files totaling 121,800,823 bytes.
All files matched the pinned vendor CRC32C metadata and sizes; measured SHA-256
pins are preserved in the [test-only Small metadata](../../native/tests/fixtures/moonshine/german-small-experimental.json).
The model was downloaded once; two small config/tokenizer previews add 103,831
bytes. Small source/metadata requests are additional. No other model weights
were downloaded. Tiny reused the verified cache. No new executable tool or
runtime was installed.

The compact downloads and partial output are useful reasons to investigate, but
these quality results do not support adoption. Managed Small installation and
matched resource measurements were therefore not pursued. Timing fields in the
raw observations are diagnostic, not comparative performance claims: the Mac was
shared, and Tiny pacing overlapped artifact integrity work.

## Lifecycle and compatibility

- Finalization clears partial state between the two direct recordings for both exports.
- Small's actual paced VAD session emitted two correct short-phrase finals, separated by silence, with no stale phrase content.
- Small's actual probe reports only German; AppState rejects an English start before creating a session.
- Tiny and Small cancellation followed by silent restart passed.
- The existing installed monolithic English adapter fixture regression passed. This preserves import compatibility; it does not certify a fresh catalog-pinned English download.

No managed-install success is claimed for Small. Tiny's earlier managed checks
remain in the original experiment record. No native Obsidian, acceleration,
other-platform, or battery result is claimed here.

## Reproduce

Set `MOONSHINE_GERMAN_MODEL_PATH` to the verified export's `frontend.model.ort`.
The two natural-speech diagnostics intentionally remain failing and ignored:

```sh
cargo test --manifest-path native/Cargo.toml --no-default-features \
  --features engine-moonshine --test moonshine_german_e2e \
  german_natural_long_recordings -- --ignored --nocapture --test-threads=1
```

`german_multiple_phrases_preserve_session_and_language_contract` covers the
separate passing short-phrase/language contract. The existing
`german_worker_cancellation_allows_a_clean_silent_restart` covers cancellation.
The changed diagnostic target compiles; its ordinary check passed with nine
model diagnostics ignored. The existing selected-feature library suite passed
329 tests with two ignored. Formatting and the eight stored Small SHA-256/size
pins passed. Independent source/evidence review found no blocking findings.

No package release, shipping catalog addition, or default change follows from
this audit.
