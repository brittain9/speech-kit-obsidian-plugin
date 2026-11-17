# CI and model criteria audit

Audited 2026-11-17 against main `20727202`, workflow sources, test sources, and
GitHub's active ruleset API. This distinguishes enforced checks from exploratory
model observations; it does not change thresholds or publish a release.

## What blocks a pull request

The active `protect-main` ruleset requires `frontend-quality` only. Classic branch
protection returns 404 because protection is provided by the ruleset. The required
job checks release metadata, TypeScript, lint, tests, build, and frontend output.
The separate Linux `sidecar-quality` job builds the native binaries, runs Rust
formatting, Clippy and tests, and exercises the production client protocol. Platform
lanes run on main or manual dispatch. None of these jobs downloads speech models
or runs ignored real-model accuracy tests. CodeQL remains independent.

No required accuracy or speed check was found. No protection, security, lifecycle,
build, or scoring rule was loosened by this audit.

## What the manual suites measure

`sidecar-e2e.yml` and `multilingual-quality.yml` have only `workflow_dispatch`
triggers, following commit `153be1d9` (manual certifications). Their successful or
failed results are evidence for the models they actually invoke, not automatic
catalog-wide eligibility decisions.

- English Whisper uses the checked-in corpus and fixture-specific WER budgets,
  with a real-time-factor ceiling of 1 on its CPU path.
- The multilingual suite explicitly selects Nemotron 3.5 and Whisper Large V3
  Turbo. It reads nine non-English fixtures plus one English regression fixture,
  one clip per language, in manual and automatic selection modes. Nemotron cases
  are filtered by that model's catalog language coverage. Adding another model
  does not add it to this matrix.
- Its 45% non-English WER/Japanese CER limits originate in `4c41741c`; the 20%
  English limit in `05dd9b7d`. Serbian additionally checks Cyrillic share. These
  are historical fixture regression budgets, not published general-accuracy
  guarantees or a user-specified requirement for every optional model.
- Nemotron's CPU RTF limit is 1. Whisper Turbo instead has 45-second manual and
  75-second automatic processing ceilings (`049fcb3b`), explicitly accommodating
  its GPU-oriented use and the extra language-detection pass. CPU measurements
  do not establish performance on accelerated desktops.
- Pocket TTS has a separate six-language round-trip/throughput certification;
  the ASR model used to score its synthesized audio also influences that result.

These small pinned corpora catch regressions but cannot establish broad language,
accent, domain, speaker, or long-session accuracy. The shared WER scorer lowercases
and tokenizes alphanumeric text; it does not equate written numbers with digits,
unit abbreviations with words, or semantically equivalent sentences.

## Optional model decisions and retained evidence

The German Moonshine audit's 30% screen was a provisional exploration heuristic,
not an Actions gate or universal adoption requirement. Its raw results remain
unchanged. A useful optional model can trade accuracy for latency, resource use,
offline availability, or another concrete benefit. Evaluate those observations
alongside actual language behavior and practical user value. Exact provenance,
artifact integrity, loading, cancellation, recovery, and resource ownership remain
correctness requirements. No arbitrary common WER or speed cutoff was introduced.

## Diagnostics fix

Manual workflows already upload measurements with `if: always()`. Missing
measurements deliberately fail upload, distinguishing setup failure from a
measured result. Their report steps may also fail when setup produced no data;
the original failed step remains visible in Actions.

The local `npm run report:transcription-quality` command had a narrower bug: a
suite could write failed measurements and then exit nonzero, preventing readable
report generation. It now attempts to render the measurements already collected
before rethrowing the original suite failure. It still stops before later suites
to avoid launching further downloads/inference after a build or runtime failure.
An absent or malformed report cannot replace the original failure. Public command
tests reproduce measured failure and startup failure without downloading models.
