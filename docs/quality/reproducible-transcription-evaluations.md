# Reproducible transcription evidence

The manual speech suites exercise the actual AppState, VAD, worker, adapter and
transcript-event path. Their results are fixture regression evidence, not a
universal accuracy or speed requirement for every optional model. Loading,
cancellation, recovery and preservation of accepted text remain correctness
requirements tested separately. A model can offer useful latency, resource or
language tradeoffs without winning every accuracy fixture.

## What new runs retain

The English Whisper, multilingual Whisper/Nemotron and Nemotron streaming suites
write schema 2 JSONL when `STT_QUALITY_REPORT_PATH` is set. Each measured case
retains its original metric and budget, plus:

- Verbatim reference and recognized text, separate from the exact scoring text.
  Existing lowercase/alphanumeric tokenization stays unchanged. Japanese uses
  character scoring; Serbian's explicit Latin transliteration is recorded.
  Digits, spelled numbers and unit abbreviations are not silently equated.
- A fixture manifest path and audio SHA-256. The referenced manifests retain
  dataset revisions, licensing and attribution; retain the source commit too.
  Each producer verifies the actual audio bytes before decoding or inference,
  including runs selecting only ignored model tests. A changed fixture fails
  input verification instead of inheriting the nominal manifest identity.
- Catalog source/license and required artifact pins alongside hashes and sizes
  actually read from the local model. Local overrides are not silently assigned
  the catalog's artifact identity. Artifact hashing happens once per model,
  outside the measured engine duration, and can warm filesystem caches.
- Whether the session stopped and the engine errors it emitted. Absence of a
  measured case after a build/load failure is not a passing result.

The reader recomputes WER/CER from the retained scoring text and rejects an
inconsistent score. It does not rescore old schema 1 records or reconstruct text
that those records never retained. Historical JSONL and committed measurements
remain unchanged. A legacy record is clearly identified as lacking this evidence.

## Capture and render

For the existing serial, CPU-requested local evaluation command:

```sh
npm run report:transcription-quality
```

This runs the existing model-backed suites and can download their pinned models.
It captures host context once, preserves raw JSONL, and renders collected cases
even if a suite later fails. The command still exits nonzero and stops before
later suites after a failure. For model-free reconstruction of an existing run:

```sh
node scripts/transcription-quality-report.mjs \
  --render-only artifacts/quality \
  --environment artifacts/evaluation-environment.json \
  --output-dir artifacts/rendered-quality
```

Render-only never probes a GPU or invents inference-host metadata from the
rendering machine. For combined CI results, each `name.jsonl` can carry a sibling
`name.environment.json`; measurements remain linked to their own job's context.
The manually dispatched ASR workflows capture and upload those sidecars. Their
triggers, model matrix, thresholds and required CI checks are unchanged.
If a job captures context but fails before writing measurements, the combined
report retains that context and explicitly lists the missing measurement file.
It does not fill the gap with a passing result or a fabricated score.

See [hardware context](evaluation-hardware.md) for measured host fields and the
limits of declared execution settings. Requested CPU/GPU, effective device use,
inference threads, model residency, and filesystem cache state are different
facts. Unobserved values stay unknown. Core counts and a Metal-capable machine do
not establish inference thread count or successful GPU offload.

## Interpreting timing and coverage

Processing duration sums engine `processingDurationMs` events. RTF divides that
by fixture audio duration; it is not an end-to-end user latency measurement.
First-partial audio position measures received audio, not elapsed wall time.
Reports do not claim a cold model or cold storage unless supported separately.
Concurrent workload, artifact verification and filesystem cache effects limit
cross-run speed comparisons.

These manual matrices remain explicit, small corpora. Adding a model to the
shipping catalog does not automatically add it to every matrix, and short read
speech does not establish conversational, accent, diarization or long-session
quality. Qwen comparisons and their direct-adapter observations remain in their
dated evidence notes; this change does not relabel them as AppState runs or add
a parallel benchmark framework. Expand product-path cases when a concrete
model or workflow question needs them, retaining outputs and context rather than
turning a provisional WER cutoff into a universal adoption veto.

## Reporting smoke, 17 November

An actual cached Whisper Tiny CPU-requested run exercised all eight existing
English fixtures (75.555 seconds of audio) through AppState/VAD/worker. All eight
fixture checks passed and all sessions stopped. Schema 2 output passed the new
reader's independent score reconstruction; actual model hash and size matched
the catalog. The recorded context reports the real Apple M2 Pro host, requested
CPU and unobserved effective acceleration, with concurrent host load and a dirty
tracked checkout. This was an end-to-end reporting check, not a controlled speed
or broad accuracy comparison. Native test execution took 10.13 seconds.

Retained [raw cases](2026-11-17-whisper-tiny-evaluation.jsonl) and
[captured environment](2026-11-17-whisper-tiny-evaluation.environment.json)
contain public-fixture text and artifact identities. The native producer was
compiled from the reporting slice at `cb946326`; subsequent reporting fixes did
not change the scored outputs. The smoke preceded the new mandatory input-hash
guard; a separate check confirmed all eight retained fixture hashes against the
actual bytes, without rewriting the captured results. Re-render without inference:

```sh
quality_input=$(mktemp -d)
cp docs/quality/2026-11-17-whisper-tiny-evaluation.jsonl \
  docs/quality/2026-11-17-whisper-tiny-evaluation.environment.json "$quality_input/"
node scripts/transcription-quality-report.mjs --render-only "$quality_input" \
  --output-dir "$quality_input/report"
```

Reproduction of inference uses the existing `transcription_e2e` suite with
`STT_TEST_WHISPER_MODEL` pointing at the verified cached model and
`STT_QUALITY_REPORT_PATH` pointing at a new output file. No model was downloaded
for this reporting smoke.
