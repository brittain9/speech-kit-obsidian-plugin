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

it('places a later session after the previous speech and recording when the caret was not moved', () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'note: ',
      selection: { anchor: 6 },
      extensions: [noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const first = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(first.appendProjection('u1', projection('first')).kind).toBe('appended');
  expect(first.insertAfterRange({ from: 6, to: 11 }, '![[first.webm]]')).toBe(true);
  first.dispose();
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(second.appendProjection('u2', projection(' second')).kind).toBe('appended');
  expect(view.state.doc.toString()).toBe('note: first\n\n![[first.webm]] second');
  second.dispose();
  view.destroy();
});

it('keeps consecutive speech in order without a recording', () => {
  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const first = new NoteSurface(view, { anchor: 'at_cursor' });
  first.appendProjection('u1', projection('first'));
  first.dispose();
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  second.appendProjection('u2', projection(' second'));
  expect(view.state.doc.toString()).toBe('first second');
  second.dispose();
  view.destroy();
});

it('places the next session after a recording when no speech was produced', () => {
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const first = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(first.insertAfterRange(null, '![[first.webm]]')).toBe(true);
  first.dispose();
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  second.appendProjection('u2', projection(' next'));
  expect(view.state.doc.toString()).toBe('![[first.webm]] next');
  second.dispose();
  view.destroy();
});

it('respects a caret deliberately moved away and back while speech is arriving', () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'note: ',
      selection: { anchor: 6 },
      extensions: [noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const first = new NoteSurface(view, { anchor: 'at_cursor' });
  first.appendProjection('u1', projection('first'));
  view.dispatch({ selection: { anchor: 0 } });
  view.dispatch({ selection: { anchor: 11 } });
  first.insertAfterRange({ from: 6, to: 11 }, '![[first.webm]]');
  expect(view.state.selection.main.head).toBe(11);
  first.dispose();
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  second.appendProjection('u2', projection(' second'));
  expect(view.state.doc.toString()).toBe('note: first second\n\n![[first.webm]]');
  second.dispose();
  view.destroy();
});

it('keeps the caret at a later revision and leaves focus on the hold control', () => {
  const button = document.createElement('button');
  document.body.append(button);
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  button.focus();
  const first = new NoteSurface(view, { anchor: 'at_cursor' });
  first.appendProjection('u1', projection('partial'));
  expect(first.replaceAnchor('u1', 'final speech', 'partial').kind).toBe('replaced');
  expect(view.state.selection.main.head).toBe('final speech'.length);
  expect(document.activeElement).toBe(button);
  first.dispose();
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  second.appendProjection('u2', projection(' next'));
  expect(view.state.doc.toString()).toBe('final speech next');
  expect(document.activeElement).toBe(button);
  second.dispose();
  view.destroy();
  button.remove();
});

it('does not move a manual caret when batch text replaces a session', () => {
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  surface.appendProjection('u1', projection('speech'));
  view.dispatch({ selection: { anchor: 0 } });
  expect(surface.rewriteRegion({ from: 0, to: 6 }, 'clean speech', []).kind).toBe('rewritten');
  expect(view.state.selection.main.head).toBe(0);
  surface.dispose();
  view.destroy();
});

it('does not move a selection made before a late first transcript and recording', () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'before after',
      selection: { anchor: 12 },
      extensions: [noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  view.dispatch({ selection: { anchor: 0, head: 6 } });
  surface.appendProjection('u1', projection(' speech'));
  expect(surface.insertAfterRange({ from: 12, to: 19 }, '![[audio.webm]]')).toBe(true);
  expect(view.state.selection.main.from).toBe(0);
  expect(view.state.selection.main.to).toBe(6);
  surface.dispose();
  view.destroy();
});

it('keeps the newer session caret when an older recording finishes later', () => {
  const view = new EditorView({
    state: EditorState.create({ extensions: [noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const first = new NoteSurface(view, { anchor: 'at_cursor' });
  const second = new NoteSurface(view, { anchor: 'at_cursor' });
  first.appendProjection('u1', projection('first'));
  second.appendProjection('u2', projection('second'));
  expect(first.insertAfterRange({ from: 0, to: 5 }, '![[first.webm]]')).toBe(true);
  expect(view.state.doc.toString()).toBe('first\n\n![[first.webm]]\n\nsecond');
  expect(view.state.selection.main.head).toBe(view.state.doc.length);
  first.dispose();
  second.dispose();
  view.destroy();
});

it('tracks a new speech span across a nested edit during its insertion', () => {
  let nested = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && !nested) {
      nested = true;
      update.view.dispatch({ changes: { from: 0, insert: 'X' } });
    }
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: 'prefix ',
      selection: { anchor: 7 },
      extensions: [early, noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  expect(surface.replaceAnchor('u1', 'world', 'hello').kind).toBe('replaced');
  expect(view.state.doc.toString()).toBe('Xprefix world');
  surface.dispose();
  view.destroy();
});

it('tracks a speech span across a nested edit during its revision', () => {
  let armed = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && armed) {
      armed = false;
      update.view.dispatch({ changes: { from: 0, insert: 'X' } });
    }
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: 'prefix ',
      selection: { anchor: 7 },
      extensions: [early, noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  armed = true;
  expect(surface.replaceAnchor('u1', 'world', 'hello').kind).toBe('replaced');
  expect(surface.replaceAnchor('u1', 'final', 'world').kind).toBe('replaced');
  expect(view.state.doc.toString()).toBe('Xprefix final');
  surface.dispose();
  view.destroy();
});

it('returns the rewritten location after a nested edit before the range', () => {
  let armed = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && armed) {
      armed = false;
      update.view.dispatch({ changes: { from: 0, insert: 'X' } });
    }
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: 'prefix ',
      selection: { anchor: 7 },
      extensions: [early, noteSurfaceUpdateListenerExtension()],
    }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  surface.appendProjection('u1', projection('hello'));
  armed = true;
  expect(surface.rewriteRegion({ from: 7, to: 12 }, 'world', [])).toMatchObject({
    kind: 'rewritten',
    range: { from: 8, to: 13 },
  });
  expect(view.state.doc.toString()).toBe('Xprefix world');
  surface.dispose();
  view.destroy();
});

it('preserves a nested user edit inside newly inserted speech', () => {
  let nested = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && !nested) {
      nested = true;
      update.view.dispatch({
        annotations: Transaction.userEvent.of('input.type'),
        changes: { from: 2, insert: 'X' },
      });
    }
  });
  const view = new EditorView({
    state: EditorState.create({ extensions: [early, noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  expect(surface.replaceAnchor('u1', 'world', 'hello').kind).toBe('denied');
  expect(view.state.doc.toString()).toBe('heXllo');
  surface.dispose();
  view.destroy();
});

it('keeps a recording inserted during speech projection outside its tracked range', () => {
  let surface: NoteSurface;
  let nested = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && !nested) {
      nested = true;
      expect(surface.insertAfterRange({ from: 0, to: 5 }, '![[recording.webm]]')).toBe(true);
    }
  });
  const view = new EditorView({
    state: EditorState.create({ extensions: [early, noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello')).kind).toBe('appended');
  const span = surface.getSpan('u1');
  expect(span).toBeDefined();
  if (span === undefined) throw new Error('expected tracked speech');
  expect(surface.readRange({ from: span.start, to: span.end })).toBe('hello');
  expect(view.state.doc.toString()).toBe('hello\n\n![[recording.webm]]');
  surface.dispose();
  view.destroy();
});

it('keeps a nested recording outside the rewritten range', () => {
  let surface: NoteSurface;
  let armed = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && armed) {
      armed = false;
      expect(surface.insertAfterRange({ from: 0, to: 5 }, '![[recording.webm]]')).toBe(true);
    }
  });
  const view = new EditorView({
    state: EditorState.create({ extensions: [early, noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  surface = new NoteSurface(view, { anchor: 'at_cursor' });
  surface.appendProjection('u1', projection('hello'));
  armed = true;
  expect(surface.rewriteRegion({ from: 0, to: 5 }, 'world', [])).toEqual({
    kind: 'rewritten',
    range: { from: 0, to: 5 },
  });
  expect(view.state.doc.toString()).toBe('world\n\n![[recording.webm]]');
  surface.dispose();
  view.destroy();
});

it('does not register a span if the surface is disposed during insertion', () => {
  let surface: NoteSurface;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged) surface.dispose();
  });
  const view = new EditorView({
    state: EditorState.create({ extensions: [early, noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  surface = new NoteSurface(view, { anchor: 'at_cursor' });
  expect(surface.appendProjection('u1', projection('hello'))).toMatchObject({
    kind: 'denied',
    reason: { kind: 'disposed' },
  });
  expect(surface.getSpan('u1')).toBeUndefined();
  expect(view.state.doc.toString()).toBe('hello');
  view.destroy();
});

it('does not return a recovery range when a nested edit changes the rewritten text', () => {
  let armed = false;
  const early = EditorView.updateListener.of((update) => {
    if (update.docChanged && armed) {
      armed = false;
      update.view.dispatch({
        annotations: Transaction.userEvent.of('input.type'),
        changes: { from: 2, insert: 'X' },
      });
    }
  });
  const view = new EditorView({
    state: EditorState.create({ extensions: [early, noteSurfaceUpdateListenerExtension()] }),
    parent: document.body,
  });
  const surface = new NoteSurface(view, { anchor: 'at_cursor' });
  surface.appendProjection('u1', projection('hello'));
  armed = true;
  expect(surface.rewriteRegion({ from: 0, to: 5 }, 'world', []).kind).toBe('rewritten_modified');
  expect(view.state.doc.toString()).toBe('woXrld');
  surface.dispose();
  view.destroy();
});

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
