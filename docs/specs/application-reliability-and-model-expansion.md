# Speech Kit reliability, model expansion, and product polish

Status: implementation handoff, 2026-11-16. Source baseline: `138f865`.

## Outcome

Improve daily Speech Kit use through focused fixes, real Obsidian checks, more
useful speech-to-text choices, and consistent, polished controls. Work from
observed failures and measured opportunities. The first concrete issue is
[#540](https://github.com/brittain9/speech-kit-obsidian-plugin/issues/540).
The other immediate investigation is discovering dictation controls when the
sidebar is visible in an existing vault but absent in a fresh vault.

This is the next maintenance pass after
[the earlier maintenance spec](autonomous-maintenance-2026-11.md). Reuse its
completed work and evidence. This document defines the current priorities and
acceptance criteria; it does not claim any proposed change is implemented.

This branch is also a place for reversible exploration. Prototype useful UI,
workflow, and model ideas, compare alternatives, and retain or remove experiments
based on evidence and owner feedback. An experiment does not imply a release
commitment. Keep experiments identifiable and easy to revert; distinguish
prototypes from verified behavior in the handoff.

## Operating scope and laptop setup

- Run implementation and computer-use QA on the Mac. Use only
  `~/Documents/test-vault` for vault testing. Do not inspect the personal vault
  named **Obsidian Vault**. Create synthetic notes and use public audio fixtures.
- Inspect the actual checkout, installed Obsidian/plugin build, toolchains,
  models, and existing work before starting. Use the repository's pinned
  environment and a clean lockfile install. Do not infer installed dependency
  versions from `package.json` alone.
- Preserve unrelated changes. The originating workstation has uncommitted Node
  configuration/documentation changes and an untracked personalized-VAD research
  document. They are excluded from this spec commit. Do not assume they are
  present on the laptop or reconstruct them as part of an unrelated fix.
- Use focused branches/PRs and the existing findings log in `docs/quality/`.
  Continue reversible fixes, testing, review, and ordinary PR work autonomously.
  Involve the owner for consequential product choices, material security/data
  risks, paid resources, or difficult recovery. Do not create a release, release
  tag, or release version bump during this pass.
- Keep issue #476 and correction-rules PR #459 outside this pass. The owner
  subsequently authorized Qwen3-ASR implementation, including necessary backend
  work and exploration of streaming. This supersedes the earlier Qwen exclusion.
- The Linux workstation remains in normal use. Do not take over its desktop,
  change audio routing, install a build there, or start recording remotely as
  part of the Mac run without coordinating that check. A Mac result cannot close
  a Linux-only finding.

## Priority and execution order

| Order   | Work                                                               | Completion evidence                                                                         |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1       | Fix #540 and explore fresh-vault dictation discovery               | Reproduced user flow, alternatives, regression coverage, native QA; platform limits tracked |
| 2       | Exercise the production TypeScript client against the real sidecar | Model-free integration test in normal CI, bounded failure and teardown cases                |
| 3       | Lock down the shared wire contract                                 | Shared fixtures validated by both implementations                                           |
| 4       | Simplify lifecycle ownership where failures justify it             | Adversarial event tests plus unchanged note/output guarantees                               |
| 5       | Expand speech-to-text capabilities                                 | Refreshed research, working adapters, measured product-path results                         |
| Ongoing | Improve usability, visual quality, and resource use                | Before/after evidence and successful real workflows                                         |

Fix confirmed data loss, security problems, hangs, and leaks ahead of this order.
Do not postpone a small, well-understood user fix behind an architectural rewrite.
Research can proceed alongside fixes; keep model downloads and experiments bounded.

## 1. YouTube import during dictation: #540

Read the issue again before implementation. Reproduce the modal flow in native
Obsidian and identify which busy guard fires. Relevant starting points are
`src/ui/youtube-transcript-modal.ts`,
`src/dictation/audio-file-transcription-controller.ts`, and
`src/media/youtube-captions.ts`.

Treat fetching captions separately from speech inference. Support caption import
while dictating if both operations can preserve their original note targets and
independent cancellation. Determine insertion ordering explicitly when both write
to the same note. Do not assume a second model can run safely in parallel merely
because caption retrieval can.

Acceptance:

- Active microphone dictation, another media job, engine maintenance, and an
  actual failure produce distinct, accurate feedback.
- Captions available and captions unavailable/audio fallback are both exercised.
  Caption acquisition does not silently stop dictation or acquire unnecessary
  inference ownership.
- When work must wait, identify the blocking activity and an actionable next
  step. Preserve typed and dictated text. An explicit stop-and-continue action
  must drain accepted speech before continuing. Introduce a queue only if its
  ownership, cancellation, and visible status earn the added complexity.
- Repeated submission, modal close/reopen, stop/cancel, note navigation, and late
  results cannot duplicate output or insert into an unintended note.
- Write a failing test through the closest practical workflow interface before
  changing behavior. Verify the final visible flow in Obsidian, beyond copy tests.

## 2. Fresh-vault sidebar and dictation discovery

On 2026-11-16 the owner reported that the sidebar was visible in an existing
Obsidian vault but absent in a newly created test vault on Linux/Omarchy. They
could not see a clear way to start speech. Assigning Alt+Q to Toggle dictation
allowed dictation to start and stop successfully.

Treat this as a discoverability problem to explore. The exact Obsidian/Electron
versions and which surface was missing were not captured. Compare the two vault
configurations using only an authorized test environment; do not inspect personal
vault contents. Distinguish the Obsidian ribbon, a collapsed application sidebar,
and the Speech Kit view before attributing the difference to the platform,
workspace configuration, theme, or plugin.

Starting points are ribbon registration and view-opening commands in
`src/main.ts`, `src/ui/dictation-ribbon.ts`, and
`src/ui/local-dictation-view.ts`.

Explore a few concrete alternatives: a clear Open Speech Kit action after setup,
contextual guidance when controls are hidden, and better command/settings
discovery. Prototype the promising alternatives in the test vault and show their
effect on first use, repeat use, and a deliberately hidden sidebar. These are
options to evaluate, not predetermined new settings or a required redesign.

Acceptance for a retained change:

- A fresh-vault user can discover how to start/stop dictation and open the Speech
  Kit view, including when Obsidian's ribbon or sidebars are hidden.
- Existing commands and keyboard access remain usable. Alt+Q was a user-selected
  workaround, not a requested default binding.
- Respect user workspace visibility preferences. Avoid repeatedly reopening a
  view the user deliberately closed. Make any first-use opening behavior explicit.
- Verify default, hidden-ribbon/collapsed-sidebar, and narrow layouts in native
  Obsidian. Record Mac results separately from the reported Linux environment.
- Record which alternatives were kept, removed, or left experimental and why.

## 3. Production TypeScript-to-Rust integration

Existing tests cover protocol pieces, a simulated process in
`test/sidecar-connection.test.ts`, and the real executable from Rust in
`native/tests/sidecar_protocol_e2e.rs`. Add the missing composition: production
TypeScript connection, encoder/parser, process adapter, and actual Rust executable.
Existing model scripts with their own framing are useful inference checks but
do not substitute for that production-client test.

Start with model-free startup/system information, orderly shutdown, and process
exit while work is pending. Add a deterministic invalid request and teardown case
where supported. Use real client operations when public interfaces support them;
test malformed wire bytes at the transport seam rather than expanding the
production interface for tests.

Acceptance:

- Ordinary PR CI builds the binary and runs the integration without model
  downloads, microphone access, or a live Obsidian session.
- A deliberate client/server wire mismatch makes the check fail with a useful
  diagnosis. Establish the failing check before implementation.
- Every wait has a test deadline; failures close streams and reap the child.
  Expected shutdown and unexpected exit have correct, distinct outcomes.
- Reuse the existing native CI build/cache. Avoid duplicate full engine builds.
  Document one local command and the binary path/build prerequisites. Linux PR CI
  is the first gate; verify platform-specific process changes on Mac and Windows.

## 4. Shared wire contract fixtures

Add a small repository-owned corpus consumed by TypeScript and Rust tests.
Specify the expected accepted shape or rejection for each fixture. Cover
representative session/translation commands and events, binary audio envelopes,
optional/defaulted fields, unknown fields, malformed/truncated frames, size
limits, and fragmented/coalesced input where the respective interfaces support it.

Separate semantic JSON expectations from byte-level frame expectations; object
key order is not a compatibility requirement. Keep intentional asymmetries
explicit. Use fixtures in each direction so serializers and parsers cannot drift
together unnoticed. Include negative cases and existing compatibility behavior.

Keep ADR 0007 and `scripts/verify-sidecar-compatibility.mjs` authoritative for
release policy. Tests supplement that policy. Review its path list when modules
move; changes under new sender/parser paths must not bypass the release guard.
Start with fixtures. Introduce schema/type generation only if a demonstrated
maintenance problem justifies its tooling and migration cost.

## 5. Ownership of translation and dictation work

First read the existing
[capture](../quality/2026-11-capture-lifecycle-audit.md) and
[translation](../quality/2026-11-translation-lifecycle-audit.md) audits. Several
ownership fixes already exist. Reproduce remaining problems before refactoring.

Translation has two real adapters: Bergamot Web Worker and HY-MT native helper.
Each operation should hide its subscriptions, worker/process callbacks,
cancellation, and owned resources behind a small interface.

- One user-visible terminal outcome; late progress/results cannot revive it.
- UI cancellation and confirmed backend termination are distinct. HY-MT already
  retains its use lease while native work may remain. Preserve that guarantee.
- A cancellation write failure or missing acknowledgement must not appear as
  confirmed native termination. Report the blocked state and a safe recovery
  action. Never release ownership early or silently kill unrelated shared work.
- Completion, cancellation acknowledgement, startup unwind, process failure,
  disposal, and cancellation during startup have explicit cleanup guarantees.

For dictation, inventory existing owners and legal transitions before changing
`DictationSessionController`. Isolate only the lifecycle decisions/resources whose
coordination is causing demonstrated problems. Preserve capture ownership,
transcript revision ordering, manual-edit protection, drain behavior, recovery,
and recording placement. Avoid a generic job framework or global state-machine
rewrite. Public-interface tests must cover stop during startup, rapid restart,
late results, cancellation during processing, and sidecar exit.

## 6. More speech-to-text models

Refresh [the existing ASR research](../research/2026-11-asr-model-opportunities.md)
against the current catalog and primary upstream sources. Earlier rankings and
availability are historical evidence, not a current adoption decision. Avoid
re-adding models already supported by the checked-out code.

The owner wants additional useful speech-to-text options and accepts necessary
backend work. Do not restrict the shortlist to catalog-only additions. Compare
compact multilingual batch models, additional streaming languages/profiles,
and models requiring a new adapter/runtime when they provide a distinct benefit.
Use the evidence to decide which candidates provide useful tradeoffs; research
alone is not the desired endpoint. A justified native adapter/helper is in scope.
Record material runtime choices in an ADR before they become the foundation.

For each serious candidate record the user need, supported languages, true
streaming/batch behavior, exact assets/tokenizer/frontend, compatible runtime,
license/notices, artifact provenance and hashes, download size, measured memory,
CPU/Metal/CUDA feasibility, integration work, and unresolved risks. Do not infer
compatibility from ONNX/GGUF extensions or reuse text-only helpers for audio
without implementing the required audio architecture.

Validate the strongest candidate end to end before downloading a whole family.
Set and record a finite disk/download/experiment budget first; escalate paid or
materially costly resources. Use representative public speech, silence, short
utterances, long input, reset, cancellation, and repeated sessions. Compare with
an existing suitable model under matched conditions. Measure accuracy (WER/CER
as appropriate), first useful output, finalization delay, throughput, and peak
memory. Preserve earlier benchmark waivers only for the explicitly named prior
additions. New additions need their own evidence.

Owner clarification during this pass: accuracy and speed thresholds are evaluation
aids, not universal adoption vetoes. Older tests, normalization rules, specifications,
and GitHub Actions may be outdated or poorly designed. Review their purpose and
provenance before applying them to a new model. Preserve raw measurements and
compare candidates under matched conditions; distinguish formatting differences
from missing or incorrect speech. Useful language coverage, resource needs, and
workflow tradeoffs can justify an optional model with documented limitations.
Build failures, process leaks, hangs, or unsafe note handling remain concrete
integration defects to resolve. Review GitHub Actions policy in the next pass;
do not silently remove checks merely to get a green result.

Acceptance: managed install/probe/selection/removal and real transcription work;
capabilities and language choices match actual behavior; native Obsidian QA
passes; required notices and platform limits are documented. A model is not
production-ready solely because an isolated script transcribes one fixture.

## 7. Computer-use product QA and visual polish

Exercise actual tasks in native Obsidian: first-run setup, model discovery and
installation, daily dictation while typing/pasting, file transcription, YouTube
import, translation preview/apply, and read aloud. Include missing models,
permissions/errors, cancellation/retry, note changes, concurrent work, reload,
and repeated use. Keep one owner of the shared QA desktop.

Improve demonstrated friction as it is found. Match Obsidian's theme, typography,
spacing, native controls, attachment behavior, and existing Speech Kit styling.
Check light/dark themes, normal/narrow widths, long labels, keyboard navigation,
focus restoration, readable contrast, and all important loading/empty/error/
disabled states. Explain active work and output destinations clearly.

Capture before/after screenshots from synthetic notes for material visual fixes.
Use visual alternatives/annotations when a meaningful design decision benefits
from review. Routine spacing, clipping, focus, copy, and consistency fixes can
proceed directly. Preserve model selection, preview-before-edit, localization,
and safe note insertion. Avoid adding controls without a concrete daily use.

## 8. Runtime cost and diagnostic evidence

Use existing logging and QA tools. Measure startup, first partial, stop-to-final
transcript, cancellation/backend termination, idle cost, and repeated-operation
resource retention. Record hardware, build/model versions, warm/cold state,
fixture, and repetitions. Select regression thresholds after the baseline and
before optimizing. Distinguish CPU/memory observations from battery claims.

When current logs cannot explain a failure, add bounded opt-in timing and
operation identifiers. Keep notes, transcripts, microphone audio, credentials,
and identifying device details out of routine diagnostics and committed evidence.
Do not replace the existing deliberate suppression of routine protocol logs
with always-on event dumps. Fix measured problems; instrumentation is not itself
proof of a user-visible improvement.

## Verification, review, and completion

For every behavior change, first write and run a failing check through the
closest practical real-user interface. Fix in small slices, run affected checks,
and exercise the outcome in native Obsidian. Use `npm run check:frontend` for
frontend gates and the existing Rust/build/protocol checks for native changes.
Keep heavy real-model validation bounded and record what actually ran.

Give substantial changes a fresh holistic review, resolve routine findings,
then verify affected interactions in the combined build. Review note safety,
async ownership, compatibility, background resources, accessibility, and failure
recovery together. Keep unrelated cleanup out of each fix.

Update the existing maintenance log with finding, evidence, priority, branch/PR,
checks, native result, platform limits, and disposition. Store new research in
`docs/research/` and sanitized QA evidence in `docs/quality/`. Link issue #540 to
its fix; keep platform-specific sidebar observations distinct from Mac QA.

Finish with the exact tested build installed in the test vault, capture and
recording off, temporary settings restored, no abandoned helper processes, and
a short brief linking changes, evidence, unresolved work, and a smoke-test route.
Mark outcomes as observed, inferred, proposed, or unverified. Continue useful
independent work when one item needs owner input; do not call a blocked item done.
