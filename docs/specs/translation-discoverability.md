# Spec: Translation direction and model discovery

Status: approved for implementation

## Product goal

A user can change the direction of an active translation preview without
manually replacing two dropdown selections, and can discover the languages a
translation model actually supports from Manage Models. The selected model
remains the source of truth for both workflows; the product must not broaden a
model's advertised capability from a shared language tag or imply support for a
Firefox direction that the catalog does not declare.

## Current state

The translation modal already has localized `From`, `To`, and `Swap` copy, but
its direction indicator is a non-interactive arrow. A supported reverse pair
therefore takes two separate changes, and the preview's existing setup-change
path has to be invoked manually to make that direction current.

Manage Models renders one language rail for all three tasks, but derives it only
from speech-to-text `languageTags` and stores the selected language in one
field. Switching to text to speech or translation can therefore show a stale or
inapplicable rail, and selecting a language in one task leaks that choice into
another task.

## Decisions

### D1 — The modal swap action is capability-gated

Replace the decorative direction arrow with a native `button` whose accessible
name, tooltip, and localized text come from the existing
`translation.modal.swap` catalog key. Keep the action between the two existing
language controls; this is not a modal redesign.

The button is enabled only when all of the following are true:

1. no model install or inference operation is active;
2. the currently selected draft model is in the installed translation-model
   options; and
3. that exact model declares the reverse directed pair in its
   `translationSupport` metadata.

For `all_to_all` support, the existing pair helper verifies that both endpoint
languages are included and that source and target differ. For Firefox
`pairs` support, the reverse entry must exist independently. A one-way Firefox
catalog pair therefore does not imply that the button can reverse it.

A disabled native button is not keyboard-clickable and is removed from the
normal tab order by browser behavior. The enabled button retains native Enter
and Space activation; no duplicate key handler is added.

### D2 — Swap is draft state, not a new inference job

Swap exchanges the modal's draft source and target languages and then uses the
same `acceptDraftConfiguration` path as either language dropdown. That path:

- calls `onLanguageChange` with the reversed pair;
- updates the controller's active translation configuration;
- persists `translationSourceLanguage` and `translationTargetLanguage`; and
- re-renders heading, selectors, and actions.

It does not cancel or restart the job. A completed preview remains visible and
copyable, while mutation actions are replaced by `Translate again` because the
draft pair differs from the pair recorded by `TranslationJob`. Starting that
explicit retry creates the fresh job for the reversed direction. If a selected
Firefox model supports the reverse catalog direction but that exact pack is not
installed, the explicit retry reaches the existing exact-pack installation flow.

### D3 — Model-browser language options come from the active task

`deriveModelLanguageOptions` receives the active `ModelPickerTask` and derives
only models for that task:

- STT and TTS use each model's `languageTags` unchanged.
- Translation uses only `translationSupport.languages` for `all_to_all` models.
- Translation uses the distinct source and target endpoints of the declared
  `pairs` for Firefox models.

The model matching policy uses the same task-specific source. A translation
model matches a selected language only when that language participates in at
least one declared directed pair. This is a model-discovery filter, not a claim
that every Firefox direction involving that language is available; the modal
continues to enforce the exact source-to-target pair before enabling an action
or offering an exact direction pack.

The rail keeps its existing deterministic `All` first and native-label order.
`All` means no language narrowing, not universal direction support.

### D4 — Language state is task-specific

Store the selected language filter per `ModelPickerTask`, as the active family
already is. Switching tasks selects that task's saved filter (or `All` when it
has no saved choice), and switching back restores the previous choice. Search
query behavior is unchanged: it clears only when tasks switch.

Revealing a failed install still switches to the failed model's task and keeps
that task reachable. If the failed model does not match the task's current
language, reveal resets only that task's filter to `All`.

### D5 — Existing model lifecycle behavior is authoritative

Language filters only control discovery in the browser. They do not alter model
capability checks, allowed actions, installed/selected badges, install, use,
remove, retry, family selection, or task-specific model settings. In
particular, TTS and translation model installation remain governed by their
existing model and runtime rules rather than the current dictation language.

## Public seams under test

1. **Translation modal:** render and activate the swap control through the DOM;
   observe the language-change callback, visible pair, preview retention, stale
   actions, and absence of automatic inference. A controller-level behavior test
   confirms that this callback persists the reversed preference.
2. **Model browser:** derive language options and matching behavior for STT,
   TTS, Firefox translation, and HY-MT 2 records; exercise the rendered rail
   across task switches and observe only browser discovery behavior.

Tests must not reach private modal or modal-class fields.

## Out of scope

- Automatic source-language detection, pivoting, or model fallback.
- Installing a reverse Firefox pack as part of the swap click.
- Inferring translation support from `languageTags`, `translationPacks`, or a
  family summary.
- Combining the two Firefox directions into an all-to-all claim.
- Redesigning the translation modal, model browser, model rows, or settings.
- Changing model capability, installation, selection, or removal semantics.

## Verification

Required behavior tests:

- reverse pair supported and installed model: swap succeeds;
- reverse pair absent from a one-way Firefox model: swap is disabled and inert;
- a completed preview stays visible but becomes stale and cannot be applied;
- the control is a localized native button with keyboard-operable semantics;
- the controller persists the reversed source and target settings;
- HY-MT 2 exposes exactly its 38 declared all-to-all languages;
- Firefox options and matching derive only from exact directed-pair endpoints;
- STT and TTS derive and match through `languageTags`; and
- each task restores its own language filter after task switches.

Run the focused modal, controller, language, and model-browser tests, locale
parity, TypeScript typecheck, and lint before review.
