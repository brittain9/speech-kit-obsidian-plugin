import { describe, expect, it, vi } from 'vitest';
import type { MediaLlmEditorSession } from '../src/dictation/audio-file-transcript-adapter';
import {
  type MediaLlmProcessingError,
  type MediaLlmSnapshot,
  processMediaLlm,
} from '../src/dictation/media-llm-processor';
import type { RawTranscriptRecoveryReceipt } from '../src/editor/raw-transcript-recovery';
import { ProviderError } from '../src/llm/provider';
import type { SessionRangeReplacementResult } from '../src/session/session';
import { createFakeLlmRouter } from './fixtures/llm';

class FakeMediaSession implements MediaLlmEditorSession {
  public readonly clearSessionProcessingMark = vi.fn();
  public readonly insertAdjacentToSessionRange = vi.fn(
    (_text: string, _placement: 'above' | 'below', _options?: { rejectUserEdits?: boolean }) =>
      true,
  );
  public readonly markSessionRangeAsProcessing = vi.fn(() => true);
  public readonly readNoteText = vi.fn((_maxChars: number) => ({
    text: 'Bounded note context',
    truncated: false,
  }));
  public readonly replaceSessionRangeWithCleaned = vi.fn(
    (
      text: string,
      options?: { rawTextForCallout?: string; rejectUserEdits?: boolean; showRawBelow?: boolean },
    ): SessionRangeReplacementResult => ({
      kind: 'replaced' as const,
      recovery: {
        documentText: text,
        file: {} as never,
        filePath: 'note.md',
        from: 0,
        rawText: options?.rawTextForCallout ?? '',
        to: text.length,
        transformedText: text,
        view: {} as never,
      },
    }),
  );
  public readonly setAnchorMode = vi.fn((_mode: 'hidden' | 'visible') => {});

  constructor(private readonly rawText = 'Raw media transcript') {}

  joinRawSessionText(): string {
    return this.rawText;
  }
}

const replaceSnapshot: MediaLlmSnapshot = {
  noteContextChars: 100,
  output: 'replace',
  prompt: 'Clean this transcript.',
  showRawBelow: true,
  temperature: 0.2,
  totalContextCap: 50,
  useNoteContext: true,
};

describe('media LLM processing', () => {
  it('uses only bounded text context, confirms explicitly, and applies one recoverable replacement', async () => {
    const session = new FakeMediaSession();
    const cleanup = vi.fn(async (_options: unknown) => ({
      model: 'local-model',
      providerId: 'ollama' as const,
      text: 'Clean media transcript.',
    }));
    const router = createFakeLlmRouter({ cleanup, providerId: 'ollama' });
    const confirm = vi.fn(async () => true);
    const recoveries: RawTranscriptRecoveryReceipt[] = [];

    const result = await processMediaLlm(session, {
      confirm,
      onRawTranscriptRecoveryAvailable: (receipt) => recoveries.push(receipt),
      router,
      signal: new AbortController().signal,
      snapshot: replaceSnapshot,
    });

    expect(result).toEqual({ applied: true, text: 'Clean media transcript.' });
    expect(confirm).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage:
          '<note_context>\nBounded note context\n</note_context>\n\n<media_transcript>\nRaw media transcript\n</media_transcript>',
      }),
    );
    const payload = cleanup.mock.calls[0]?.[0];
    expect(JSON.stringify(payload)).not.toMatch(/path|filename|source|cookie|token|audio/i);
    expect(session.replaceSessionRangeWithCleaned).toHaveBeenCalledOnce();
    expect(session.replaceSessionRangeWithCleaned).toHaveBeenCalledWith(
      'Clean media transcript.',
      expect.objectContaining({ rawTextForCallout: 'Raw media transcript', rejectUserEdits: true }),
    );
    expect(recoveries[0]?.rawText).toBe('Raw media transcript');
    expect(session.clearSessionProcessingMark).toHaveBeenCalledOnce();
  });

  it('keeps remote-provider payloads text-only as well', async () => {
    const session = new FakeMediaSession();
    const cleanup = vi.fn(async (_options: unknown) => ({
      model: 'remote-model',
      providerId: 'openrouter' as const,
      text: 'Remote result.',
    }));
    const router = createFakeLlmRouter({ cleanup, providerId: 'openrouter' });

    await processMediaLlm(session, {
      confirm: async () => true,
      onRawTranscriptRecoveryAvailable: vi.fn(),
      router,
      signal: new AbortController().signal,
      snapshot: { ...replaceSnapshot, useNoteContext: false, noteContextChars: 0 },
    });

    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: '<media_transcript>\nRaw media transcript\n</media_transcript>',
      }),
    );
  });

  it('keeps the raw range for add-above and add-below outputs', async () => {
    for (const output of ['add_above', 'add_below'] as const) {
      const session = new FakeMediaSession();
      const router = createFakeLlmRouter({
        cleanup: async () => ({
          model: 'm',
          providerId: 'ollama' as const,
          text: 'Generated block',
        }),
      });
      await processMediaLlm(session, {
        confirm: async () => true,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router,
        signal: new AbortController().signal,
        snapshot: { ...replaceSnapshot, output },
      });

      expect(session.insertAdjacentToSessionRange).toHaveBeenCalledWith(
        'Generated block',
        output === 'add_above' ? 'above' : 'below',
        { rejectUserEdits: true },
      );
      expect(session.replaceSessionRangeWithCleaned).not.toHaveBeenCalled();
    }
  });

  it('keeps raw text on empty output and reports a typed failure', async () => {
    const session = new FakeMediaSession();
    const router = createFakeLlmRouter({
      cleanup: async () => ({ model: 'm', providerId: 'ollama' as const, text: '  ' }),
    });

    await expect(
      processMediaLlm(session, {
        confirm: async () => true,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router,
        signal: new AbortController().signal,
        snapshot: replaceSnapshot,
      }),
    ).rejects.toMatchObject<Partial<MediaLlmProcessingError>>({ code: 'empty' });
    expect(session.replaceSessionRangeWithCleaned).not.toHaveBeenCalled();
  });

  it('keeps raw text and surfaces a provider failure', async () => {
    const session = new FakeMediaSession();
    const router = createFakeLlmRouter({
      cleanup: async () => {
        throw new Error('provider unavailable');
      },
    });

    await expect(
      processMediaLlm(session, {
        confirm: async () => true,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router,
        signal: new AbortController().signal,
        snapshot: replaceSnapshot,
      }),
    ).rejects.toThrow('provider unavailable');
    expect(session.replaceSessionRangeWithCleaned).not.toHaveBeenCalled();
  });

  it('never overwrites a range that became user-edited while the provider was pending', async () => {
    const session = new FakeMediaSession();
    session.replaceSessionRangeWithCleaned.mockReturnValue({
      kind: 'denied',
    });
    const router = createFakeLlmRouter({
      cleanup: async () => ({ model: 'm', providerId: 'ollama' as const, text: 'Late result' }),
    });

    await expect(
      processMediaLlm(session, {
        confirm: async () => true,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router,
        signal: new AbortController().signal,
        snapshot: replaceSnapshot,
      }),
    ).rejects.toMatchObject<Partial<MediaLlmProcessingError>>({ code: 'range_unavailable' });
  });

  it('does not call the provider for an empty raw transcript', async () => {
    const session = new FakeMediaSession('   ');
    const cleanup = vi.fn(async () => ({
      model: 'm',
      providerId: 'ollama' as const,
      text: 'Result',
    }));
    await expect(
      processMediaLlm(session, {
        confirm: async () => true,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router: createFakeLlmRouter({ cleanup }),
        signal: new AbortController().signal,
        snapshot: replaceSnapshot,
      }),
    ).rejects.toMatchObject<Partial<MediaLlmProcessingError>>({ code: 'empty' });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('aborts an opt-out before provider work and after confirmation', async () => {
    const session = new FakeMediaSession();
    const cleanup = vi.fn(async () => ({
      model: 'm',
      providerId: 'ollama' as const,
      text: 'Result',
    }));
    await expect(
      processMediaLlm(session, {
        confirm: async () => true,
        isEnabled: () => false,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router: createFakeLlmRouter({ cleanup }),
        signal: new AbortController().signal,
        snapshot: replaceSnapshot,
      }),
    ).rejects.toMatchObject<Partial<MediaLlmProcessingError>>({ code: 'cancelled' });
    expect(cleanup).not.toHaveBeenCalled();

    const controller = new AbortController();
    const pending = processMediaLlm(new FakeMediaSession(), {
      confirm: async () => {
        controller.abort();
        return true;
      },
      onRawTranscriptRecoveryAvailable: vi.fn(),
      router: createFakeLlmRouter({
        cleanup: async () => ({ model: 'm', providerId: 'ollama' as const, text: 'Result' }),
      }),
      signal: controller.signal,
      snapshot: replaceSnapshot,
    });
    await expect(pending).rejects.toMatchObject<Partial<MediaLlmProcessingError>>({
      code: 'cancelled',
    });
  });

  it('maps an aborted provider error to cancellation', async () => {
    const controller = new AbortController();
    const router = createFakeLlmRouter({
      cleanup: async () => {
        controller.abort();
        throw new ProviderError('aborted by transport', 'aborted');
      },
    });
    await expect(
      processMediaLlm(new FakeMediaSession(), {
        confirm: async () => true,
        onRawTranscriptRecoveryAvailable: vi.fn(),
        router,
        signal: controller.signal,
        snapshot: replaceSnapshot,
      }),
    ).rejects.toMatchObject<Partial<MediaLlmProcessingError>>({ code: 'cancelled' });
  });
});
