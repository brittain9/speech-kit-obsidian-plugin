import type { SessionAcceptResult, SessionRangeReplacementResult } from '../session/session';
import type { TranscriptRevision } from '../session/session-journal';
import type { TranscriptReadyEvent } from '../sidecar/protocol';
import { buildTranscriptSpans, type TranscriptRenderOptions } from '../transcript/renderer';

export interface AudioFileEditorSession {
  readonly acceptTranscript: (revision: TranscriptRevision) => SessionAcceptResult;
  readonly clearSessionProcessingMark: () => void;
  readonly dispose: () => void;
  readonly readNoteGlossary: (maxChars: number) => { text: string; truncated: boolean } | null;
}

export interface MediaLlmEditorSession {
  readonly clearSessionProcessingMark: () => void;
  readonly insertAdjacentToSessionRange: (
    blockText: string,
    placement: 'above' | 'below',
    options?: { rejectUserEdits?: boolean },
  ) => boolean;
  readonly joinRawSessionText: () => string;
  readonly markSessionRangeAsProcessing: () => boolean;
  readonly readNoteText: (maxChars: number) => { text: string; truncated: boolean } | null;
  readonly replaceSessionRangeWithCleaned: (
    cleanText: string,
    options?: { rawTextForCallout?: string; rejectUserEdits?: boolean; showRawBelow?: boolean },
  ) => SessionRangeReplacementResult;
  readonly setAnchorMode: (mode: 'hidden' | 'visible') => void;
}

export class AudioFileTranscriptAdapter {
  private readonly pendingProjections = new Set<Promise<void>>();

  constructor(
    private readonly session: AudioFileEditorSession,
    readonly timestamps: TranscriptRenderOptions['timestamps'],
    private readonly onProjectionFailure: (error: unknown) => void,
    private readonly onProjectionPhase?: (phase: 'format' | 'insert') => void,
  ) {}

  readNoteGlossary(maxChars: number): { text: string; truncated: boolean } | null {
    return this.session.readNoteGlossary(maxChars);
  }

  getMediaLlmSession(): MediaLlmEditorSession | null {
    const candidate = this.session as Partial<MediaLlmEditorSession>;
    return typeof candidate.joinRawSessionText === 'function' &&
      typeof candidate.markSessionRangeAsProcessing === 'function' &&
      typeof candidate.readNoteText === 'function' &&
      typeof candidate.replaceSessionRangeWithCleaned === 'function' &&
      typeof candidate.insertAdjacentToSessionRange === 'function' &&
      typeof candidate.setAnchorMode === 'function'
      ? (candidate as MediaLlmEditorSession)
      : null;
  }

  handleTranscript(event: TranscriptReadyEvent): void {
    this.onProjectionPhase?.('format');
    const projection = this.projectTranscript(event);
    this.pendingProjections.add(projection);
    const removeProjection = (): void => {
      this.pendingProjections.delete(projection);
    };
    void projection.then(removeProjection, removeProjection);
  }

  async drainPendingProjections(): Promise<void> {
    while (this.pendingProjections.size > 0) {
      await Promise.allSettled([...this.pendingProjections]);
    }
  }

  disposeSession(): void {
    let cleanupError: Error | null = null;
    try {
      this.session.clearSessionProcessingMark();
    } catch (error) {
      cleanupError = toError(error);
    }
    try {
      this.session.dispose();
    } catch (error) {
      cleanupError ??= toError(error);
    }
    if (cleanupError !== null) throw cleanupError;
  }

  private async projectTranscript(event: TranscriptReadyEvent): Promise<void> {
    let result: SessionAcceptResult;
    try {
      result = this.session.acceptTranscript(toTranscriptRevision(event, this.timestamps));
    } catch (error) {
      this.onProjectionFailure(error);
      return;
    }

    if (result.kind === 'rejected') {
      this.onProjectionFailure(new Error(result.reason));
    } else {
      this.onProjectionPhase?.('insert');
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toTranscriptRevision(
  event: TranscriptReadyEvent,
  timestamps: TranscriptRenderOptions['timestamps'],
): TranscriptRevision {
  const text = event.text.trim();
  return {
    isFinal: event.isFinal,
    llmPostprocessRawText: null,
    pauseMsBeforeUtterance: event.pauseMsBeforeUtterance,
    revision: event.revision,
    segments: event.segments,
    sessionId: event.sessionId,
    speakerIndex: event.speakerIndex,
    spans: buildTranscriptSpans(event.segments, text, event.speakerIndex, {
      timestamps,
      utteranceStartMsInSession: event.utteranceStartMsInSession,
    }),
    stageResults: event.stageResults,
    text,
    utteranceEndMsInSession: event.utteranceEndMsInSession,
    utteranceId: event.utteranceId,
    utteranceIndex: event.utteranceIndex,
    utteranceStartMsInSession: event.utteranceStartMsInSession,
  };
}
