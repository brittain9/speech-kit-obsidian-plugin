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
