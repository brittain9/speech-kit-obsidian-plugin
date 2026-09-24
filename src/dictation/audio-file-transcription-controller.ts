import { randomUUID } from 'node:crypto';

import { Platform } from 'obsidian';

import {
  AudioFileBackpressureGate,
  AudioFileBackpressureTimeoutError,
} from '../audio/audio-file-backpressure';
import {
  AudioFileError,
  assertDecodedAudioWithinBudget,
  createAudioFileCancellationError,
  type DecodedAudioFile,
  pumpDecodedAudioFrames,
} from '../audio/audio-file-decoder';
import type { NotePlacementOptions, SurfaceDesynchronization } from '../editor/note-surface';
import { dictationLanguageLabel, languageSupportIncludes } from '../language/dictation-language';
import {
  type SelectedModel,
  type SelectedModelCapabilities,
  selectedModelEquals,
} from '../models/model-management-types';
import type { PluginSettings } from '../settings/plugin-settings';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import type { ContextRequestEvent, SidecarEvent } from '../sidecar/protocol';
import type {
  CancelSessionResult,
  SidecarConnection,
  StartSessionControlOptions,
} from '../sidecar/sidecar-connection';
import {
  SidecarLifecycleConflictError,
  type SidecarLifecycleGate,
  type SidecarLifecycleLease,
} from '../sidecar/sidecar-lifecycle-gate';
import type { TranscriptRenderOptions } from '../transcript/renderer';
import {
  AudioFileFailureMapper,
  AudioFileWorkflowError,
  type FileWorkflowTranslationKey,
} from './audio-file-failure';
import {
  type AudioFileSessionPhase,
  ManagedAudioFileSession,
} from './audio-file-session-lifecycle';
import {
  type AudioFileEditorSession,
  AudioFileTranscriptAdapter,
} from './audio-file-transcript-adapter';

export type AudioFileTranscriptionState =
  | 'idle'
  | 'selecting'
  | 'preparing'
  | 'transcribing'
  | 'draining'
  | 'error';

interface AudioFileDecoder {
  decode(file: File, signal: AbortSignal): Promise<DecodedAudioFile>;
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

interface QuarantinedAudioFileSession {
  readonly lease: SidecarLifecycleLease;
  readonly sessionId: string;
}

export interface AudioFileTranscriptionControllerDependencies {
  readonly backpressureTimeoutMs: number;
  readonly createSession: (options: CreateAudioFileSessionOptions) => AudioFileEditorSession;
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
    | 'requestStopSession'
    | 'sendAudioFrameWithBackpressure'
    | 'sendContextResponse'
    | 'startSessionWithControl'
    | 'subscribe'
  >;
  readonly sidecarLifecycleGate: SidecarLifecycleGate;
  readonly stopConflictingSpeech: () => void;
}

export class AudioFileTranscriptionController {
  private activeSession: ManagedAudioFileSession | null = null;
  private readonly failureMapper: AudioFileFailureMapper;
  private pendingStart: PendingAudioFileStart | null = null;
  private readonly quarantinedSessions = new Map<string, QuarantinedAudioFileSession>();
  private readonly releaseSidecarSubscription: () => void;
  private state: AudioFileTranscriptionState = 'idle';

  constructor(private readonly dependencies: AudioFileTranscriptionControllerDependencies) {
    this.failureMapper = new AudioFileFailureMapper({
      feedback: dependencies.feedback,
      ...(dependencies.logger !== undefined ? { logger: dependencies.logger } : {}),
      ...(dependencies.onModelMissing !== undefined
        ? { onModelMissing: dependencies.onModelMissing }
        : {}),
      ...(dependencies.onSidecarMissing !== undefined
        ? { onSidecarMissing: dependencies.onSidecarMissing }
        : {}),
    });
    this.releaseSidecarSubscription = dependencies.sidecarConnection.subscribe((event) => {
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
    // Keep this guard before the busy check: mobile callers must not mutate a
    // running desktop workflow or open a native-only picker accidentally.
    if (!Platform.isDesktopApp) {
      this.failureMapper.reportTranslation('audio-file-desktop-only', new Error('Mobile runtime'));
      return;
    }
    if (this.isBusy()) {
      this.failureMapper.reportTranslation('audio-file-busy', new Error('Audio file is busy'));
      return;
    }

    this.applyState('selecting');
    const abortController = new AbortController();
    let decodedAudio: DecodedAudioFile | null = null;
    let pending: PendingAudioFileStart | null = null;
    let speechLease: SidecarLifecycleLease | null = null;
    let releaseStartOperation: (() => void) | null = null;
    let managed: ManagedAudioFileSession | null = null;

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
        if (!(error instanceof SidecarLifecycleConflictError)) throw error;
        throw new AudioFileWorkflowError('audio-file-maintenance', {}, { cause: error });
      }
      releaseStartOperation = speechLease.retain();
      pending = { abortController, speechLease };
      this.pendingStart = pending;

      const file = await this.dependencies.pickAudioFile(abortController.signal);
      if (file === null) return;
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
        decodedAudio = null;
        throw error;
      }
      this.revalidateTarget(target, abortController.signal);

      const sessionId = randomUUID();
      const sessionStartUnixMs = Date.now();
      const settings = this.dependencies.getSettings();
      const rendererOptions = createRendererOptions(settings, sessionStartUnixMs);
      let session: AudioFileEditorSession;
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

      const transcript = new AudioFileTranscriptAdapter(
        session,
        rendererOptions.timestamps,
        (error) => this.handleProjectionFailure(managed, error),
      );
      managed = ManagedAudioFileSession.create(
        {
          abortController,
          backpressure: new AudioFileBackpressureGate(this.dependencies.backpressureTimeoutMs),
          sessionId,
          speechLease,
          timestamps: rendererOptions.timestamps,
          useNoteAsContext: settings.useNoteAsContext,
        },
        transcript,
      );
      this.activeSession = managed;
      if (this.pendingStart === pending) this.pendingStart = null;

      try {
        this.throwIfCancelled(abortController.signal);
        this.revalidateTarget(target, abortController.signal);
        const finalConfiguration = this.resolveModelConfiguration();
        if (!selectedModelEquals(configuration.modelSelection, finalConfiguration.modelSelection)) {
          throw new AudioFileWorkflowError('audio-file-model-changed');
        }

        await this.startManagedSession(managed, finalConfiguration, sessionStartUnixMs);
        this.throwIfCancelled(abortController.signal);
        if (managed.isTerminal()) {
          await managed.getCompletion();
          return;
        }
        if (!managed.markStreaming()) {
          await managed.getCompletion();
          return;
        }
        this.applyState('transcribing');

        const sourceAudio = decodedAudio;
        if (sourceAudio === null) {
          throw new AudioFileError(
            'decode_failed',
            'Decoded audio was not available for the source.',
          );
        }
        decodedAudio = null;
        let frameCount = 0;
        await pumpDecodedAudioFrames(sourceAudio, {
          signal: abortController.signal,
          waitForBackpressure: (signal) =>
            managed?.backpressure.waitUntilNormal(signal) ?? Promise.resolve(),
          writeFrame: async (frame, signal) => {
            if (managed === null) throw createAudioFileCancellationError();
            await this.dependencies.sidecarConnection.sendAudioFrameWithBackpressure(
              managed.sessionId,
              frame,
              signal,
            );
            frameCount += 1;
          },
        });
        if (frameCount === 0) {
          throw new AudioFileError(
            'empty',
            'The decoded audio is shorter than one complete frame.',
          );
        }

        this.requestGracefulStop(managed);
        this.applyState('draining');
        await managed.getCompletion();
      } catch (error) {
        await this.handleManagedFailure(managed, error);
      }
    } catch (error) {
      if (managed === null && !this.failureMapper.isCancellation(error)) {
        this.failureMapper.reportStartFailure(error);
      }
    } finally {
      decodedAudio?.dispose();
      if (this.pendingStart === pending && pending !== null) this.pendingStart = null;
      if (managed === null) speechLease?.release();
      releaseStartOperation?.();
      if (this.activeSession === null && this.pendingStart === null) {
        this.applyState('idle');
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
    if (active === null) return;
    active.abortController.abort(createAudioFileCancellationError());
    await this.cancelManagedSession(active);
  }

  async dispose(): Promise<void> {
    const pending = this.pendingStart;
    if (pending !== null) {
      pending.abortController.abort(createAudioFileCancellationError());
      pending.speechLease.release();
    }
    const active = this.activeSession;
    if (active !== null) await this.cancelManagedSession(active);
    this.releaseSidecarSubscription();
    if (this.activeSession === null) this.applyState('idle');
  }

  private async startManagedSession(
    managed: ManagedAudioFileSession,
    configuration: AudioFileModelConfiguration,
    sessionStartUnixMs: number,
  ): Promise<void> {
    const options: StartSessionControlOptions = {
      abortSignal: managed.abortController.signal,
      onCommandIssued: () => managed.markStartIssued(),
    };
    await this.dependencies.sidecarConnection.startSessionWithControl(
      {
        accelerationPreference: configuration.accelerationPreference,
        detailedTimestampsEnabled: false,
        diarizationEnabled: configuration.diarizationEnabled,
        diarizationMaxSpeakers: configuration.diarizationMaxSpeakers,
        includeSystemAudio: false,
        language: configuration.language,
        mode: 'always_on',
        modelSelection: configuration.modelSelection,
        sessionId: managed.sessionId,
        sessionStartUnixMs,
        speakingStyle: configuration.speakingStyle,
        ...(configuration.modelStorePathOverride.length > 0
          ? { modelStorePathOverride: configuration.modelStorePathOverride }
          : {}),
      },
      options,
    );
    managed.markStartAcknowledged();
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
    this.resolveModelConfiguration();
  }

  private async handleManagedFailure(
    managed: ManagedAudioFileSession,
    error: unknown,
  ): Promise<void> {
    if (managed.isTerminal()) {
      await managed.getCompletion();
      return;
    }
    if (this.failureMapper.isCancellation(error)) {
      await this.cancelManagedSession(managed);
      return;
    }
    if (
      this.failureMapper.isQueueAbort(error) ||
      error instanceof AudioFileBackpressureTimeoutError
    ) {
      this.failureMapper.reportTranslation('audio-file-queue-overload', error, managed);
      managed.abortController.abort(
        new AudioFileError('queue_overload', 'Source backpressure aborted.'),
      );
      await this.cancelManagedSession(managed);
      return;
    }

    this.failureMapper.reportManagedFailure(error, managed);
    await this.cancelManagedSession(managed);
  }

  private handleProjectionFailure(managed: ManagedAudioFileSession | null, error: unknown): void {
    if (managed === null || managed.isTerminal()) return;
    this.failureMapper.reportTranslation('audio-file-transcript-write-failed', error, managed);
    managed.abortController.abort(createAudioFileCancellationError());
    void this.cancelManagedSession(managed);
  }

  private requestGracefulStop(managed: ManagedAudioFileSession): void {
    if (!managed.requestStop()) return;
    try {
      this.dependencies.sidecarConnection.requestStopSession(managed.sessionId);
    } catch (error) {
      this.dependencies.logger?.warn('session', 'failed to request audio-file stop', error);
      void this.cancelManagedSession(managed);
      return;
    }
    managed.setStopTimeout(
      window.setTimeout(() => {
        void this.cancelManagedSession(managed);
      }, this.dependencies.sessionStopTimeoutMs),
    );
  }

  private async cancelManagedSession(managed: ManagedAudioFileSession): Promise<void> {
    if (managed.isTerminal()) {
      await managed.getCompletion();
      return;
    }
    if (!managed.isStartIssued()) {
      managed.abortController.abort(createAudioFileCancellationError());
      await this.finishManagedSession(managed, 'cancelled-before-start', false);
      return;
    }

    managed.requestCancel();
    managed.abortController.abort(createAudioFileCancellationError());
    try {
      const result = await this.dependencies.sidecarConnection.cancelSession(managed.sessionId);
      if (isSuccessfulCancellationResult(result)) {
        await this.finishManagedSession(managed, 'cancelled', false);
      } else {
        await this.quarantineManagedSession(managed, new Error('Unexpected cancellation result'));
      }
    } catch (error) {
      if (this.failureMapper.isNoActiveSession(error)) {
        await this.finishManagedSession(managed, 'no-active-session', false);
        return;
      }
      await this.quarantineManagedSession(managed, error);
    }
  }

  private async quarantineManagedSession(
    managed: ManagedAudioFileSession,
    error: unknown,
  ): Promise<void> {
    this.dependencies.logger?.warn(
      'session',
      'audio-file cancellation was not acknowledged',
      error,
    );
    if (managed.isTerminal()) {
      await managed.getCompletion();
      return;
    }
    const lease = managed.transferLeaseToQuarantine();
    this.quarantinedSessions.set(managed.sessionId, { lease, sessionId: managed.sessionId });
    await this.finishManagedSession(managed, 'quarantined', true);
  }

  private async finishManagedSession(
    managed: ManagedAudioFileSession,
    reason: AudioFileSessionPhase | 'cancelled' | 'cancelled-before-start' | 'no-active-session',
    quarantined: boolean,
  ): Promise<void> {
    if (managed.isTerminal()) {
      await managed.getCompletion();
      return;
    }
    if (quarantined) {
      managed.markQuarantined();
    } else {
      managed.markStopped();
    }
    if (this.activeSession === managed) this.activeSession = null;
    await managed.transcript.drainPendingProjections();
    try {
      managed.transcript.disposeSession();
    } catch (error) {
      this.dependencies.logger?.warn(
        'session',
        `failed to dispose audio-file session (${reason})`,
        error,
      );
    }
    this.applyState('idle');
    managed.complete();
  }

  private async handleSidecarEvent(event: SidecarEvent): Promise<void> {
    if (event.type === 'error' && event.code === 'sidecar_exited') {
      this.releaseAllQuarantinedLeases();
      const active = this.activeSession;
      if (active !== null) {
        active.abortController.abort(createAudioFileCancellationError());
        await this.finishManagedSession(active, 'cancelled', false);
      }
      return;
    }

    const active = this.activeSession;
    if (active === null) {
      if (event.type === 'session_stopped') this.releaseQuarantinedLease(event.sessionId);
      return;
    }
    if ('sessionId' in event && event.sessionId !== active.sessionId) return;

    switch (event.type) {
      case 'transcription_queue_changed':
        active.backpressure.update(event.tier);
        return;
      case 'transcript_ready':
        if (active.canAcceptSidecarWork()) active.transcript.handleTranscript(event);
        return;
      case 'context_request':
        if (active.canAcceptSidecarWork()) this.handleContextRequest(active, event);
        return;
      case 'session_stopped':
        active.abortController.abort(createAudioFileCancellationError());
        await this.finishManagedSession(active, 'cancelled', false);
        return;
      case 'warning':
        if (event.code === 'no_active_session') {
          active.abortController.abort(createAudioFileCancellationError());
          await this.finishManagedSession(active, 'no-active-session', false);
        }
        return;
      case 'error':
        if (event.code === 'utterance_queue_overload') {
          this.failureMapper.reportTranslation('audio-file-queue-overload', event, active);
          active.abortController.abort(new AudioFileError('queue_overload', 'Queue overload.'));
          void this.cancelManagedSession(active);
          return;
        }
        this.failureMapper.reportTranslation('audio-file-sidecar-failed', event, active);
        active.abortController.abort(new AudioFileError('sidecar_failed', 'Sidecar failed.'));
        void this.cancelManagedSession(active);
        return;
      default:
        return;
    }
  }

  private handleContextRequest(managed: ManagedAudioFileSession, event: ContextRequestEvent): void {
    const glossary = managed.useNoteAsContext
      ? managed.transcript.readNoteGlossary(event.budgetChars)
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
      this.dependencies.logger?.warn('session', 'failed to send audio-file context', error);
    }
  }

  private failTarget(
    translationKey: Extract<
      FileWorkflowTranslationKey,
      'audio-file-surface-changed' | 'audio-file-target-closed' | 'audio-file-target-deleted'
    >,
    sessionId: string,
  ): void {
    const managed = this.activeSession;
    if (managed === null || managed.sessionId !== sessionId || managed.isTerminal()) return;
    this.failureMapper.reportTranslation(translationKey, new Error(translationKey), managed);
    managed.abortController.abort(createAudioFileCancellationError());
    void this.cancelManagedSession(managed);
  }

  private releaseQuarantinedLease(sessionId: string): void {
    const quarantined = this.quarantinedSessions.get(sessionId);
    if (quarantined === undefined) return;
    this.quarantinedSessions.delete(sessionId);
    quarantined.lease.release();
  }

  private releaseAllQuarantinedLeases(): void {
    for (const quarantined of this.quarantinedSessions.values()) quarantined.lease.release();
    this.quarantinedSessions.clear();
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

function isSuccessfulCancellationResult(result: CancelSessionResult): boolean {
  return (
    result.type === 'session_stopped' ||
    (result.type === 'warning' && result.code === 'no_active_session')
  );
}
