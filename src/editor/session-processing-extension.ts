import {
  Annotation,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

export interface SessionProcessingRange {
  from: number;
  to: number;
}

export const setSessionProcessingEffect = StateEffect.define<{
  owner: object;
  range: SessionProcessingRange | null;
}>();

// Internal dispatches (e.g. rewriteRegion) tag transactions with this so the
// processing-range lock lets them through while still blocking user edits.
export const bypassSessionProcessingLock = Annotation.define<true>();

export const sessionProcessingStateField = StateField.define<
  ReadonlyMap<object, SessionProcessingRange>
>({
  create: () => new Map(),
  update(value, tr) {
    if (
      (tr.changes.empty || value.size === 0) &&
      !tr.effects.some((effect) => effect.is(setSessionProcessingEffect))
    ) {
      return value;
    }
    const next = new Map<object, SessionProcessingRange>();
    for (const [owner, range] of value) {
      // Sibling workflows may append at either boundary. That text remains
      // outside this owner's processing region.
      const from = tr.changes.mapPos(range.from, 1);
      const to = tr.changes.mapPos(range.to, -1);
      if (from < to) next.set(owner, { from, to });
    }
    for (const effect of tr.effects) {
      if (!effect.is(setSessionProcessingEffect)) continue;
      const { owner, range } = effect.value;
      if (range === null || range.from >= range.to) next.delete(owner);
      else next.set(owner, { ...range });
    }
    return next;
  },
});

const EMPTY_DECORATIONS: DecorationSet = Decoration.none;
const PROCESSING_DECORATION = Decoration.mark({ class: 'local-stt-session-processing' });

export const sessionProcessingDecorationsField = StateField.define<DecorationSet>({
  create: decorationsFor,
  update(value, tr) {
    const prev = tr.startState.field(sessionProcessingStateField, false);
    const next = tr.state.field(sessionProcessingStateField, false);
    return prev === next ? value : decorationsFor(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function processingRanges(state: EditorState): SessionProcessingRange[] {
  const ranges = [...(state.field(sessionProcessingStateField, false)?.values() ?? [])].sort(
    (left, right) => left.from - right.from || left.to - right.to,
  );
  const merged: SessionProcessingRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else merged.push({ ...range });
  }
  return merged;
}

function decorationsFor(state: EditorState): DecorationSet {
  const ranges = processingRanges(state);
  return ranges.length === 0
    ? EMPTY_DECORATIONS
    : Decoration.set(ranges.map((range) => PROCESSING_DECORATION.range(range.from, range.to)));
}

const processingRangeLock = EditorState.changeFilter.of((tr) => {
  if (tr.annotation(bypassSessionProcessingLock) === true) return true;
  const ranges = processingRanges(tr.startState);
  return ranges.length === 0 ? true : ranges.flatMap((range) => [range.from, range.to]);
});

export function sessionProcessingExtension(): Extension {
  return [sessionProcessingStateField, sessionProcessingDecorationsField, processingRangeLock];
}
