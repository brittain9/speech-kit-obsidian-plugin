# Trustworthy local workflows

## Outcome

Make long-running local work understandable and recoverable without changing
its execution model: expose transcription backpressure, keep detached
translation keyboard-accessible and politely announced, respect reduced-motion
preferences, and make the public translation description match shipped behavior.

## Observable seams

1. **Ribbon accessibility.** `DictationRibbonController.setQueueTier` updates the
   existing ribbon's `aria-label` and `title` for `normal`, `catching_up`,
   `falling_behind`, and `saturated`. It must not repaint or replace the ribbon
   SVG or stop its speech-band animation. The two healthy tiers are concise;
   the two warning tiers explain the condition and saturated advice.
2. **Detached translation status.** A status-bar update produces a native
   `button` containing a `role="status"`, `aria-live="polite"` region. Clicking
   or keyboard activation reopens the detached job, and progress updates replace
   the same live-region text without replacing the focusable button.

## Behavior

- Queue copy comes from locale catalogs. Returning to `normal` removes warning
  wording rather than leaving stale backpressure copy.
- The translation status button has a localized action label and title. Empty
  status hides the button and removes its action.
- The translation spinner has no animation under
  `prefers-reduced-motion: reduce`; its status text remains visible.
- README translation claims name Firefox Translations on-demand direction
  packs and HY-MT 2's broader language coverage, style/custom instructions,
  editable preview, and read-aloud. Claims remain conditional on an installed,
  compatible model and avoid global language or platform guarantees.

## Verification

Behavior tests cover all four accessible queue tiers without an SVG repaint,
plus the detached status button/live-region semantics, activation, live text
updates, focus stability, and clearing. Focused Vitest files, locale parity,
typecheck, lint, and the frontend build must pass.
