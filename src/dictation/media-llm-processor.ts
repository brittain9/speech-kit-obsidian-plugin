import type { RawTranscriptRecoveryReceipt } from '../editor/raw-transcript-recovery';
import { mediaLlmIncludesNoteContext } from '../llm/media-llm-policy';
import type { LlmPresetOutput } from '../llm/presets';
import { ProviderError } from '../llm/provider';
import type { LlmRouter, LlmRouterCleanupResult } from '../llm/router';
import { resolveLlmOutputBehavior } from '../llm/transform-policy';
import type { MediaLlmEditorSession } from './audio-file-transcript-adapter';

export interface MediaLlmProcessingPolicy {
  readonly noteContextChars: number;
  readonly output: LlmPresetOutput;
  readonly prompt: string;
  readonly showRawBelow: boolean;
  readonly temperature: number;
  readonly totalContextCap: number;
  readonly useNoteContext: boolean;
}

export type MediaLlmSnapshot = MediaLlmProcessingPolicy;

export type MediaLlmProcessingErrorCode =
  | 'cancelled'
  | 'empty'
  | 'failed'
  | 'range_unavailable'
  | 'refused';

export class MediaLlmProcessingError extends Error {
  constructor(
    readonly code: MediaLlmProcessingErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MediaLlmProcessingError';
  }
}

export interface MediaLlmProcessorDependencies {
  readonly isEnabled?: () => boolean;
  readonly onRawTranscriptRecoveryAvailable: (receipt: RawTranscriptRecoveryReceipt) => void;
  readonly router: LlmRouter;
  readonly signal: AbortSignal;
  readonly snapshot: MediaLlmSnapshot;
  readonly transcriptText?: string;
}

/**
 * The only LLM boundary for media jobs. Its input type deliberately contains
 * text and bounded note context, not a media lease or provenance object.
 */
export async function processMediaLlm(
  session: MediaLlmEditorSession,
  dependencies: MediaLlmProcessorDependencies,
): Promise<{ readonly text: string }> {
  const rawText = dependencies.transcriptText ?? session.joinRawSessionText();
  if (rawText.trim().length === 0) {
    throw new MediaLlmProcessingError(
      'empty',
      'The media transcript is empty. Record or select a non-empty transcript before AI processing.',
    );
  }

  assertEnabled(dependencies);
  session.setAnchorMode('hidden');
  if (!session.markSessionRangeAsProcessing()) {
    throw new MediaLlmProcessingError(
      'range_unavailable',
      'The media transcript range changed before AI processing could start.',
    );
  }

  try {
    assertEnabled(dependencies);
    const noteContext = readBoundedNoteContext(session, dependencies.snapshot);
    const userMessage = formatMediaLlmMessage(noteContext, rawText);
    let result: LlmRouterCleanupResult;
    try {
      result = await dependencies.router.cleanup({
        abortSignal: dependencies.signal,
        prompt: dependencies.snapshot.prompt,
        temperature: dependencies.snapshot.temperature,
        transcriptChars: rawText.length,
        userMessage,
      });
    } catch (error) {
      if (
        dependencies.signal.aborted ||
        (error instanceof ProviderError && error.code === 'aborted')
      ) {
        throw new MediaLlmProcessingError('cancelled', 'Media AI processing was cancelled.', {
          cause: error,
        });
      }
      throw error;
    }
    assertEnabled(dependencies);
    throwIfCancelled(dependencies.signal);

    const text = result.text.trim();
    if (text.length === 0) {
      throw new MediaLlmProcessingError(
        'empty',
        'The configured AI provider returned no media transcript text. The raw transcript was kept.',
      );
    }
    if (isBareProviderRefusal(text)) {
      throw new MediaLlmProcessingError(
        'refused',
        'The AI model declined this transcript. The raw transcript was kept.',
      );
    }

    assertEnabled(dependencies);
    throwIfCancelled(dependencies.signal);
    const outputBehavior = resolveLlmOutputBehavior(dependencies.snapshot.output);
    if (outputBehavior.kind === 'replace') {
      const replacement = session.replaceSessionRangeWithCleaned(text, {
        rawTextForCallout: rawText,
        rejectUserEdits: true,
        showRawBelow: dependencies.snapshot.showRawBelow,
      });
      if (replacement.kind === 'denied') {
        throw new MediaLlmProcessingError(
          'range_unavailable',
          'The media transcript was edited while AI processing was pending; the raw text was kept.',
        );
      }
      dependencies.onRawTranscriptRecoveryAvailable(replacement.recovery);
    } else {
      const inserted = session.insertAdjacentToSessionRange(text, outputBehavior.placement, {
        rejectUserEdits: true,
      });
      if (!inserted) {
        throw new MediaLlmProcessingError(
          'range_unavailable',
          'The media transcript was edited while AI processing was pending; the raw text was kept.',
        );
      }
    }

    return { text };
  } finally {
    session.clearSessionProcessingMark();
  }
}

function isBareProviderRefusal(text: string): boolean {
  if (text.length > 240) return false;
  return /^(?:i(?:'m| am) sorry,? (?:but )?)?(?:i (?:cannot|can'?t|am unable to) (?:assist with|help with|comply with) (?:that|this|your) request|i (?:cannot|can'?t) (?:provide|fulfill) (?:that|this) request)[.!]?$/iu.test(
    text.trim(),
  );
}

function readBoundedNoteContext(
  session: MediaLlmEditorSession,
  snapshot: MediaLlmSnapshot,
): string {
  if (
    !mediaLlmIncludesNoteContext({
      noteContextChars: snapshot.noteContextChars,
      totalContextCap: snapshot.totalContextCap,
      useNoteContext: snapshot.useNoteContext,
    })
  ) {
    return '';
  }
  const note = session.readNoteText(snapshot.noteContextChars);
  if (note === null) {
    return '';
  }
  const context = note.text.trim();
  return context.slice(0, Math.max(0, snapshot.totalContextCap));
}

function formatMediaLlmMessage(noteContext: string, transcriptText: string): string {
  const sections: string[] = [];
  if (noteContext.length > 0) {
    sections.push(`<note_context>\n${noteContext}\n</note_context>`);
  }
  sections.push(`<media_transcript>\n${transcriptText.trim()}\n</media_transcript>`);
  return sections.join('\n\n');
}

function assertEnabled(dependencies: MediaLlmProcessorDependencies): void {
  throwIfCancelled(dependencies.signal);
  if (dependencies.isEnabled?.() === false) {
    throw new MediaLlmProcessingError('cancelled', 'Media AI processing was disabled.');
  }
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MediaLlmProcessingError('cancelled', 'Media AI processing was cancelled.');
  }
}
