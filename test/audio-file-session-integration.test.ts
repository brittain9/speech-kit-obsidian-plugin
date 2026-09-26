import type { EditorView } from '@codemirror/view';
import type { App, EventRef, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { AudioFileTranscriptAdapter } from '../src/dictation/audio-file-transcript-adapter';
import { dictationAnchorExtension } from '../src/editor/dictation-anchor-extension';
import { provisionalTranscriptExtension } from '../src/editor/provisional-transcript-extension';
import { TemporaryLeafPinLeaseManager } from '../src/editor/temporary-leaf-pin';
import { Session } from '../src/session/session';
import type { TranscriptReadyEvent } from '../src/sidecar/protocol';
import { StateBackedEditorView } from './fixtures/state-backed-editor-view';
import { renderOptions } from './helpers/render-options';

class EventSink {
  on(_name: string, _handler: (...args: never[]) => void): EventRef {
    return { id: Math.random() } as unknown as EventRef;
  }

  offref(_ref: EventRef): void {}
}

function transcriptEvent(sessionId: string): TranscriptReadyEvent {
  return {
    isFinal: true,
    pauseMsBeforeUtterance: null,
    processingDurationMs: 1,
    revision: 0,
    segments: [
      {
        endMs: 500,
        speaker: null,
        startMs: 0,
        text: 'Inserted through the real Session.',
        timestampGranularity: 'utterance',
        timestampSource: 'vad',
      },
    ],
    sessionId,
    speakerIndex: null,
    stageResults: [],
    text: 'Inserted through the real Session.',
    type: 'transcript_ready',
    utteranceDurationMs: 500,
    utteranceEndMsInSession: 500,
    utteranceId: 'utterance-real-session',
    utteranceIndex: 0,
    utteranceStartMsInSession: 0,
    warnings: [],
  };
}

describe('AudioFileTranscriptAdapter with the real Session', () => {
  it('inserts one complete transcript and disposes the actual editor session', async () => {
    const file = { path: 'audio-file.md' } as TFile;
    const view = new StateBackedEditorView('', {
      extensions: [dictationAnchorExtension(), provisionalTranscriptExtension()],
      selectionHead: 0,
    });
    const workspaceEvents = new EventSink();
    const vaultEvents = new EventSink();
    const workspace = {
      activeEditor: { editor: { cm: view }, file },
      getActiveFile: () => file,
      getLeavesOfType: () => [{ view: { editor: { cm: view }, file } }],
      offref: (ref: EventRef) => workspaceEvents.offref(ref),
      on: (name: string, handler: (...args: never[]) => void) => workspaceEvents.on(name, handler),
    };
    const vault = {
      offref: (ref: EventRef) => vaultEvents.offref(ref),
      on: (name: string, handler: (...args: never[]) => void) => vaultEvents.on(name, handler),
    };
    const app = { vault, workspace } as unknown as Pick<App, 'vault' | 'workspace'>;
    const session = new Session({
      app,
      callbacks: {
        onLockedNoteClosed: vi.fn(),
        onLockedNoteDeleted: vi.fn(),
        onSurfaceDesynchronized: vi.fn(),
      },
      leafPinManager: new TemporaryLeafPinLeaseManager(),
      lockedFile: file,
      placement: { anchor: 'at_cursor' },
      rendererOptions: renderOptions(),
      sessionId: 'real-session',
      view: view as unknown as EditorView,
    });
    const onProjectionFailure = vi.fn();
    const adapter = new AudioFileTranscriptAdapter(
      session,
      renderOptions().timestamps,
      onProjectionFailure,
    );

    adapter.handleTranscript(transcriptEvent('real-session'));
    await vi.waitFor(() => {
      expect(view.state.doc.toString()).toBe('Inserted through the real Session.');
    });
    expect(onProjectionFailure).not.toHaveBeenCalled();

    await adapter.drainPendingProjections();
    adapter.disposeSession();
    expect(view.state.doc.toString()).toBe('Inserted through the real Session.');
  });
});
