# Spec: Personal correction rules v2

Status: approved implementation contract

## Goal and boundary

Personal correction rules are an optional, deterministic, local post-transcription
correction step. They are not ASR vocabulary, hotwords, an initial prompt, or a
model feature. The active model does not see a rule and may be changed without
changing rule behavior. Rules run after the native hallucination filter and
before the optional TypeScript LLM cleanup. A correction therefore cannot
resurrect a hallucinated segment and the LLM sees the corrected final text.

Rules are a **session-start snapshot**. The plugin copies the current enabled
and disabled rules when a dictation session starts and sends that copy in
`start_session`. Editing, enabling, disabling, reordering, deleting, or adding
rules affects the next session only. The sidecar retains the snapshot in the
worker session metadata; it never reads plugin settings again.

The stage is final-revision-only. Partial streaming revisions are never changed.
The native stage runs in this order:

1. engine output
2. hallucination filtering
3. personal correction rules
4. diarization (if enabled)
5. `transcript_ready`

The optional LLM cleanup is a later plugin stage.

## Persisted shape and validation

`PluginSettings.schemaVersion` is 11. The additive setting is
`personalCorrectionRules`, an array whose order is the execution order:

```ts
interface PersonalCorrectionRule {
  id: string;
  enabled: boolean;
  find: string;
  replace: string;
}
```

Unknown persisted fields are left to the existing settings migration behavior;
adding this setting must not reconstruct settings from a partial object or reset
newer settings fields. Existing settings without the key migrate to an empty
array. Invalid persisted rules are omitted during normalization; the editor
never silently turns an invalid draft into a saved rule.

Before a draft is compiled for preview or sent to a session, all rules are
validated. The shared limits are:

- at most 100 rules;
- at most 256 Unicode scalar values in each `find` and `replace` value;
- non-empty, non-whitespace-only `find` and `replace` values;
- non-empty unique rule IDs;
- no duplicate `find` values after Unicode NFD normalization (duplicate finds
  are ambiguous even if their replacements differ).

Validation returns typed errors with stable codes and field/index information.
The modal displays the first error and does not persist or compile an invalid
draft. Disabled rules are still validated so enabling one cannot create a
latent invalid session configuration.

## Matching and replacement semantics

Matching is literal and case-sensitive. `find` is not a regular expression.
Matching uses Unicode NFD for canonical-equivalence matching, so a composed
find value can match a decomposed transcript value and vice versa. Replacement
text is inserted exactly as entered; normalization is used for matching, not to
rewrite the user's replacement.

A match is whole-word when the edge of the found value that is itself a word
character has no adjacent word character in the segment. A word character is
an underscore or a Unicode scalar in general category `L` (letter) or `N`
(number), exactly matching JavaScript's `\\p{L}` / `\\p{N}` property escapes and
the Rust implementation. For example, `cat` matches `cat` and `cat's`, but not
`concatenate`; `AI` matches `AI` and `AI-generated`, but not `said`. If a find
value begins or ends with punctuation, that edge does not impose a boundary.

Rules run in array order. Every enabled rule is applied to the complete result
of the previous rule, so cascades are intentional. A later rule can match text
introduced by an earlier rule. Replacement never crosses a segment boundary:
each segment is processed independently, and segment/speaker/timing metadata,
IDs, word timestamps, start/end times, and speaker values are preserved exactly.
The stage never joins segment text before matching. Empty segments remain
empty and are not used as bridges.

The joined transcript text is derived from corrected segments after the stage,
so the same per-segment rule is visible in `transcript_ready.text` and in the
plugin's renderable final transcript. The LLM cleanup consumes that corrected
final transcript.

## Safety budgets and preflight

Before allocating a replacement output for a rule/segment, the native stage
counts matches and calculates the projected Unicode-scalar output length using
checked arithmetic. It rejects the operation with a typed amplification error
before materializing that output if either:

- the projected length is greater than 1,000,000 Unicode scalar values
  (`MAX_CORRECTION_OUTPUT_CHARS`); or
- the projected length is greater than the input length multiplied by 8
  (`MAX_CORRECTION_AMPLIFICATION`), rounded up for a non-empty input.

The check is repeated for every ordered rule. This is deliberately a cascade
check: `a -> aa`, `aa -> aaaa`, ... is safe only while its projected relative
length remains within the ratio budget. It is rejected before the next output
string is allocated, even though the preceding output already existed. Absolute
and relative failures are distinct typed errors and the original transcript is
kept. The same budgets and order are used by the TypeScript preview compiler.

## Session and stage observability

The plugin shows a localized, informational notice when a session starts with
one or more rules in its snapshot, stating how many rules are enabled and total.
The notice is informational only and does not imply that a rule changed ASR
decoding.

Every final revision carries a `user_rules` stage outcome. Disabled/no-rule
snapshots are recorded as skipped; valid changes are recorded as `ok` with a
small payload containing the rule count, enabled rule count, applied rule
count, replacement count, and changed segment count. Failed amplification or
invalid wire input is recorded as failed and leaves the transcript text
unchanged. Partial revisions may contain a skipped final-only stage only when
the processor is present; the current streaming path does not send the stage
processor for partials.

## User interface

The Transcript output settings group contains a localized row that opens a
Personal correction rules modal. The modal provides:

- a preview input and output;
- add, enable/disable, move-up, move-down, and delete actions;
- ordered list numbering and total/enabled counts;
- validation messages with field/index context;
- a clear explanation that rules are local post-transcription corrections and
  apply to final segments in the next session after a settings change.

All user-visible strings use `t()` and the English catalog is the source of
truth. The modal persists only a valid draft and preserves the rest of
`PluginSettings` by spreading the current settings object.

## Compatibility and verification

The existing framed protocol remains intact. `start_session` gains an additive
`correctionRules` field with a default empty array, so older commands remain
readable. Existing settings keys and newer fields are not removed or reset.
The TypeScript and Rust implementations are tested against the same examples
for whole-word boundaries, NFD canonical equivalence, ordering, per-segment
isolation, final-only behavior, timing/ID preservation, amplification rejection
before materialization, settings migration, UI localization keys, and stage
history ordering.
