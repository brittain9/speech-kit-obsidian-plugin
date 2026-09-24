# First-run guidance

## Goal

A fresh Speech Kit setup must explain the one required local engine download, offer a suitable first transcription model without hiding model choice, and make the first dictation attempt safe in a new or empty vault.

## Setup-wizard contract

- The wizard remains ordered: speech engine, transcription model, microphone readiness, ready.
- The model step derives its starting card from the catalog already loaded by `ModelInstallManager`, the selected dictation language, and the browser's available CPU/memory hints. It does not add a second model catalog, benchmark models, or run inference.
- A recommendation names the model and explains why it fits. The card states whether words appear live or only after a pause, lists its verified languages, and states its download size and local resource expectation.
- `Install and use` is the only action that starts a download. A catalog model that is already installed offers `Use` instead. Installation failure keeps the wizard open with localized recovery copy.
- A non-null existing selection is authoritative. The wizard never offers a recommendation download or replaces that selection. `Customize models` remains the path to the full task-based model manager.
- A language with no suitable downloadable/installed speech-to-text model gets explicit guidance to change language or use Customize models. It does not fall back to an incompatible model.
- The first-run speech-engine path remains CPU-capable. CUDA is optional and may be installed later from settings; hardware guidance must not make CUDA a prerequisite.

## Model-manager capability copy

The single catalog drives task/language availability. When a language is selected, the model manager summarizes, for dictation, read aloud, and translation:

- how many compatible models are installed;
- how many compatible models remain available to download; and
- when no compatible model exists for a task.

The language rail includes a language when any task's catalog model supports it. Translation support uses the model's `translationSupport` record, so a translation-only language is not presented as empty across the whole browser. Model rows retain explicit Installed/Downloadable and current-language compatibility state.

## First dictation

- Choosing `Try dictation now` is blocked while another session is active.
- If no Markdown target is open and the vault has no user notes, setup safely creates (or reopens) a root-level `Speech Kit scratch note.md` and opens it in source mode. It never overwrites an existing path. A non-empty vault without an active target keeps the existing localized guidance.
- Before a real session, the microphone step asks for microphone access at most once per open wizard. When the Permissions API is available, `Check again` re-reads permission state after the user changes OS access without showing another prompt. Tracks opened for the check are stopped immediately.
- Denied, missing, and unreadable-microphone recovery stays in the wizard and uses localized copy. Permission is checked only when the user presses the microphone action.
- Completing setup closes the wizard before starting the ordinary dictation controller. The readiness check does not start a sidecar session, load a model, or write audio.

## Verification seam

Behavior is tested through the setup wizard and its ready-action public boundary: safe recommendation defaults, explicit install/use, existing-selection preservation, unsupported-language recovery, empty-vault target preparation, one-request microphone denial/retry behavior, and localized copy. Focused model-manager tests verify that task/language availability is derived from the existing catalog.
