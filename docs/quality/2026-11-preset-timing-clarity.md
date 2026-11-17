# Preset timing clarity

All starting presets specify batch timing. The daily controls previously rendered
that as a disabled Run transform dropdown; its adjacent timing gear opened
minimum-word and timestamp settings rather than the active preset's timing.

The shared Settings/sidebar renderer now shows effective timing as a plain
summary when it belongs to a preset. Edit preset opens the exact current saved
preset directly. Unrestricted presets keep the timing selector, relabeled When
to transform. The advanced gear is labeled Minimum words and timestamps. Core
when/output behavior is visible even when the preset has a custom description;
secondary description and overrides use an accessible tooltip.

The preset editor explains why additive output is restricted to on-stop timing
and updates that explanation when output changes. Existing preset identifiers,
prompts, timing/output constraints, and provider behavior are preserved. Missing
edit references fall back to the list with feedback. Empty preset collections
show No preset rather than implying that a nonexistent transform will run.

Stale unrestricted timing controls are checked both before queuing a settings
mutation and against the current settings inside that mutation. They cannot
change shared timing after another surface selects a preset-owned timing.
Changing unrestricted timing while transformation is off keeps it off.

## Verification

Public renderer checks observed the disabled dropdown and stale-control mutation
before fixes. Public preset-modal open/save tests preserve the edited preset's
identity, timing, and output; output-mode tests preserve the additive batch
constraint. Tests also cover the missing-preset list, empty collection, exact
active reference from the sidebar, and close callbacks after that view closes.
Settings focus and existing provider/preset tests remain part of the frontend
gate. Opening or editing presets adds no provider requests.

Native visual layout, keyboard focus, and synthetic-endpoint AI smoke remain
pending with the shared QA owner; unit tests do not establish those outcomes.

`npm run check:frontend` passed: 1,956 tests passed, 10 skipped, both typechecks,
Biome, Obsidian ESLint, and the production build. No release was created.


## Sidebar restraint followup

The daily sidebar uses a native AI transformations heading instead of the
oversized workflow title, eyebrow, and explanation. With transformation off,
the native toggle description explains raw transcript insertion once; the
separate Off badge/status and large raw-mode card are removed. Active
transformation retains a small accessible status summary. The preset and timing
controls keep their visible timing/output guidance and direct Edit preset action.
No operation or saved preference semantics change.

The public view regression failed on the previous repeated raw-mode presentation
and passes with the compact native section. Active status announcements, primary
dictation controls, scroll retention, and active-preset editing regressions pass.
The combined native visual review remains with the shared QA owner.
