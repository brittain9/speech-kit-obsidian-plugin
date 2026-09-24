import { randomUUID } from 'node:crypto';
import {
  AudioFileBackpressureGate,
  AudioFileBackpressureTimeoutError,
} from '../audio/audio-file-backpressure';
import {
  AudioFileError,
  assertDecodedAudioWithinBudget,
  createAudioFileCancellationError,
  type DecodedAudioFile,
  isAudioFileCancellation,
  pumpDecodedAudioFrames,
} from '../audio/audio-file-decoder';
import type { NotePlacementOptions, SurfaceDesynchronization } from '../editor/note-surface';
import { dictationLanguageLabel, languageSupportIncludes } from '../language/dictation-language';
import {
  type SelectedModel,
  type SelectedModelCapabilities,
  selectedModelEquals,
} from '../models/model-management-types';
import type { SessionAcceptResult } from '../session/session';
import type { TranscriptRevision } from '../session/session-journal';
import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { FeedbackRequest, UserFeedback } from '../shared/user-feedback';
import type { ContextRequestEvent, SidecarEvent, TranscriptReadyEvent } from '../sidecar/protocol';
import { type SidecarConnection, SidecarError } from '../sidecar/sidecar-connection';
import {
  SidecarLifecycleConflictError,
  type SidecarLifecycleGate,
  type SidecarLifecycleLease,
} from '../sidecar/sidecar-lifecycle-gate';
import { SidecarNotInstalledError } from '../sidecar/sidecar-paths';
import { buildTranscriptSpans, type TranscriptRenderOptions } from '../transcript/renderer';

export type AudioFileTranscriptionState =
  | 'idle'
  | 'selecting'
  | 'preparing'
  | 'transcribing'
  | 'draining'
  | 'error';

type FileWorkflowTranslationKey =
  | 'audio-file-busy'
  | 'audio-file-decoded-memory'
  | 'audio-file-decode-failed'
  | 'audio-file-duration'
  | 'audio-file-empty'
  | 'audio-file-encoded-size'
  | 'audio-file-language-unsupported'
  | 'audio-file-maintenance'
  | 'audio-file-model-changed'
  | 'audio-file-model-duration'
  | 'audio-file-model-not-batch'
  | 'audio-file-model-required'
  | 'audio-file-queue-overload'
  | 'audio-file-read-failed'
  | 'audio-file-sidecar-failed'
  | 'audio-file-sidecar-missing'
  | 'audio-file-start-failed'
  | 'audio-file-target-changed'
  | 'audio-file-target-closed'
  | 'audio-file-target-deleted'
  | 'audio-file-target-required'
  | 'audio-file-transcript-write-failed'
  | 'audio-file-surface-changed';

class AudioFileWorkflowError extends Error {
  constructor(
    readonly translationKey: FileWorkflowTranslationKey,
    readonly parameters: Record<string, string> = {},
    options?: { cause?: unknown },
  ) {
    super(translationKey, options);
    this.name = 'AudioFileWorkflowError';
  }
}

interface AudioFileDecoder {
  decode(file: File, signal: AbortSignal): Promise<DecodedAudioFile>;
}

interface AudioFileSession {
  readonly acceptTranscript: (revision: TranscriptRevision) => SessionAcceptResult;
  readonly clearSessionProcessingMark: () => void;
  readonly dispose: () => void;
  readonly readNoteGlossary: (maxChars: number) => { text: string; truncated: boolean } | null;
}

interface CreateAudioFileSessionOptions {
  readonly callbacks: {
    onLockedNoteClosed: () => void;
    onLockedNoteDeleted: () => void;
    onSurfaceDesynchronized: (failure: SurfaceDesynchronization) => void;
  };
  readonly placement: NotePlacementOptions;
  readonly rendererOptions: TranscriptRenderOptions;
  readonly sessionId: string;
  readonly target: object;
}

interface AudioFileModelConfiguration {
  readonly accelerationPreference: PluginSettings['accelerationPreference'];
  readonly diarizationEnabled: boolean;
  readonly diarizationMaxSpeakers: number | null;
  readonly language: PluginSettings['dictationLanguage'];
  readonly maxModelDurationMs: number | null;
  readonly modelSelection: SelectedModel;
  readonly modelStorePathOverride: string;
  readonly speakingStyle: PluginSettings['speakingStyle'];
}

interface PendingAudioFileStart {
  readonly abortController: AbortController;
  readonly speechLease: SidecarLifecycleLease;
}

interface ManagedAudioFileSession {
  readonly abortController: AbortController;
  readonly backpressure: AudioFileBackpressureGate;
  readonly completion: Promise<void>;
  readonly completionResolve: () => void;
  readonly pendingTranscriptWork: Set<Promise<void>>;
  readonly session: AudioFileSession;
  readonly sessionId: string;
  readonly speechLease: SidecarLifecycleLease;
  readonly timestamps: TranscriptRenderOptions['timestamps'];
  readonly useNoteAsContext: boolean;
  cancellationStarted: boolean;
  feedbackClaimed: boolean;
  phase: 'starting' | 'streaming' | 'stopping' | 'cancelling' | 'stopped';
  stopRequested: boolean;
  stopTimeoutHandle: number | null;
}

export interface AudioFileTranscriptionControllerDependencies {
  readonly backpressureTimeoutMs: number;
  readonly createSession: (options: CreateAudioFileSessionOptions) => AudioFileSession;
  readonly decoder: AudioFileDecoder;
  readonly feedback: Pick<UserFeedback, 'show'>;
  readonly getModelCapabilities: () => SelectedModelCapabilities;
  readonly getSettings: () => PluginSettings;
  readonly getTarget: () => object | null;
  readonly isDictationBusy: () => boolean;
  readonly isSameTarget: (expected: object, actual: object) => boolean;
  readonly logger?: PluginLogger;
  readonly onModelMissing?: () => void;
  readonly onSidecarMissing?: () => void;
  readonly pickAudioFile: (signal: AbortSignal) => Promise<File | null>;
  readonly sessionStopTimeoutMs: number;
  readonly sidecarConnection: Pick<
    SidecarConnection,
    | 'cancelSession'
    | 'ensureStarted'
    | 'requestStopSession'
    | 'sendAudioFrameWithBackpressure'
    | 'sendContextResponse'
    | 'startSession'
    | 'subscribe'
  >;
  readonly sidecarLifecycleGate: SidecarLifecycleGate;
  readonly stopConflictingSpeech: () => void;
}

export class AudioFileTranscriptionController {
  private activeSession: ManagedAudioFileSession | null = null;
  private pendingStart: PendingAudioFileStart | null = null;
  private readonly releaseSidecarSubscription: () => void;
  private state: AudioFileTranscriptionState = 'idle';

  constructor(private readonly dependencies: AudioFileTranscriptionControllerDependencies) {
    this.releaseSidecarSubscription = this.dependencies.sidecarConnection.subscribe((event) => {
      void this.handleSidecarEvent(event);
    });
  }

  getState(): AudioFileTranscriptionState {
    return this.state;
  }

  isBusy(): boolean {
    return this.state !== 'idle';
  }

  isCaptureActive(): boolean {
    return this.isBusy();
  }

  async transcribe(): Promise<void> {
    if (this.isBusy()) {
      this.showWorkflowError(new AudioFileWorkflowError('audio-file-busy'));
      return;
    }

    this.applyState('selecting');
    let speechLease: SidecarLifecycleLease | null = null;
    let releaseStartOperation: (() => void) | null = null;
    let pending: PendingAudioFileStart | null = null;
    const abortController = new AbortController();
    let decodedAudio: DecodedAudioFile | null = null;

    try {
      const target = this.dependencies.getTarget();
      if (target === null) {
        throw new AudioFileWorkflowError('audio-file-target-required');
      }
      if (this.dependencies.isDictationBusy()) {
        throw new AudioFileWorkflowError('audio-file-busy');
      }
      const initialConfiguration = this.resolveModelConfiguration();

      try {
        speechLease = this.dependencies.sidecarLifecycleGate.acquireSpeech();
      } catch (error) {
        if (!(error instanceof SidecarLifecycleConflictError)) {
          throw error;
        }
        this.showWorkflowError(
          new AudioFileWorkflowError('audio-file-maintenance', {}, { cause: error }),
        );
        return;
      }

      releaseStartOperation = speechLease.retain();
      pending = { abortController, speechLease };
      this.pendingStart = pending;
      this.throwIfCancelled(abortController.signal);

      const file = await this.dependencies.pickAudioFile(abortController.signal);
      if (file === null) {
        return;
      }
      this.throwIfCancelled(abortController.signal);

      this.revalidateSelection(target, initialConfiguration.modelSelection, abortController.signal);
      this.dependencies.stopConflictingSpeech();
      this.throwIfCancelled(abortController.signal);
      this.applyState('preparing');

      decodedAudio = await this.dependencies.decoder.decode(file, abortController.signal);
      const configuration = this.resolveModelConfiguration();
      if (!selectedModelEquals(initialConfiguration.modelSelection, configuration.modelSelection)) {
        throw new AudioFileWorkflowError('audio-file-model-changed');
      }
      try {
        assertDecodedAudioWithinBudget(decodedAudio, {
          maxModelDurationMs: configuration.maxModelDurationMs,
        });
      } catch (error) {
        // The budget assertion owns and clears rejected decoded channels.
        decodedAudio = null;
        throw error;
      }
      this.revalidateTarget(target, abortController.signal);

      const sessionId = randomUUID();
      const sessionStartUnixMs = Date.now();
      const rendererOptions = createRendererOptions(
        this.dependencies.getSettings(),
        sessionStartUnixMs,
      );
      const timestamps = rendererOptions.timestamps;
      const settings = this.dependencies.getSettings();
      let session: AudioFileSession;
      try {
        session = this.dependencies.createSession({
          callbacks: {
            onLockedNoteClosed: () => this.failTarget('audio-file-target-closed', sessionId),
            onLockedNoteDeleted: () => this.failTarget('audio-file-target-deleted', sessionId),
            onSurfaceDesynchronized: () => this.failTarget('audio-file-surface-changed', sessionId),
          },
          placement: { anchor: settings.dictationAnchor },
          rendererOptions,
          sessionId,
          target,
        });
      } catch (error) {
        throw new AudioFileWorkflowError('audio-file-target-required', {}, { cause: error });
      }

      const managed = this.createManagedSession({
        abortController,
        session,
        sessionId,
        speechLease,
        timestamps,
        useNoteAsContext: settings.useNoteAsContext,
      });
      this.activeSession = managed;
      if (this.pendingStart === pending) {
        this.pendingStart = null;
      }

      try {
        await this.dependencies.sidecarConnection.ensureStarted();
        this.throwIfCancelled(abortController.signal);
        this.revalidateTarget(target, abortController.signal);
        const finalConfiguration = this.resolveModelConfiguration();
        if (!selectedModelEquals(configuration.modelSelection, finalConfiguration.modelSelection)) {
          throw new AudioFileWorkflowError('audio-file-model-changed');
        }

        await this.dependencies.sidecarConnection.startSession({
          accelerationPreference: finalConfiguration.accelerationPreference,
          detailedTimestampsEnabled: false,
          diarizationEnabled: finalConfiguration.diarizationEnabled,
          diarizationMaxSpeakers: finalConfiguration.diarizationMaxSpeakers,
          includeSystemAudio: false,
          language: finalConfiguration.language,
          mode: 'always_on',
          modelSelection: finalConfiguration.modelSelection,
          sessionId,
          sessionStartUnixMs,
          speakingStyle: finalConfiguration.speakingStyle,
          ...(finalConfiguration.modelStorePathOverride.length > 0
            ? { modelStorePathOverride: finalConfiguration.modelStorePathOverride }
            : {}),
        });
        this.throwIfCancelled(abortController.signal);
        if (managed.phase === 'stopped') {
          await managed.completion;
          return;
        }
        if (managed.phase === 'starting') {
          managed.phase = 'streaming';
        }
        this.applyState('transcribing');

        let frameCount = 0;
        const sourceAudio = decodedAudio;
        if (sourceAudio === null) {
          throw new AudioFileError(
            'decode_failed',
            'Decoded audio was not available for the source.',
          );
        }
        decodedAudio = null;
        await pumpDecodedAudioFrames(sourceAudio, {
          signal: abortController.signal,
          waitForBackpressure: (signal) => managed.backpressure.waitUntilNormal(signal),
          writeFrame: async (frame, signal) => {
            await this.dependencies.sidecarConnection.sendAudioFrameWithBackpressure(
              sessionId,
              frame,
              signal,
            );
            frameCount += 1;
          },
        });
        if (frameCount === 0) {
          throw new AudioFileError(
            'empty',
            'The decoded audio is shorter than one complete transcription frame.',
          );
        }

        this.requestGracefulStop(managed);
        this.applyState('draining');
        await managed.completion;
      } catch (error) {
        await this.handleRunFailure(managed, error);
      }
    } catch (error) {
      this.handleStartFailure(error);
    } finally {
      decodedAudio?.dispose();
      if (this.pendingStart === pending && pending !== null) {
        this.pendingStart = null;
      }
      speechLease?.release();
      releaseStartOperation?.();
      if (this.activeSession === null && this.pendingStart === null) {
        this.applyState(this.state === 'error' ? 'error' : 'idle');
      }
    }
  }

  async cancel(): Promise<void> {
    const pending = this.pendingStart;
    if (pending !== null) {
      pending.abortController.abort(createAudioFileCancellationError());
      pending.speechLease.release();
      return;
    }

    const active = this.activeSession;
    if (active === null) {
      return;
    }
    active.abortController.abort(createAudioFileCancellationError());
    await this.cancelActiveSession(active);
  }

  async dispose(): Promise<void> {
    const pending = this.pendingStart;
    if (pending !== null) {
      pending.abortController.abort(createAudioFileCancellationError());
      pending.speechLease.release();
    }
    const active = this.activeSession;
    if (active !== null) {
      await this.cancelActiveSession(active);
    }
    this.releaseSidecarSubscription();
    if (this.activeSession === null) {
      this.applyState('idle');
    }
  }

  private resolveModelConfiguration(): AudioFileModelConfiguration {
    const settings = this.dependencies.getSettings();
    const selection = settings.selectedModel;
    const capabilities = this.dependencies.getModelCapabilities();
    if (
      selection === null ||
      capabilities.status !== 'ready' ||
      !selectedModelEquals(selection, capabilities.selection)
    ) {
      throw new AudioFileWorkflowError('audio-file-model-required');
    }
    if (capabilities.capabilities.family.task !== 'stt') {
      throw new AudioFileWorkflowError('audio-file-model-required');
    }
    if (capabilities.capabilities.family.supportsStreaming) {
      throw new AudioFileWorkflowError('audio-file-model-not-batch');
    }
    if (
      !languageSupportIncludes(
        capabilities.capabilities.family.supportedLanguages,
        settings.dictationLanguage,
        capabilities.capabilities.family.supportsAutomaticLanguageDetection,
      )
    ) {
      throw new AudioFileWorkflowError('audio-file-language-unsupported', {
        language: dictationLanguageLabel(settings.dictationLanguage),
      });
    }

    return {
      accelerationPreference: settings.accelerationPreference,
      diarizationEnabled: settings.diarizationEnabled,
      diarizationMaxSpeakers: settings.diarizationMaxSpeakers,
      language: settings.dictationLanguage,
      maxModelDurationMs:
        capabilities.capabilities.family.maxAudioDurationSecs === null
          ? null
          : capabilities.capabilities.family.maxAudioDurationSecs * 1_000,
      modelSelection: selection,
      modelStorePathOverride: settings.modelStorePathOverride,
      speakingStyle: settings.speakingStyle,
    };
  }

  private revalidateTarget(target: object, signal: AbortSignal): void {
    this.throwIfCancelled(signal);
    const currentTarget = this.dependencies.getTarget();
    if (currentTarget === null || !this.dependencies.isSameTarget(target, currentTarget)) {
      throw new AudioFileWorkflowError('audio-file-target-changed');
    }
  }

  private revalidateSelection(
    target: object,
    initialSelection: SelectedModel,
    signal: AbortSignal,
  ): void {
    this.revalidateTarget(target, signal);
    const currentSelection = this.dependencies.getSettings().selectedModel;
    const currentCapabilities = this.dependencies.getModelCapabilities();
    if (
      currentSelection === null ||
      currentCapabilities.status !== 'ready' ||
      !selectedModelEquals(initialSelection, currentSelection) ||
      !selectedModelEquals(initialSelection, currentCapabilities.selection)
    ) {
      throw new AudioFileWorkflowError('audio-file-model-changed');
    }
    const currentConfiguration = this.resolveModelConfiguration();
    if (!selectedModelEquals(initialSelection, currentConfiguration.modelSelection)) {
      throw new AudioFileWorkflowError('audio-file-model-changed');
    }
  }

  private createManagedSession(options: {
    abortController: AbortController;
    session: AudioFileSession;
    sessionId: string;
    speechLease: SidecarLifecycleLease;
    timestamps: TranscriptRenderOptions['timestamps'];
    useNoteAsContext: boolean;
  }): ManagedAudioFileSession {
    let completionResolve = (): void => {};
    const completion = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });
    return {
      abortController: options.abortController,
      backpressure: new AudioFileBackpressureGate(this.dependencies.backpressureTimeoutMs),
      completion,
      completionResolve,
      pendingTranscriptWork: new Set(),
      phase: 'starting',
      session: options.session,
      sessionId: options.sessionId,
      speechLease: options.speechLease,
      stopRequested: false,
      stopTimeoutHandle: null,
      timestamps: options.timestamps,
      useNoteAsContext: options.useNoteAsContext,
      cancellationStarted: false,
      feedbackClaimed: false,
    };
  }

  private async handleSidecarEvent(event: SidecarEvent): Promise<void> {
    const entry = this.activeSession;
    if (entry === null) {
      if (event.type === 'error' && event.code === 'sidecar_exited') {
        this.reportFeedback('audio-file-sidecar-failed', event);
      }
      return;
    }
    if ('sessionId' in event && event.sessionId !== entry.sessionId) {
      return;
    }

    switch (event.type) {
      case 'transcription_queue_changed':
        entry.backpressure.update(event.tier);
        return;
      case 'transcript_ready':
        this.handleTranscriptReady(entry, event);
        return;
      case 'context_request':
        this.handleContextRequest(entry, event);
        return;
      case 'session_stopped':
        await this.finalizeStoppedSession(entry, event.reason);
        return;
      case 'error':
        await this.handleSidecarError(entry, event);
        return;
      default:
        return;
    }
  }

  private handleTranscriptReady(entry: ManagedAudioFileSession, event: TranscriptReadyEvent): void {
    if (entry.phase === 'cancelling' || entry.phase === 'stopped') {
      return;
    }
    const work = this.acceptTranscript(entry, event);
    entry.pendingTranscriptWork.add(work);
    const removeWork = (): void => {
      entry.pendingTranscriptWork.delete(work);
    };
    void work.then(removeWork, removeWork);
  }

  private async acceptTranscript(
    entry: ManagedAudioFileSession,
    event: TranscriptReadyEvent,
  ): Promise<void> {
    let result: SessionAcceptResult;
    try {
      const revision = toTranscriptRevision(event, entry.timestamps);
      result = entry.session.acceptTranscript(revision);
    } catch (error) {
      if (entry.phase !== 'cancelling' && entry.phase !== 'stopped') {
        this.reportFeedback('audio-file-transcript-write-failed', error, entry);
        await this.cancelActiveSession(entry);
      }
      return;
    }
    if (result.kind === 'rejected' && entry.phase !== 'cancelling' && entry.phase !== 'stopped') {
      this.reportFeedback('audio-file-transcript-write-failed', new Error(result.reason), entry);
      await this.cancelActiveSession(entry);
    }
  }

  private handleContextRequest(entry: ManagedAudioFileSession, event: ContextRequestEvent): void {
    const glossary = entry.useNoteAsContext
      ? entry.session.readNoteGlossary(event.budgetChars)
      : null;
    try {
      this.dependencies.sidecarConnection.sendContextResponse(
        event.correlationId,
        glossary === null
          ? null
          : {
              budgetChars: event.budgetChars,
              sources: [
                { kind: 'note_glossary', text: glossary.text, truncated: glossary.truncated },
              ],
              text: glossary.text,
              truncated: glossary.truncated,
            },
      );
    } catch (error) {
      this.dependencies.logger?.warn(
        'session',
        'failed to send audio-file context response',
        error,
      );
    }
  }

  private async handleSidecarError(
    entry: ManagedAudioFileSession,
    event: Extract<SidecarEvent, { type: 'error' }>,
  ): Promise<void> {
    if (event.code === 'utterance_queue_overload') {
      this.reportFeedback('audio-file-queue-overload', event, entry);
      entry.abortController.abort(
        new AudioFileError('queue_overload', 'The sidecar queue overloaded.'),
      );
      entry.phase = 'stopping';
      this.requestGracefulStop(entry);
      return;
    }

    this.reportFeedback(
      event.code === 'session_capacity_exceeded'
        ? 'audio-file-start-failed'
        : 'audio-file-sidecar-failed',
      event,
      entry,
    );
    entry.abortController.abort(
      new AudioFileError('sidecar_failed', 'The sidecar failed during audio-file transcription.'),
    );
    await this.cancelActiveSession(entry);
  }

  private async handleRunFailure(entry: ManagedAudioFileSession, error: unknown): Promise<void> {
    if (entry.phase === 'stopping' && isQueueAbort(error)) {
      this.requestGracefulStop(entry);
      await entry.completion;
      return;
    }
    if (isAudioFileCancellation(error) || entry.phase === 'cancelling') {
      await this.cancelActiveSession(entry);
      return;
    }
    if (error instanceof AudioFileBackpressureTimeoutError || isQueueAbort(error)) {
      this.reportFeedback('audio-file-queue-overload', error, entry);
      entry.abortController.abort(
        new AudioFileError('queue_overload', 'The source exceeded the backpressure deadline.'),
      );
      entry.phase = 'stopping';
      this.requestGracefulStop(entry);
      await entry.completion;
      return;
    }

    this.reportWorkflowError(error, entry);
    await this.cancelActiveSession(entry);
  }

  private handleStartFailure(error: unknown): void {
    if (this.activeSession !== null || isAudioFileCancellation(error)) {
      return;
    }
    if (error instanceof SidecarNotInstalledError) {
      this.reportFeedback('audio-file-sidecar-missing', error);
      return;
    }
    this.reportWorkflowError(error);
  }

  private reportWorkflowError(error: unknown, entry?: ManagedAudioFileSession): void {
    const translationKey = resolveWorkflowTranslationKey(error);
    this.reportFeedback(translationKey, error, entry);
  }

  private reportFeedback(
    translationKey: FileWorkflowTranslationKey,
    cause: unknown,
    entry?: ManagedAudioFileSession,
  ): void {
    if (entry !== undefined) {
      if (entry.feedbackClaimed) {
        return;
      }
      entry.feedbackClaimed = true;
    }
    this.dependencies.feedback.show({
      cause,
      intent: resolveFeedbackIntent(translationKey),
      key: translationKey,
      message: t(translationKey, translationParameters(translationKey, cause)),
    });
    if (translationKey === 'audio-file-sidecar-missing') {
      this.dependencies.onSidecarMissing?.();
    }
    if (translationKey === 'audio-file-model-required') {
      this.dependencies.onModelMissing?.();
    }
  }

  private showWorkflowError(error: AudioFileWorkflowError): void {
    this.reportWorkflowError(error);
  }

  private requestGracefulStop(entry: ManagedAudioFileSession): void {
    if (entry.stopRequested || entry.phase === 'stopped' || entry.phase === 'cancelling') {
      return;
    }
    entry.stopRequested = true;
    try {
      this.dependencies.sidecarConnection.requestStopSession(entry.sessionId);
    } catch (error) {
      this.dependencies.logger?.warn(
        'session',
        'failed to request graceful audio-file session stop',
        error,
      );
      void this.cancelActiveSession(entry);
      return;
    }
    entry.stopTimeoutHandle = window.setTimeout(() => {
      void this.handleStopTimeout(entry);
    }, this.dependencies.sessionStopTimeoutMs);
  }

  private async handleStopTimeout(entry: ManagedAudioFileSession): Promise<void> {
    if (entry.phase === 'stopped' || entry.cancellationStarted) {
      return;
    }
    this.dependencies.logger?.warn(
      'session',
      'audio-file session stop timed out; cancelling local session',
    );
    await this.cancelActiveSession(entry);
  }

  private async cancelActiveSession(entry: ManagedAudioFileSession): Promise<void> {
    if (entry.phase === 'stopped') {
      await entry.completion;
      return;
    }
    if (!entry.cancellationStarted) {
      entry.cancellationStarted = true;
      entry.phase = 'cancelling';
      entry.abortController.abort(createAudioFileCancellationError());
      try {
        await this.dependencies.sidecarConnection.cancelSession(entry.sessionId);
      } catch (error) {
        this.dependencies.logger?.warn(
          'session',
          'failed to cancel audio-file session cleanly',
          error,
        );
        await this.finalizeStoppedSession(entry, 'user_cancel');
      }
    }
    await entry.completion;
  }

  private async finalizeStoppedSession(
    entry: ManagedAudioFileSession,
    reason: Extract<SidecarEvent, { type: 'session_stopped' }>['reason'],
  ): Promise<void> {
    if (entry.phase === 'stopped') {
      return;
    }
    if (reason === 'queue_overload') {
      this.reportFeedback('audio-file-queue-overload', new Error(reason), entry);
      entry.abortController.abort(
        new AudioFileError('queue_overload', 'The sidecar queue overloaded.'),
      );
    } else if ((reason === 'session_error' || reason === 'timeout') && !entry.feedbackClaimed) {
      this.reportFeedback('audio-file-sidecar-failed', new Error(reason), entry);
    }
    entry.phase = 'stopped';
    if (entry.stopTimeoutHandle !== null) {
      window.clearTimeout(entry.stopTimeoutHandle);
      entry.stopTimeoutHandle = null;
    }
    entry.speechLease.release();
    if (this.activeSession === entry) {
      this.activeSession = null;
    }
    while (entry.pendingTranscriptWork.size > 0) {
      await Promise.allSettled([...entry.pendingTranscriptWork]);
    }
    try {
      entry.session.clearSessionProcessingMark();
    } catch (error) {
      this.dependencies.logger?.warn(
        'session',
        'failed to clear audio-file processing state',
        error,
      );
    }
    try {
      entry.session.dispose();
    } catch (error) {
      this.dependencies.logger?.warn(
        'session',
        'failed to dispose audio-file editor session',
        error,
      );
    }
    this.applyState('idle');
    entry.completionResolve();
  }

  private failTarget(
    translationKey:
      | 'audio-file-surface-changed'
      | 'audio-file-target-closed'
      | 'audio-file-target-deleted',
    sessionId: string,
  ): void {
    const entry = this.activeSession;
    if (entry === null || entry.sessionId !== sessionId) {
      return;
    }
    this.reportFeedback(translationKey, new Error(translationKey), entry);
    entry.abortController.abort(createAudioFileCancellationError());
    void this.cancelActiveSession(entry);
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : createAudioFileCancellationError();
    }
  }

  private applyState(state: AudioFileTranscriptionState): void {
    this.state = state;
  }
}

function createRendererOptions(
  settings: PluginSettings,
  sessionStartUnixMs: number,
): TranscriptRenderOptions {
  return {
    smartParagraphPauses: {
      lineBreakPauseMs: settings.smartParagraphLineBreakPauseMs,
      paragraphPauseMs: settings.smartParagraphParagraphPauseMs,
    },
    timestamps: {
      clock: settings.timestampClock,
      density: settings.timestampDensity,
      enabled: settings.timestampsEnabled,
      header: settings.timestampSessionHeader,
      sessionStartUnixMs,
      sparseIntervalMs: settings.timestampSparseIntervalMs,
    },
    transcriptFormatting: settings.transcriptFormatting,
  };
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

function resolveWorkflowTranslationKey(error: unknown): FileWorkflowTranslationKey {
  if (error instanceof AudioFileWorkflowError) {
    return error.translationKey;
  }
  if (error instanceof SidecarError) {
    return error.code === 'session_capacity_exceeded'
      ? 'audio-file-start-failed'
      : 'audio-file-sidecar-failed';
  }
  if (error instanceof AudioFileError) {
    switch (error.code) {
      case 'cancelled':
        return 'audio-file-busy';
      case 'decoded_memory':
        return 'audio-file-decoded-memory';
      case 'decode_failed':
      case 'invalid_decode':
        return 'audio-file-decode-failed';
      case 'duration':
        return 'audio-file-duration';
      case 'encoded_size':
        return 'audio-file-encoded-size';
      case 'empty':
        return 'audio-file-empty';
      case 'model_duration':
        return 'audio-file-model-duration';
      case 'queue_overload':
        return 'audio-file-queue-overload';
      case 'read_failed':
        return 'audio-file-read-failed';
      case 'sidecar_failed':
        return 'audio-file-sidecar-failed';
    }
  }
  if (error instanceof AudioFileBackpressureTimeoutError) {
    return 'audio-file-queue-overload';
  }
  return 'audio-file-start-failed';
}

function resolveFeedbackIntent(
  translationKey: FileWorkflowTranslationKey,
): FeedbackRequest['intent'] {
  if (
    translationKey === 'audio-file-maintenance' ||
    translationKey === 'audio-file-queue-overload'
  ) {
    return 'warning';
  }
  if (
    translationKey === 'audio-file-language-unsupported' ||
    translationKey === 'audio-file-model-changed' ||
    translationKey === 'audio-file-model-not-batch' ||
    translationKey === 'audio-file-model-required'
  ) {
    return 'action-required';
  }
  return 'error';
}

function translationParameters(
  translationKey: FileWorkflowTranslationKey,
  error: unknown,
): Record<string, string> {
  if (
    translationKey === 'audio-file-language-unsupported' &&
    error instanceof AudioFileWorkflowError
  ) {
    return error.parameters;
  }
  return {};
}

function isQueueAbort(error: unknown): boolean {
  return error instanceof AudioFileError && error.code === 'queue_overload';
}

export type { AudioFileSession, CreateAudioFileSessionOptions };
