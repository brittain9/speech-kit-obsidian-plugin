import { describe, expect, it, vi } from 'vitest';

import { AudioFileBackpressureGate } from '../src/audio/audio-file-backpressure';
import { ManagedAudioFileSession } from '../src/dictation/audio-file-session-lifecycle';
import type { AudioFileTranscriptAdapter } from '../src/dictation/audio-file-transcript-adapter';
import { SidecarLifecycleGate } from '../src/sidecar/sidecar-lifecycle-gate';
import { timestamps } from './helpers/render-options';

describe('ManagedAudioFileSession public lifecycle cleanup', () => {
  it('cleans up a completed managed session through the narrow public API', async () => {
    const abortController = new AbortController();
    const lifecycleGate = new SidecarLifecycleGate();
    const speechLease = lifecycleGate.acquireSpeech();
    const transcript = {
      timestamps: timestamps(),
    } as unknown as AudioFileTranscriptAdapter;
    const managed = ManagedAudioFileSession.create(
      {
        abortController,
        backpressure: new AudioFileBackpressureGate(100),
        sessionId: 'cleanup-session',
        speechLease,
        useNoteAsContext: false,
      },
      transcript,
    );

    const completion = managed.getCompletion();
    managed.markStartIssued();
    managed.markStartAcknowledged();
    expect(managed.markStreaming()).toBe(true);
    managed.setStopTimeout(window.setTimeout(vi.fn(), 10_000));
    managed.markStopped();
    managed.complete();

    await expect(completion).resolves.toBeUndefined();
    expect(managed.isTerminal()).toBe(true);
    expect(managed.canAcceptSidecarWork()).toBe(false);
    const mutationLease = lifecycleGate.acquireMutation();
    mutationLease.release();
  });
});
