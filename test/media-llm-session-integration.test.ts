import type { EditorView } from '@codemirror/view';
import type { App, EventRef, TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { processMediaLlm } from '../src/dictation/media-llm-processor';
import { dictationAnchorExtension } from '../src/editor/dictation-anchor-extension';
import { RawTranscriptRecovery } from '../src/editor/raw-transcript-recovery';
import { sessionProcessingExtension } from '../src/editor/session-processing-extension';
import { TemporaryLeafPinLeaseManager } from '../src/editor/temporary-leaf-pin';
import { Session } from '../src/session/session';
import { createFakeLlmRouter } from './fixtures/llm';
import { StateBackedEditorView } from './fixtures/state-backed-editor-view';
import { transcript } from './fixtures/transcript';
import { renderOptions } from './helpers/render-options';

class EventSink {
  on(_name: string, _handler: (...args: never[]) => void): EventRef {
    return { id: Math.random() } as unknown as EventRef;
  }

  offref(_ref: EventRef): void {}
}

describe('media LLM with the real Session', () => {
  it('replaces the recorded range once and restores the exact raw transcript', async () => {
    const file = { path: 'media.md' } as TFile;
    const view = new StateBackedEditorView('Existing note', {
      extensions: [dictationAnchorExtension(), sessionProcessingExtension()],
      selectionHead: 13,
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
    const session = new Session({
      app: { vault, workspace } as unknown as Pick<App, 'vault' | 'workspace'>,
      callbacks: {
        onLockedNoteClosed: vi.fn(),
        onLockedNoteDeleted: vi.fn(),
        onSurfaceDesynchronized: vi.fn(),
      },
      leafPinManager: new TemporaryLeafPinLeaseManager(),
      lockedFile: file,
      placement: { anchor: 'end_of_note' },
      rendererOptions: renderOptions(),
      sessionId: 'session-1',
      view: view as unknown as EditorView,
    });
    session.acceptTranscript(transcript({ text: 'Raw media words', utteranceId: 'media-u1' }));
    const recovery = new RawTranscriptRecovery({
      feedback: { show: vi.fn() },
      getClipboard: () => null,
      workspace: workspace as never,
    });
    const receipts: unknown[] = [];

    const result = await processMediaLlm(session, {
      confirm: async () => true,
      onRawTranscriptRecoveryAvailable: (receipt) => {
        receipts.push(receipt);
        recovery.record(receipt);
      },
      router: createFakeLlmRouter({
        cleanup: async () => ({
          model: 'm',
          providerId: 'ollama' as const,
          text: 'Clean media words.',
        }),
      }),
      signal: new AbortController().signal,
      snapshot: {
        noteContextChars: 0,
        output: 'replace',
        prompt: 'Clean it.',
        showRawBelow: false,
        temperature: 0.2,
        totalContextCap: 0,
        useNoteContext: false,
      },
    });

    expect(result.applied).toBe(true);
    expect(view.state.doc.toString()).toBe('Existing note\nClean media words.');
    expect(receipts).toHaveLength(1);
    expect(recovery.restoreRawTranscript()).toBe(true);
    expect(view.state.doc.toString()).toBe('Existing note\nRaw media words');
    session.dispose();
  });
});
