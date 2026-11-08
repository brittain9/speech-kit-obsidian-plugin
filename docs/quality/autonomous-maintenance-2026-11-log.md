# Autonomous maintenance run log

Guided by [the run spec](../specs/autonomous-maintenance-2026-11.md). This log tracks discovery, decisions, implementation, and validation. It is not a release announcement.

## Starting baseline

- Baseline main: `db75b7e`, after the initial maintenance PRs #492, #493, #496, #497, #498, #452, #457, #499, #500, #501, and #502.
- Initial-pass evidence and smoke steps: [maintenance report](maintenance-2026-11-08.md).
- Native QA uses Obsidian 1.15.0 and `~/Documents/test-vault`. Capture and optional recording were left off. QA notes are grouped in `Speech Kit QA 2026-11-08`.
- GitHub dependency and code-scanning alerts were zero at the start of this pass.
- A clean install exposed a Node/jsdom engine mismatch. A compatible jsdom downgrade was tested in an isolated branch, but remains unmerged while the supported-runtime/security review chooses the preferred solution.

## Findings and work queue

| ID  | Priority | Area                         | Finding or question                                                                                                           | Status and next action                                                                                                                                   | Evidence and outcome                                                                                                                                                      |
| --- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | High     | Supported runtime            | Node pin, declared support range, and jsdom engines do not agree. The existing Node pin also needs a security support review. | Security/runtime agent validating a maintained Node 24 release, strict installs, CI pins, and contributor instructions. Independent review before merge. | Original Node 24.14.1 strict install fails with `EBADENGINE` for jsdom 31. Isolated compatibility alternative passed 1,760 tests. Preferred runtime upgrade under review. |
| S02 | High     | Security                     | Confirm the best maintained versions for dependencies, build tools, and native libraries.                                     | Primary-source review and audits in progress. Address actionable findings and record scoped exceptions.                                                  | Starting GitHub alerts and npm audit: zero. Runtime support and compiler advisories require separate review.                                                              |
| R01 | Medium   | Speech models                | Which ASR additions offer useful quality, language, or resource gains with low integration cost?                              | ASR research agent checking exact artifacts and existing runtime contracts.                                                                              | Early candidates include smaller multilingual Whisper artifacts. Multilingual Moonshine exports require graph-contract validation; not catalog-only by assumption.        |
| R02 | Medium   | Voice and translation models | Which TTS or translation additions fit existing engines?                                                                      | Parallel primary-source research assigned.                                                                                                               | Compare against Pocket TTS, Supertonic 3, Firefox Translations, and HY-MT 2 before proposing additions.                                                                   |
| A01 | High     | Lifecycle and architecture   | Find implicit state machines, duplicated ownership, invalid state combinations, and fragile ordering rules.                   | Inventory actual states and resources; rank concrete failure modes before refactoring.                                                                   | Initial pass established real-editor nested-update regressions and fixes. Further audit must avoid repeating completed work.                                              |
| P01 | Medium   | Efficiency                   | Establish idle, active, and repeated-cycle resource baselines.                                                                | Collect bounded measurements with hardware/runtime/model context.                                                                                        | No battery-life claim or improvement target before a comparable baseline.                                                                                                 |
| Q01 | High     | Extended native QA           | Exercise common and adversarial workflows for longer sessions and interactions.                                               | Parent owns the Obsidian UI. Expand from the initial smoke matrix and record failures precisely.                                                         | Prior positive cases include typing/link paste, recording, German transcription, translation, and read aloud; cancellation and invalid audio were also checked.           |

## Run rules

- Each finding receives an explicit disposition: fixed, validated, proposed, rejected, or blocked with a concrete reason.
- Separate implementation, independent review, automated checks, native QA, and merge status.
- Keep primary-source model/security research in `docs/research/`; link it here when available.
- Do not turn every observation into a feature. Prefer measurable benefit and simple ownership.
- No releases, tags, or release version bumps. Issue #476 and correction-rules PR #459 remain outside scope.
