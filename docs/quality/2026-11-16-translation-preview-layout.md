# Translation preview actions and progress

Native review found that the translation dialog could fill a normal Obsidian
window with model, language and custom-style controls, leaving Cancel partly
outside the visible content. The modal now bounds its height and separates a
scrollable body from a nonshrinking action footer. Custom style selection and
instruction contents are preserved.

Real translation progress also rebuilt all action controls. This replaced the
Cancel button while it was focused or about to be clicked. The elapsed timer
only refreshed status; job progress notifications triggered the destructive
render. Running-to-running progress now updates status without rebuilding the
selectors or actions. Other model/configuration refreshes also retain the same
running Cancel button. Terminal states still replace it with the appropriate
completion, cancellation or retry controls.

The public modal regression failed before implementation: real progress plus
elapsed ticks and a model-manager refresh replaced Cancel. It now retains the
same control, preserves focus, and still aborts the real TranslationJob signal.
A second test checks that the footer is outside the scrollable custom-style
body. Existing cancellation acknowledgement, edited preview, stale source,
configuration, language and read-aloud tests remain passing (29 modal tests).
The branch frontend gate passes 1,936 tests with 10 skipped, both TypeScript
checks, lint and the production build on Node 24.22.3/npm 11.19.1. Changed files
also pass the newer reviewed Biome and Obsidian ESLint versions.

These tests verify control ownership and state transitions, not browser geometry.
The combined native QA owner should check normal and short windows with Custom
selected and an empty instruction, scroll the body, keep Cancel focused through
progress, cancel a long translation, and confirm terminal actions stay visible.
The change is stacked on the cancellation acknowledgement fix in PR #546.
