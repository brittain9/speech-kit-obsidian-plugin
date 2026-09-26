import type { SessionAcceptResult, SessionRangeReplacementResult } from '../session/session';
import type { TranscriptRevision } from '../session/session-journal';
import type { TranscriptReadyEvent } from '../sidecar/protocol';
import {
  buildTranscriptSpans,
  TranscriptRenderer,
  type TranscriptRenderOptions,
} from '../transcript/renderer';

export interface AudioFileEditorSession {
  readonly acceptTranscript: (revision: TranscriptRevision) => SessionAcceptResult;
  readonly clearSessionProcessingMark: () => void;
  readonly dispose: () => void;
  readonly readNoteGlossary: (maxChars: number) => { text: string; truncated: boolean } | null;
  readonly wasLastTranscriptInserted?: () => boolean;
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
  private readonly staged = new Map<string, TranscriptReadyEvent>();
  private stagedCharacters = 0;

  constructor(
    private readonly session: AudioFileEditorSession,
    readonly timestamps: TranscriptRenderOptions['timestamps'],
    private readonly onProjectionFailure: (error: unknown) => void,
    private readonly onProjectionPhase?: (phase: 'format' | 'insert') => void,
    private readonly stageUntilComplete = false,
    private readonly renderOptions?: TranscriptRenderOptions,
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
    if (this.stageUntilComplete) {
      const previous = this.staged.get(event.utteranceId);
      if (
        previous !== undefined &&
        (previous.revision > event.revision ||
          (previous.revision === event.revision && previous.isFinal))
      )
        return;
      const nextCharacters =
        this.stagedCharacters - (previous?.text.length ?? 0) + event.text.length;
      if (nextCharacters > 16 * 1024 * 1024) {
        this.onProjectionFailure(new Error('The staged transcript exceeded its safety limit.'));
        return;
      }
      this.stagedCharacters = nextCharacters;
      this.staged.set(event.utteranceId, event);
      return;
    }
    this.onProjectionPhase?.('format');
    const projection = this.projectTranscript(event);
    this.pendingProjections.add(projection);
    const removeProjection = (): void => {
      this.pendingProjections.delete(projection);
    };
    void projection.then(removeProjection, removeProjection);
  }

  getPartialText(): string {
    return this.orderedStaged()
      .map((event) => event.text.trim())
      .filter(Boolean)
      .join(' ');
  }

  async commitStaged(): Promise<void> {
    if (!this.stageUntilComplete) return;
    const events = this.orderedStaged();
    if (events.length === 0 || events.some((event) => !event.isFinal)) {
      throw new Error('The speech engine did not finish every transcript segment.');
    }
    if (this.renderOptions === undefined)
      throw new Error('Transcript rendering options are missing.');
    this.onProjectionPhase?.('format');
    const renderer = new TranscriptRenderer(this.renderOptions);
    const chunks: string[] = [];
    let tail = '';
    for (const event of events) {
      const revision = toTranscriptRevision(event, this.timestamps);
      const projection = renderer.planAppend(
        {
          pauseMsBeforeUtterance: revision.pauseMsBeforeUtterance,
          spans: revision.spans,
          utteranceId: revision.utteranceId,
          utteranceStartMsInSession: revision.utteranceStartMsInSession,
        },
        { tailContent: tail },
      );
      chunks.push(projection.projectedText);
      tail = (tail + projection.projectedText).slice(-16);
      renderer.commitAppend(projection);
    }
    const rendered = chunks.join('');
    const first = events[0];
    const last = events.at(-1);
    if (first === undefined || last === undefined) throw new Error('The transcript is empty.');
    const combined: TranscriptRevision = {
      ...toTranscriptRevision(first, this.timestamps),
      isFinal: true,
      revision: 0,
      segments: [],
      spans: [{ speakerIndex: null, text: rendered }],
      speakerIndex: null,
      text: rendered,
      utteranceEndMsInSession: last.utteranceEndMsInSession,
    };
    const result = this.session.acceptTranscript(combined);
    if (result.kind === 'rejected') throw new Error(result.reason);
    if (result.kind !== 'accepted' || this.session.wasLastTranscriptInserted?.() === false) {
      throw new Error('The completed transcript could not be inserted into the note.');
    }
    this.staged.clear();
    this.stagedCharacters = 0;
    await this.drainPendingProjections();
    this.onProjectionPhase?.('insert');
  }

  private orderedStaged(): TranscriptReadyEvent[] {
    return [...this.staged.values()].sort(
      (left, right) =>
        left.utteranceIndex - right.utteranceIndex ||
        left.utteranceStartMsInSession - right.utteranceStartMsInSession,
    );
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
    } else if (result.kind === 'accepted' && (this.session.wasLastTranscriptInserted?.() ?? true)) {
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
