# Timestamp and speaker-label clarity

The selected streaming model cannot label speakers. Previously, the enabled
preference still appeared on and editable, with only a batch-model limitation
in the description. The worker ignores this option for streaming sessions.
The row now shows the feature inactive, preserves its saved preference, and
provides an explicit model-picker action. Choosing a compatible batch model
restores the saved toggle state. The action opens a scoped picker that shows only speech families reporting
non-streaming support, with the first compatible family expanded. It does not
silently choose or download a model. Ordinary model discovery remains unchanged. Numbered voice labels are
presented as estimates that need review.

Timestamp settings now put the clock before the session header, with concrete
clock labels and a live example using the transcript renderer's formatters.
The interval field appears only for interval frequency. The existing frequency
explanation remains visible; expandable timing details explain phrase-boundary
intervals and model timing. The session header remains independent of clock
selection. No transcript rendering or stored settings semantics changed.

## Regression and validation

The public timestamp modal regression failed before implementation because no
example existed. It now checks elapsed and local clock examples, header
visibility, and interval hide/reveal. The speaker row regression checks saved
preferences, streaming inactivity, ignored stale enable calls, explicit picker
invocation, disabled advanced configuration, batch restoration, and disposal.
Both TypeScript configurations, formatting, lint, and the frontend build pass.
The complete frontend suite passes 1,962 tests with 15 skipped. Catalog parity
passes; new untranslated keys use the documented English fallback.

A fresh peer source review found no blocking findings. Native Obsidian visual
and interaction review remains required before merging this UX slice.

## Bounded speaker characterization

No diarization algorithm or thresholds changed. The existing real bundled
embedding-model suite passed seven tests (two full-inference cases remained
ignored). Interleaved clean speech produced eight clusters for eight known
voices, with measured purity and coverage both 1.000. Its noisy scenario
produced six of six voices, also with purity and coverage 1.000.

The existing full-pipeline tight-gap conversation test was run separately with
the installed Base.en Q8_0 Whisper model and Metal. Sixteen turns from eight
public fixture voices merged into five VAD utterances. Four distinct dominant
utterance labels were produced, while transcript segments recovered eight
voices. The test passed in 9.14 seconds. These are existing synthetic
conversations assembled from public speech clips, not a natural conversation
accuracy benchmark; speaker-count recovery does not establish identity
accuracy, overlap handling, or diarization error rate. The limitations in
[the quality follow-up](../diarization-quality-followup.md) still apply.

Native review reproduced a follow-up gap: the original action opened the current
Moonshine family while compatible batch choices were collapsed. A public modal
regression failed with both streaming and batch families present; the scoped
entry now excludes streaming choices and expands the batch family. The same
regression opens the ordinary picker and verifies both families remain available.

A public dictation-controller check also preserves the running session snapshot
when advanced output preferences change: a second start does not create another
capture, and the next session receives the new timestamp and speaker settings.
The model-selection and capture implementations remain unchanged.

## Native follow-up: speaker settings entry

Native user feedback found that the disabled speaker-settings gear looked like
an action that did nothing. The gear now opens its dialog for every model. With
a streaming model, the dialog explains why labels are inactive, shows the saved
speaker limit without enabling editing or Reset, and offers the same batch-only
model picker as the main row. Choosing that action closes the explanatory dialog;
it does not select or download a model. Stored preferences remain unchanged.

The public row-to-modal regression failed before the fix because clicking the
streaming gear never opened the dialog. It now checks the real dialog title,
inactive explanation, saved limit, disabled controls, ignored stale input, and
explicit model-picker action. Existing batch-mode configuration tests still pass.
The full frontend gate passes 2,016 tests with 15 skipped, both TypeScript targets,
formatting, lint, and production build. No new locale keys or algorithm changes
were needed. Native geometry and interactions remain with the shared QA owner.

The timestamp dialog's collapsed timing details also have a scoped bottom margin
before the following divider. This spacing change has no rendering or persistence
behavior; its visual acceptance belongs to native QA.
