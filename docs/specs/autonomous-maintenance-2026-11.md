# Autonomous Speech Kit maintenance run

## Purpose

Improve Speech Kit as an application used every day. Prioritize safe note editing, reliable speech workflows, clear Obsidian-native controls, maintained dependencies, and efficient use of the computer. Research and add models when they offer a useful capability or a measured improvement with reasonable integration cost.

This spec guides the whole autonomous run. It covers investigation, web research, implementation, computer-use QA, performance work, independent review, and handoff. Keep a findings log beside the QA reports. Record changes to this scope when new evidence or user direction changes the plan.

## Constraints that remain true

- Use only `~/Documents/test-vault` for vault content and native Obsidian testing. Do not read, inspect, or modify the personal vault named **Obsidian Vault**.
- Do not create a release, release tag, or release version bump. The user will review the final brief before deciding whether to release.
- Leave issue #476 and correction-rules PR #459 untouched unless the user changes that instruction.
- Preserve existing user changes and untracked work. Use isolated branches and worktrees for implementation.
- Keep core workflows local. Do not upload private notes or captured speech for research or testing. Use public fixtures or synthetic text for external-provider tests.
- Do not start training, rentals, paid infrastructure, or an unbounded download or experiment queue. Model downloads for a specific local validation must be intentional, bounded, and recorded.
- Preserve compatibility identifiers and accepted architectural constraints in `docs/adr/`. A justified change to an accepted decision needs a superseding ADR.
- Use `gh` for GitHub work. Use computer use for Obsidian QA. Shell commands and local tests may support implementation, fixture preparation, and measurement.

## First principles

Treat these as the irreducible product requirements:

1. User text and audio must not disappear because Speech Kit races with an edit, cancellation, error, or late event.
2. A user must know what the application is doing, what it needs, where output will go, and how to stop it.
3. Every operation must have a clear owner and an understandable lifecycle. Terminal events must release the resources they own.
4. Local inference must remain practical on the supported computer. Idle work, retained memory, duplicate processes, and background polling need a reason to exist.
5. A new model must fit an actual user need and a verified execution path. A model card alone does not establish plugin compatibility or quality.

Before extending a difficult area, ask what a principal architect would remove or simplify. Look for duplicated ownership, caller-visible ordering rules, invalid combinations of booleans, and shallow modules that make callers coordinate their implementation. Prefer a small interface that owns a complete operation. Rewrite a module when evidence shows that a local patch cannot restore clear ownership and invariants. Do not rewrite working areas merely to impose a new style or framework.

## Investigation workstreams

### Security and supported toolchains

Audit GitHub security and quality findings, JavaScript and Rust lockfiles, direct and transitive dependencies, native runtime dependencies, and build tooling. Check the versions against primary advisories and official support schedules.

Choose maintained versions that address known vulnerabilities and work together. Do not equate the newest major version with the best choice. Reconcile the recommended Node version, declared Node support range, package engine requirements, CI, local setup, and contributor documentation. Installing a newer Node version is authorized when it is the appropriate supported choice.

Check that downloads have the intended source, format, integrity checks, cancellation behavior, and cleanup. Review secret handling and external-provider payloads without exposing credentials. Fix actionable findings; record the evidence and disposition of anything unresolved.

### Daily dictation and note editing

Concentrate on speaking while typing, pasting links, moving the cursor, and continuing work elsewhere in Obsidian. Exercise live partials and final revisions with manual text, Markdown links, selections, timestamps, paragraph formatting, and existing text on both sides of the insertion point.

Look for overwritten edits, dropped speech, duplicated output, incorrect anchors, unsafe recovery, and unexpected stops. Include note navigation, rename, close, deletion, multiple views, repeated start/stop, slow processing, and late or repeated events. Use real CodeMirror editor tests where editor transaction ordering matters.

### Implicit state machines and module ownership

Inventory the actual states, events, resources, and owners before changing the code. Inspect at least:

- Microphone and system-audio capture, including permissions, device changes, startup failure, and disconnects.
- Dictation startup, listening, draining, finalization, cancellation, errors, and disposal.
- Transcript projection, manual-edit protection, recording placement, batch cleanup, and recovery.
- Sidecar startup, readiness, requests, session identity, process failure, and restart.
- Model download, installation, selection, capability probing, cancellation, and stale results.
- File transcription, decoding, background work, optional AI processing, and insertion into the original note.
- Translation model selection, inference, detached progress, preview freshness, and apply/dismiss behavior.
- Read-aloud loading, buffering, playback, pause/resume, seeking, speed changes, stop, and teardown.

For each important lifecycle, identify legal transitions, terminal states, invariants, and resource release. Test adversarial event order. Distinguish explicit cancellation from infrastructure failure and successful output from partial output. Consolidate state where that removes invalid combinations or duplicated coordination. Do not add a generic state-machine framework without a demonstrated need.

### Efficiency, memory, and battery use

Establish a baseline before optimizing. Measure the app and sidecar separately where possible. Cover idle with no active job, warm idle with models loaded, dictation, file transcription, translation, read aloud, and repeated operation cycles.

Look for unnecessary timers, wakeups, capability probes, model reloads, audio copies, rendering work, duplicate inference, retained event listeners, growing queues, leaked handles, and processes that survive teardown. Run bounded longer sessions and repeated start/stop cycles to expose drift.

Record hardware, runtime and model versions, fixtures, warm/cold state, duration, and relevant background activity. Choose an acceptance threshold after the baseline and before the optimization. Use comparable repeated runs. Keep battery and power observations descriptive when the available counters or background activity cannot support a controlled comparison. Do not promise a battery-life percentage without evidence.

### UX and Obsidian integration

Test whether users can discover and complete each workflow without knowing the implementation. Check setup, model and language discovery, provider configuration, commands, hotkeys, progress, cancellation, error recovery, and output placement.

Prefer Obsidian's attachment location, link generation, native audio player, settings patterns, and existing commands. Keep user-facing copy short and accurate. Check keyboard access, focus restoration, readable layouts, and reduced-motion behavior where relevant. Ensure loading and failure states do not appear as false empty results or false success.

Correct misleading documentation as part of the affected workflow. Do not add controls for hypothetical future uses.

### Model research and integration

Use parallel research agents and primary sources: official model cards, model repositories, runtime documentation, source code, licenses, and release notes. Compare candidates with the current catalog before proposing additions.

For each serious candidate, record:

- User benefit, task, languages, and whether streaming is required or supported.
- Exact weight and tokenizer formats, required assets, runtime support, and compatible runtime versions.
- License and redistribution constraints, download size, likely memory use, and acceleration options.
- Integration class: catalog-only, small adapter within an existing engine, or a new runtime/architecture.
- Evidence quality, unresolved compatibility questions, a bounded local validation plan, and a recommendation.

Prioritize catalog-only additions and small adapters to existing engines. A conversion is unverified until a compatible artifact actually loads and works. Treat a new runtime as a separate architectural decision with a clear benefit and cost; it is not a default consequence of finding an interesting model.

Implement the strongest practical candidates when the evidence supports them. Validate the actual plugin path with representative fixtures. Compare quality, latency, memory, and download cost with an existing model under comparable conditions. Keep unsupported claims and untested models out of the catalog.

## Execution loop

1. **Baseline:** inspect git, installed build, toolchains, process state, test-vault configuration, and existing checks. Keep prior maintenance results and unfinished follow-ups distinct.
2. **Parallel discovery:** delegate model research, security/version review, and code audits. Rotate agents through distinct areas within the environment's concurrency limit. Use GPT-6.1 agents with extra-high reasoning for deep code and architecture work; use lighter agents where they are sufficient.
3. **Triage:** reduce findings to a concrete user failure, violated invariant, measured cost, or useful capability. Rank data loss, security, hangs, and resource leaks first; then daily-workflow reliability and UX; then model opportunities and polish.
4. **Reproduce:** build a tight failing test or repeatable measurement before changing behavior. Test through the public interface or the real integration seam.
5. **Implement:** make the smallest complete root-cause fix. Remove superseded code. Avoid compatibility shims, silent fallbacks, speculative options, and commented-out code.
6. **Review:** have a separate agent review material changes, especially lifecycle, editor, concurrency, filesystem, and protocol work. Reproduce its findings and resolve them with tests.
7. **Exercise:** use the changed feature in native Obsidian. Include successful use, cancellation, failure, note safety, repeated use, and interactions with adjacent features. Keep one owner for the shared QA UI.
8. **Validate and merge:** run the relevant checks, then the repository's required gates. Merge focused PRs only after their checks pass. Re-test interactions when integration changes behavior.
9. **Soak and reassess:** repeat representative workflows and bounded longer sessions. Update priorities from new evidence rather than expanding the task without limit.
10. **Handoff:** install the exact verified build in the test vault, leave capture and recording off, organize evidence, and provide the final brief. Do not release.

Each implementation agent owns an isolated checkout. Agents must coordinate before touching shared resources. Keep one authoritative findings log with the finding, priority, evidence, owner, branch/PR, validation, and disposition. Research recommendations must distinguish implemented, validated, proposed, and rejected candidates.

## Validation requirements

- Follow test-first development for behavior changes. Use meaningful public-interface tests rather than assertions about private implementation details.
- Run TypeScript and Obsidian-floor typechecks, Biome, Obsidian ESLint, tests, and the production frontend build for frontend changes. Use clean lockfile installs under the chosen supported Node runtime.
- Run formatting, Clippy, tests, and the relevant native build/platform checks for Rust or native dependency changes. Use real-model or protocol tests when the change affects inference or transport.
- Check dependency audits and the supported runtime's engine requirements after dependency changes.
- Use native QA to verify visible behavior and note contents. An attempted click, a loading state, or a mocked test alone does not establish completion.
- Do not report a workflow as tested on platforms, languages, providers, or hardware that were not exercised. Preserve material limitations beside the relevant result.

## Deliverables and completion

Keep the spec in `docs/specs/`, research with citations in `docs/research/`, and the run log, QA evidence, performance results, and smoke guide in `docs/quality/`. Use focused PRs for changes. Keep useful investigation results in the repository rather than leaving the only copy in temporary files.

The final brief must state what changed, why it matters, what was measured or tested, what remains unresolved, and how the user can smoke test the changes. Include a short recommended test route and links to the detailed evidence and PRs. Call out new settings, model downloads, changed requirements, and behavior limits.

The run is ready for handoff when high-priority findings have explicit outcomes, implemented changes have passed review and required checks, the final combined build has passed native QA, and further work is clearly separated into evidence-based follow-ups. Do not claim the app is universally bug-free. Report the actual evidence and remaining risk.

Existing maintenance is the starting baseline, not work to repeat. The outstanding Node/test-runtime compatibility finding must be resolved as part of the supported-toolchain review. Research, new implementation, architecture improvements, and longer QA passes proceed under this spec once it is written.
