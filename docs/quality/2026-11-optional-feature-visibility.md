# Optional feature visibility

Added explicit `translationEnabled` and `readAloudEnabled` preferences with
true defaults. Missing or invalid values preserve existing availability;
explicit false survives settings normalization. The existing
`llmFeaturesEnabled` preference is unchanged in storage and now governs new
explicit media transformations as well as dictation transformations.

A shared Features group owns the three reversible switches. Detailed settings
and task model summary subscriptions are mounted only for enabled tools.
Manage models remains unfiltered so hidden-feature models can be inspected and
removed. Unique switch labels preserve the existing settings focus mechanism.

Command availability reads current settings rather than unregistering command
identifiers, preserving assigned hotkeys. Editor menus read the same settings
and re-check availability when a stale menu action is invoked. Public controller
entrypoints gate new work, while active stop/pause, cancellation, status,
accepted translation output, and recovery remain available. A retained preview
cannot silently start another translation, model selection, or download after
the feature is hidden.

AI preset controls disappear from media dialogs when AI features are off. New
jobs use an explicit transcript-only snapshot, and the media coordinator also
checks the current global preference before constructing a provider router or
reading transcript text for transformation. Explicit media presets remain
independent of the legacy media-processing toggle when AI features are on.

## Verification

Meaningful failures were observed before implementation for settings defaults,
disabled controller starts, palette/menu visibility, provider settings hiding,
media preset visibility, explicit media AI gating, and retained preview actions.
Tests exercise re-enabling, preserving selected models and other preferences,
active playback stop, applying accepted translation output, and stale menu or
preview actions.

`npm run check:frontend` passed: 1,949 tests passed, 10 skipped; both typechecks,
Biome, Obsidian ESLint, and production build passed. Native Obsidian verification
of the exact combined build remains assigned to the shared QA owner. No model
was downloaded or removed by this change, and no release was created.
