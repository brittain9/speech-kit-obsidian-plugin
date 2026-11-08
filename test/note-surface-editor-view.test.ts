// @vitest-environment jsdom
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { expect, it, vi } from 'vitest';
import { NoteSurface, noteSurfaceUpdateListenerExtension } from '../src/editor/note-surface';
import {
  provisionalTranscriptExtension,
  provisionalTranscriptStateField,
} from '../src/editor/provisional-transcript-extension';

function projection(text: string) {
  return {
    emittedSpeakerIndex: null,
    emittedTimestamp: null,
    insertedText: text,
    precedingSpeakerIndex: null,
    projectedText: text,
    replacementPrefix: '',
    textStartOffset: 0,
    textEndOffset: text.length,
  };
}

it('tracks nested editor updates in document order', () => {
  let nested = false;
  const earlierListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && !nested) {
      nested = true;
      update.view.dispatch({ changes: { from: 13, insert: "I'm sorry." } });
    }
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: 'Existing note',
      selection: { anchor: 13 },
      extensions: [earlierListener, noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const onFailure = vi.fn();
  const surface = new NoteSurface(view, { anchor: 'at_cursor' }, onFailure);

  view.dispatch({ changes: { from: 13, insert: ' typed' } });

  expect(onFailure).not.toHaveBeenCalled();
  expect(surface.validateExternalModification()).toBeNull();
  expect(view.state.doc.toString()).toBe("Existing noteI'm sorry. typed");
  surface.dispose();
  view.destroy();
});

it('latches user edits and clears provisional decoration after the update', () => {
  const view = new EditorView({
    state: EditorState.create({
      extensions: [noteSurfaceUpdateListenerExtension(), provisionalTranscriptExtension()],
    }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  surface.setProvisional('u1', true);
  expect(view.state.field(provisionalTranscriptStateField).has('u1')).toBe(true);
  view.dispatch({
    annotations: Transaction.userEvent.of('input.type'),
    changes: { from: 5, insert: ' link' },
  });
  expect(view.state.field(provisionalTranscriptStateField).has('u1')).toBe(false);
  expect(surface.replaceAnchor('u1', 'hello world', 'hello').kind).toBe('denied');
  expect(view.state.doc.toString()).toBe('hello link');
  surface.dispose();
  view.destroy();
});

it('keeps an appended continuation in the tracked range after a boundary edit', () => {
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  view.dispatch({
    annotations: Transaction.userEvent.of('input.paste'),
    changes: { from: 5, insert: ' https://example.com' },
  });
  expect(surface.replaceAnchor('u1', 'hello world', 'hello').kind).toBe('denied');
  expect(surface.appendContinuation(' world')).toBeNull();
  const span = surface.getSpan('u1');
  expect(span).toBeDefined();
  if (span === undefined) throw new Error('expected tracked speech');
  expect(surface.readRange({ from: span.start, to: span.end })).toBe(
    'hello https://example.com world',
  );
  surface.dispose();
  view.destroy();
});

it('blocks reentrant writes as soon as an untracked replacement is detected', () => {
  const failure = vi.fn();
  let surface: NoteSurface;
  let attempted: ReturnType<NoteSurface['appendProjection']> | undefined;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged) attempted = surface.appendProjection('u2', projection('unsafe'));
  });
  const extensions = [early, noteSurfaceUpdateListenerExtension()];
  const view = new EditorView({
    state: EditorState.create({ doc: 'original', selection: { anchor: 8 }, extensions }),
    parent: document.body,
  });
  surface = new NoteSurface(view, { anchor: 'at_cursor' }, failure);
  view.setState(EditorState.create({ doc: 'x', extensions }));
  view.dispatch({ changes: { from: 1, insert: '!' } });
  expect(attempted?.kind).toBe('denied');
  expect(failure).toHaveBeenCalledOnce();
  expect(view.state.doc.toString()).toBe('x!');
  surface.dispose();
  view.destroy();
});

it('keeps sibling sessions tracked and stops observing disposed surfaces', () => {
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const firstFailure = vi.fn();
  const first = new NoteSurface(view, { anchor: 'at_cursor' }, firstFailure);
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(first.appendProjection('u1', projection('one')).kind).toBe('appended');
  expect(second.appendProjection('u2', projection('two')).kind).toBe('appended');
  expect(view.state.doc.toString()).toBe('onetwo');
  first.dispose();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
  expect(firstFailure).not.toHaveBeenCalled();
  expect(second.appendProjection('u3', projection('three')).kind).toBe('appended');
  expect(view.state.doc.toString()).toBe('three');
  second.dispose();
  view.destroy();
});

it('can dispose the surface after the editor view is destroyed', () => {
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const failure = vi.fn();
  const surface = new NoteSurface(view, { anchor: 'at_cursor' }, failure);
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  view.destroy();
  expect(surface.dispose()).toBeNull();
  expect(failure).not.toHaveBeenCalled();
});
