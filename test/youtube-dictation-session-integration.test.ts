// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { App, EventRef, TFile } from 'obsidian';
import { expect, it, vi } from 'vitest';
import { AudioFileTranscriptAdapter } from '../src/dictation/audio-file-transcript-adapter';
import { dictationAnchorExtension } from '../src/editor/dictation-anchor-extension';
import { noteSurfaceUpdateListenerExtension } from '../src/editor/note-surface';
import { provisionalTranscriptExtension } from '../src/editor/provisional-transcript-extension';
import { TemporaryLeafPinLeaseManager } from '../src/editor/temporary-leaf-pin';
import { Session } from '../src/session/session';
import type { TranscriptReadyEvent } from '../src/sidecar/protocol';
import { transcript } from './fixtures/transcript';
import { renderOptions } from './helpers/render-options';

it.each(['at_cursor', 'end_of_note'] as const)(
  'preserves live revisions and imported captions in one note with %s placement',
  async (anchor) => {
    const initialText = 'Typed before.\n\n';
    const view = new EditorView({
      state: EditorState.create({
        doc: initialText,
        selection: { anchor: initialText.length },
        extensions: [
          dictationAnchorExtension(),
          provisionalTranscriptExtension(),
          noteSurfaceUpdateListenerExtension(),
        ],
      }),
      parent: document.body,
    });
    const file = { path: 'public-concurrent-workflows.md' } as TFile;
    const events = { on: () => ({}) as EventRef, offref: () => {} };
    const leaves = [{ view: { editor: { cm: view }, file } }];
    const app = {
      vault: events,
      workspace: {
        ...events,
        activeEditor: { editor: { cm: view }, file },
        getActiveFile: () => file,
        getLeavesOfType: () => leaves,
      },
    } as unknown as Pick<App, 'workspace' | 'vault'>;
    const failure = vi.fn();
    const options = { ...renderOptions(), transcriptFormatting: 'space' as const };
    const createSession = (sessionId: string) =>
      new Session({
        app,
        callbacks: {
          onLockedNoteClosed: failure,
          onLockedNoteDeleted: failure,
          onSurfaceDesynchronized: failure,
        },
        leafPinManager: new TemporaryLeafPinLeaseManager(),
        lockedFile: file,
        pinNoteDuringTranscription: false,
        placement: { anchor },
        rendererOptions: options,
        sessionId,
        view,
      });
    const dictation = createSession('dictation');
    let captions: Session | null = null;
    try {
      expect(
        dictation.acceptTranscript(
          transcript({
            sessionId: 'dictation',
            utteranceId: 'speech-1',
            text: 'Spoken begin',
            isFinal: false,
          }),
        ),
      ).toEqual({ kind: 'accepted' });
      captions = createSession('captions');
      const adapter = new AudioFileTranscriptAdapter(
        captions,
        options.timestamps,
        failure,
        undefined,
        true,
        options,
      );
      const captionEvent: TranscriptReadyEvent = {
        ...transcript({
          sessionId: 'captions',
          utteranceId: 'captions-1',
          text: 'Imported captions.',
        }),
        processingDurationMs: 0,
        segments: [],
        stageResults: [],
        type: 'transcript_ready',
        utteranceDurationMs: 100,
        warnings: [],
      };
      adapter.handleTranscript(captionEvent);
      await adapter.commitStaged();
      adapter.disposeSession();
      dictation.acceptTranscript(
        transcript({
          sessionId: 'dictation',
          utteranceId: 'speech-1',
          text: 'Spoken beginning.',
          revision: 1,
        }),
      );
      dictation.acceptTranscript(
        transcript({
          sessionId: 'dictation',
          utteranceId: 'speech-2',
          utteranceIndex: 1,
          text: 'Spoken ending.',
        }),
      );
      expect(view.state.doc.toString()).toBe(
        anchor === 'at_cursor'
          ? 'Typed before.\n\nSpoken beginning. Spoken ending. Imported captions.'
          : 'Typed before.\n\nSpoken beginning. Spoken ending.\nImported captions.',
      );
      expect(dictation.replaceSessionRangeWithCleaned('Cleaned dictation.').kind).toBe('replaced');
      expect(view.state.doc.toString()).toBe(
        anchor === 'at_cursor'
          ? 'Typed before.\n\nCleaned dictation. Imported captions.'
          : 'Typed before.\n\nCleaned dictation.\nImported captions.',
      );
      expect(failure).not.toHaveBeenCalled();
      expect(dictation.wasLastTranscriptInserted()).toBe(true);
    } finally {
      dictation.dispose();
      captions?.dispose();
      view.destroy();
    }
  },
);
