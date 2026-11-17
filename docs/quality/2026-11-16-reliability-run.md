# Architecture, UX, and model expansion run — November 16, 2026

This exploratory pass follows [the current spec](../specs/application-reliability-and-model-expansion.md).
The owner requested substantial improvements across architecture, models, UX,
customization, compatibility, and maintenance. Long-form dictation is an existing
strength to preserve, not evidence that reliability alone should dominate the
roadmap. No release, release tag, or package version bump is authorized.

## Scope and evidence

- Source baseline: `138f865`; initial Graphify setup: `58fed81`.
- Native QA is exclusively `/Users/alex/Documents/test-vault`, Obsidian 1.15.1,
  Mac arm64. Preserve all unrelated worktrees and untracked files, issue #476,
  and correction-rules PR #459. The personal vault is outside QA scope.
- Graphify is pinned and isolated, with model backends disabled. Its local AST
  graph oriented ownership queries; actual source and tests established behavior.
  The refreshed intermediate graph contained 7,870 nodes and 20,903 edges at the intermediate main checkpoint; refresh after further merges before querying.
- Node 24.22.3 and the dependency updates were reviewed against official sources.
  The combined QA worktree used a clean lockfile install under Node 24.22.3;
  npm reported zero vulnerabilities. A temporary npm cache avoided sandboxed
  writes to the user cache; no cache ownership or machine security changes were made.
- Use public checked-in speech and synthetic notes. Recording was disabled.
  No private note content, credentials, or captured speech is committed as evidence
  or sent to an AI provider. Native screenshots were observed through computer use;
  do not invent exported screenshot paths.

## Merged outcomes

| Area                   | Result                                                                                                                                   | PR   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Code navigation        | Pinned local Graphify environment, wrapper, exclusions, guide, and scoped skill.                                                         | #541 |
| Current requirements   | Correct application reliability and model expansion spec made available on main. Documentation, not a product feature count.             | #542 |
| Runtime maintenance    | Node security patch, aligned pins, verified archive and clean install.                                                                   | #545 |
| Native dependencies    | Compatible llama wrapper/sys and UUID updates; all native platform CI passed.                                                            | #537 |
| Windows compatibility  | WASAPI 0.27 API changes fixed and Windows x64/ARM64 CI passed; real audio hardware unverified.                                           | #538 |
| Frontend dependencies  | Seven tooling updates, formatter/schema compatibility, clean install and audit.                                                          | #549 |
| Production composition | Five tests exercise the actual TypeScript client against a real sidecar process in CI.                                                   | #547 |
| Wire contract          | Shared TypeScript/Rust semantic and byte corpus; exhaustive framing assertions made cheaper without dropping cases.                      | #548 |
| Media recovery         | Failed final note insertion retains staged complete text; accepted but unprojected recovery does not falsely clear it.                   | #543 |
| Dictation failure      | Sidecar exit releases microphone/session resources, drains admitted work, and allows first-click restart.                                | #544 |
| Translation lifecycle  | Cancellation is distinct from native termination; retain ownership and block unsafe retry until acknowledgement or process termination.  | #546 |
| Popout compatibility   | File picker uses the active document; matching animation cancellation uses its window.                                                   | #552 |
| Output clarity         | Timestamp examples and clock labels, contextual interval controls, honest speaker-label limits, compatible batch-model picker.           | #557 |
| Discovery              | Explicit Open Speech Kit command, Settings/setup routes, stable capture control, once-only inactive sidebar provisioning.                | #551 |
| Optional tools         | Advanced → Customize tools hides unused tools while preserving models, preferences, active work and accepted results.                    | #553 |
| Hidden visualization   | Stop analyzer reads/animation outside the viewport; dispose observers and reject late callbacks. No battery-percentage claim.            | #556 |
| Multilingual ASR       | Add distinct compact multilingual Whisper Small; clarify existing Small English without changing IDs, artifacts or defaults.             | #559 |
| Translation UX         | Stable Cancel action through progress updates, fixed visible footer, scrollable body, keyboard focus retained.                           | #563 |
| Caption concurrency    | Public creator captions can be inserted safely while microphone dictation continues; owner-specific processing ranges protect live text. | #550 |

Count useful outcomes rather than documentation commits, dependency subcommits,
or artificially separated PRs. The related dependency and UX changes can be
grouped when describing product improvements.

## Combined verification

The combined branch `/tmp/speech-kit-reliability-qa` integrates the reviewed source
slices and current main. It is a local QA branch, not a release artifact.

- Clean modern-dependency frontend gate: 2,035 passed, 15 skipped; both TypeScript
  targets, Biome, Obsidian ESLint, and production frontend build passed.
- Full project Rust quality command: formatting, all-engine Clippy with warnings
  denied, and 23 executed test suites: 425 passed, 35 ignored, zero failures.
  Ignored model/platform tests are not claimed as executed by that command.
- The five real-client/installed-sidecar tests passed under Vitest 5.1.
- Normal all-engine Mac debug helper, including Metal support, built successfully.
  Manual tool comparisons recorded matching installed JavaScript, styles and manifest
  hashes against QA outputs, and a matching helper install-manifest hash. The build
  logs alone do not contain those comparisons.
- Model-specific real inference and managed install checks are recorded separately
  in the model quality notes; their scope is not equivalent to every OS or accelerator.

### Native observations

1. The initial microphone-to-YouTube path reproduced a generic media-busy error.
   In the combined build, public creator captions were inserted while Listening
   continued and incoming speech remained intact. Stop cleaned up without duplicate
   captions. Unavailable/cancel/navigation edge cases also have controller and real
   editor regressions; they were not all separately exercised through native UI.
2. A targeted SIGTERM affected only the helper whose exact command matched the
   test-vault plugin. Listening and the temporary pin cleared, the synthetic note
   prefix remained, one subsequent click reached Listening, and Stop completed.
3. A repeated public JFK file completed and inserted. A longer public file was
   cancelled; incomplete recovery actions appeared, its temporary lock/pin cleared,
   and Insert partial transcript preserved the original note. Native filesystem
   insertion failure was not induced; that failure has public-controller regressions.
4. Advanced customization hid/restored all three optional tools with their selected
   models/preferences intact. With AI features off, sidebar capture still worked.
   Open Speech Kit reopened a collapsed sidebar. Direct Edit preset opened the exact
   active saved preset; a rejected workspace open is covered by regressions.
5. Timestamp examples updated between elapsed and local time; Every phrase removed
   the interval input. Original preferences were restored. Streaming speaker controls
   were inactive. Native review caught the original batch-picker mismatch; the fixed
   entry showed only compatible batch families. No diarization accuracy improvement
   is claimed.
6. Multilingual Small installed through the normal native download flow, selected,
   and transcribed a natural German fixture into the correct note. The rebuilt
   native catalog showed distinct Small English and Small Multilingual names.
   Moonshine Tiny was restored as the test-vault dictation model.
7. Real local HY-MT translation of synthetic text cancelled with acknowledgement,
   retried successfully, and cancelled again; the source note was unchanged. Native
   review found a clipped Cancel action and progress replacing its DOM node. The
   follow-up kept Cancel visible, retained keyboard focus from block 13 through
   block 22 and body scrolling, and cancelled with Space. Its footer also remained
   visible in a shorter native window.
8. From a popout, Browse → Cancel → Browse accepted a public fixture and inserted
   its transcript in the popout note. Closing the disposable popout and returning
   to the main window preserved a working Browse/Cancel path.
9. The initial status-bar prototype started/stopped dictation with ribbon and sidebar
   hidden, retained keyboard focus, and distinguished stopped capture from finishing
   work. It fitted a narrower native window and light/dark themes. Original window,
   theme and ribbon settings were restored. The later configurable-location version
   was also switched to Status bar in native Settings: the preference persisted,
   the microphone ribbon control hid, and capture reached Listening. All four
   locations have automated visibility/lifecycle coverage; not all four received
   separate native capture trials.

## Further merged outcomes and current experiments

- #560 merged: separate whole-file decoder limits from model utterance context;
  native VAD still bounds inference chunks. Focused regressions and CI passed.
- #558 merged: plain preset timing, direct preset editing, and a compact sidebar
  off-state. Native checks showed the toggle, active Summary preset and Edit action
  while off, and full timing/original/context controls while on.
- #561 merged: one quick-control location choice: Ribbon (default), Status bar,
  Both, or Commands only. Commands/hotkeys remain available; visibility changes
  release animation and observer resources.
- #565 merged: short phrase-finalization choices (Responsive, Balanced, Patient)
  with explanations in the tooltip. Native labels and tooltip were checked.
- #566 merged: speaker settings open even with a streaming model. The inactive dialog
  explains compatibility, preserves disabled saved options, and opens the existing
  batch-only picker. Native navigation and collapsed timestamp-help spacing passed.
  This changes guidance, not speaker identification quality.
- #554 remains an exploratory draft outside the shipping catalog. Natural German
  samples exposed accuracy weaknesses in the tested Tiny and Small split exports; successful
  cancellation and short phrase boundaries do not establish adoption readiness.
- #562 remains an isolated Parakeet TDT experiment. Short clips passed, but natural
  long German failed, including real VAD sessions. An independent decoder reproduced
  the raw output. This does not establish that every upstream export fails.
- Qwen ASR is now explicitly authorized by the owner, superseding the earlier spec
  exclusion. Native helper and packaging work is in progress. Neither a catalog
  adoption nor streaming performance is claimed before completing integration review. Accuracy thresholds are provisional
  evaluation aids, not a universal adoption veto. Draft #568 preserves the native
  helper, adapter, packaging, public fixtures and bounded observations. The FIFO
  probe and busy-helper owner-loss regressions passed. Managed frontend support,
  actual cancel/retry, matched baseline and 1.7B comparisons, and partial streaming
  remain unfinished. No new experiments were started after the wrap-up request.

Computer use temporarily lost a reliable target/focus across desktops. Actions
stopped when the personal vault appeared. After the owner closed that vault,
checks continued only in test-vault. Temporary preferences were restored to ribbon
controls, AI transformation off, recording off, and Moonshine Tiny. The owner's
selected Summary preset was preserved. Only the synthetic QA note was cleaned up.

Speaker-label accuracy has not been established by these UX changes. The owner's
reported batch-quality issue also needs a concrete failing fixture and workflow
before attributing it to a decoder, segmentation, diarization, or transformation.
No release was made.

## Wrap-up and next pass

The owner requested wrapping up before further model experiments. Preserve Qwen
implementation and packaging as a draft, with unfinished checks explicit. Do not
start another download or expand implementation during the handoff. Next, review
GitHub Actions and historical model criteria for relevance and design. A worse
accuracy score alone does not mean a model should not be supported. Preserve raw
results and reconsider exclusions through matched comparisons and useful user
tradeoffs. This clarification supersedes any earlier universal-gate wording.

The main Windows ARM job initially failed while extracting an ONNX Runtime download
with a peer disconnect. A retry passed. #566's frontend, native and CodeQL PR checks
passed before merge. Subsequent main checks and draft #568 checks are not claimed
complete by this handoff. Twenty-four PRs were merged during this pass, including
specification, tooling, dependency, test, and product changes; this is not a count
of twenty-four new features or models.
