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
import type { RawTranscriptRecoveryReceipt } from '../editor/raw-transcript-recovery';
import { dictationLanguageLabel, languageSupportIncludes } from '../language/dictation-language';
import { resolveActivePresetEntry, resolveEffectiveLlmGlobals } from '../llm/presets';
import type { LlmRouter } from '../llm/router';
import type {
  AcquisitionEvent,
  LocalMediaLease,
  MediaTranscriptionProgress,
} from '../media/media-source';
import {
  type SelectedModel,
  type SelectedModelCapabilities,
  selectedModelEquals,
} from '../models/model-management-types';
import { Session, type SessionTarget } from '../session/session';
import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
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
import {
  type MediaLlmPreview,
  MediaLlmProcessingError,
  type MediaLlmSnapshot,
  processMediaLlm,
} from './media-llm-processor';

export type AudioFileTranscriptionState =
  | 'idle'
  | 'selecting'
  | 'preparing'
  | 'transcribing'
  | 'draining';

interface AudioFileDecoder {
  decode(file: File, signal: AbortSignal): Promise<DecodedAudioFile>;
  decodeMedia?(lease: LocalMediaLease, signal: AbortSignal): Promise<DecodedAudioFile>;
}

interface MediaPickerSource {
  acquirePicked(signal: AbortSignal): AsyncIterable<AcquisitionEvent>;
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
  readonly target: SessionTarget;
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
  readonly confirmMediaLlm?: (preview: MediaLlmPreview, signal: AbortSignal) => Promise<boolean>;
  readonly createLlmRouter?: (settings: PluginSettings) => LlmRouter | null;
  readonly createSession: (options: CreateAudioFileSessionOptions) => AudioFileEditorSession;
  readonly decoder: AudioFileDecoder;
  readonly feedback: Pick<UserFeedback, 'show'>;
  readonly getModelCapabilities: () => SelectedModelCapabilities;
  readonly getSettings: () => PluginSettings;
  readonly getTarget: () => SessionTarget | null;
  readonly isDictationBusy: () => boolean;
  readonly logger?: PluginLogger;
  readonly onModelMissing?: () => void;
  readonly onRawTranscriptRecoveryAvailable?: (receipt: RawTranscriptRecoveryReceipt) => void;
  readonly onSidecarMissing?: () => void;
  readonly pickAudioFile: (signal: AbortSignal) => Promise<File | null>;
  readonly mediaSource?: MediaPickerSource;
  readonly onMediaProgress?: (progress: MediaTranscriptionProgress) => void;
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
  private mediaProgress: MediaTranscriptionProgress | null = null;
  private readonly quarantinedSessions = new Map<string, QuarantinedAudioFileSession>();
  private readonly userCancelledSessions = new WeakSet<ManagedAudioFileSession>();
  private readonly postCompletionCancelledSessions = new WeakSet<ManagedAudioFileSession>();
  private postCompletionAbortController: AbortController | null = null;
  private readonly releaseSidecarSubscription: () => void;
  private state: AudioFileTranscriptionState = 'idle';

  constructor(private readonly dependencies: AudioFileTranscriptionControllerDependencies) {
    this.failureMapper = new AudioFileFailureMapper({
      feedback: dependencies.feedback,
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

  getMediaProgress(): MediaTranscriptionProgress | null {
    return this.mediaProgress;
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
    let mediaLease: LocalMediaLease | null = null;
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

      this.emitProgress('acquire');
      let file: File | null = null;
      if (this.dependencies.mediaSource === undefined) {
        file = await this.dependencies.pickAudioFile(abortController.signal);
      } else {
        mediaLease = await this.acquireMediaLease(abortController.signal);
        if (mediaLease === null) return;
      }
      if (this.dependencies.mediaSource === undefined && file === null) return;
      this.throwIfCancelled(abortController.signal);

      this.revalidateSelection(
        target,
        initialConfiguration.modelSelection,
        initialConfiguration.language,
        abortController.signal,
      );
      this.dependencies.stopConflictingSpeech();
      this.throwIfCancelled(abortController.signal);
      this.applyState('preparing');

      this.emitProgress('decode');
      if (mediaLease === null) {
        if (file === null) {
          throw new AudioFileError('read_failed', 'The local media source returned no file.');
        }
        decodedAudio = await this.dependencies.decoder.decode(file, abortController.signal);
      } else {
        decodedAudio = await this.decodeMediaLease(mediaLease, abortController.signal);
      }
      const configuration = this.resolveModelConfiguration();
      if (!selectedModelEquals(initialConfiguration.modelSelection, configuration.modelSelection)) {
        throw new AudioFileWorkflowError('audio-file-model-changed');
      }
      if (configuration.language !== initialConfiguration.language) {
        throw new AudioFileWorkflowError('audio-file-language-changed');
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
        (phase) => this.emitProgress(phase),
      );
      managed = ManagedAudioFileSession.create(
        {
          abortController,
          backpressure: new AudioFileBackpressureGate(this.dependencies.backpressureTimeoutMs),
          sessionId,
          speechLease,
          useNoteAsContext: settings.useNoteAsContext,
        },
        transcript,
      );
      this.activeSession = managed;
      const managedSession = managed;
      managedSession.setPostCompletion(async () => {
        await this.runMediaLlmPostCompletion(managedSession, transcript, settings);
      });
      if (this.pendingStart === pending) this.pendingStart = null;

      try {
        this.throwIfCancelled(abortController.signal);
        this.revalidateSelection(
          target,
          initialConfiguration.modelSelection,
          initialConfiguration.language,
          abortController.signal,
        );
        const finalConfiguration = this.resolveModelConfiguration();

        const startOperation = this.startManagedSession(
          managed,
          finalConfiguration,
          sessionStartUnixMs,
          target,
          initialConfiguration.modelSelection,
        );
        managed.setStartOperation(startOperation);
        await startOperation;
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
        this.emitProgress('transcribe');

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
        this.throwIfCancelled(abortController.signal);
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
        this.failureMapper.reportFailure(error);
      }
    } finally {
      decodedAudio?.dispose();
      await mediaLease?.release();
      if (this.pendingStart === pending && pending !== null) this.pendingStart = null;
      if (managed === null) speechLease?.release();
      releaseStartOperation?.();
      if (this.activeSession === null && this.pendingStart === null) {
        this.applyState('idle');
      }
    }
  }

  async cancel(): Promise<void> {
    this.postCompletionAbortController?.abort(createAudioFileCancellationError());
    const pending = this.pendingStart;
    if (pending !== null) {
      pending.abortController.abort(createAudioFileCancellationError());
      pending.speechLease.release();
      return;
    }
    const active = this.activeSession;
    if (active === null) return;
    this.userCancelledSessions.add(active);
    this.postCompletionCancelledSessions.add(active);
    active.abortController.abort(createAudioFileCancellationError());
    await this.cancelManagedSession(active);
  }

  async dispose(): Promise<void> {
    this.postCompletionAbortController?.abort(createAudioFileCancellationError());
    const pending = this.pendingStart;
    if (pending !== null) {
      pending.abortController.abort(createAudioFileCancellationError());
      pending.speechLease.release();
    }
    const active = this.activeSession;
    if (active !== null) {
      this.userCancelledSessions.add(active);
      this.postCompletionCancelledSessions.add(active);
      const startCompletion = active.getStartCompletion();
      await this.cancelManagedSession(active);
      await startCompletion;
    }
    this.releaseSidecarSubscription();
    if (this.activeSession === null) this.applyState('idle');
  }

  private async acquireMediaLease(signal: AbortSignal): Promise<LocalMediaLease | null> {
    const source = this.dependencies.mediaSource;
    if (source === undefined) {
      return null;
    }
    for await (const event of source.acquirePicked(signal)) {
      if (event.type === 'ready') {
        if (signal.aborted) {
          await event.lease.release();
          this.throwIfCancelled(signal);
        }
        return event.lease;
      }
      this.throwIfCancelled(signal);
      switch (event.type) {
        case 'plan':
          this.emitProgress('acquire');
          break;
        case 'progress':
          this.emitProgress('acquire', {
            ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
            ...(event.totalBytes === undefined ? {} : { totalBytes: event.totalBytes }),
          });
          break;
        case 'warning':
          this.dependencies.logger?.warn('audio', event.message, event.code);
          break;
      }
    }
    return null;
  }

  private async decodeMediaLease(
    lease: LocalMediaLease,
    signal: AbortSignal,
  ): Promise<DecodedAudioFile> {
    if (this.dependencies.decoder.decodeMedia === undefined) {
      throw new AudioFileError('decode_failed', 'The media decoder does not support media leases.');
    }
    return await this.dependencies.decoder.decodeMedia(lease, signal);
  }

  private async runMediaLlmPostCompletion(
    managed: ManagedAudioFileSession,
    transcript: AudioFileTranscriptAdapter,
    settings: PluginSettings,
  ): Promise<void> {
    if (this.postCompletionCancelledSessions.has(managed)) {
      return;
    }
    if (!settings.mediaLlmProcessing || !settings.llmFeaturesEnabled) {
      return;
    }
    if (
      this.dependencies.createLlmRouter === undefined ||
      this.dependencies.confirmMediaLlm === undefined
    ) {
      this.feedbackMediaLlm('media-llm-failed');
      return;
    }
    const session = transcript.getMediaLlmSession();
    const router = this.dependencies.createLlmRouter(settings);
    if (session === null || router === null) {
      this.feedbackMediaLlm('media-llm-failed');
      return;
    }
    const snapshot = createMediaLlmSnapshot(settings);
    const abortController = new AbortController();
    this.postCompletionAbortController = abortController;
    this.emitProgress('ai_processing');
    try {
      await processMediaLlm(session, {
        confirm: this.dependencies.confirmMediaLlm,
        onRawTranscriptRecoveryAvailable: (receipt) => {
          this.dependencies.onRawTranscriptRecoveryAvailable?.(receipt);
        },
        router,
        signal: abortController.signal,
        snapshot,
      });
    } catch (error) {
      if (error instanceof MediaLlmProcessingError) {
        if (error.code === 'cancelled') {
          return;
        }
        this.feedbackMediaLlm(
          error.code === 'empty'
            ? 'media-llm-empty'
            : error.code === 'range_unavailable'
              ? 'media-llm-range-unavailable'
              : 'media-llm-failed',
        );
        return;
      }
      this.feedbackMediaLlm('media-llm-failed');
    } finally {
      if (this.postCompletionAbortController === abortController) {
        this.postCompletionAbortController = null;
      }
    }
  }

  private feedbackMediaLlm(
    key:
      | 'media-llm-cancelled'
      | 'media-llm-empty'
      | 'media-llm-failed'
      | 'media-llm-range-unavailable',
  ): void {
    this.dependencies.feedback.show({
      intent: key === 'media-llm-cancelled' ? 'information' : 'warning',
      key,
      message: t(key),
    });
  }

  private emitProgress(
    phase: MediaTranscriptionProgress['phase'],
    details: { bytes?: number; totalBytes?: number } = {},
  ): void {
    this.mediaProgress = { phase, ...details };
    this.dependencies.onMediaProgress?.(this.mediaProgress);
  }

  private async startManagedSession(
    managed: ManagedAudioFileSession,
    configuration: AudioFileModelConfiguration,
    sessionStartUnixMs: number,
    target: SessionTarget,
    initialSelection: SelectedModel,
  ): Promise<void> {
    const options: StartSessionControlOptions = {
      abortSignal: managed.abortController.signal,
      beforeCommandWrite: () =>
        this.revalidateSelection(
          target,
          initialSelection,
          configuration.language,
          managed.abortController.signal,
        ),
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

  private revalidateTarget(target: SessionTarget, signal: AbortSignal): void {
    this.throwIfCancelled(signal);
    const currentTarget = this.dependencies.getTarget();
    if (currentTarget === null || !Session.targetsEqual(target, currentTarget)) {
      throw new AudioFileWorkflowError('audio-file-target-changed');
    }
  }

  private revalidateSelection(
    target: SessionTarget,
    initialSelection: SelectedModel,
    initialLanguage: PluginSettings['dictationLanguage'],
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
    if (currentConfiguration.language !== initialLanguage) {
      throw new AudioFileWorkflowError('audio-file-language-changed');
    }
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

    this.failureMapper.reportFailure(error, managed);
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

  private cancelManagedSession(managed: ManagedAudioFileSession): Promise<void> {
    return managed.runCancellation(() => this.performManagedCancellation(managed));
  }

  private async performManagedCancellation(managed: ManagedAudioFileSession): Promise<void> {
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
      if (isSuccessfulCancellationResult(result, managed.sessionId)) {
        await this.finishManagedSession(managed, 'cancelled', false);
      } else {
        await this.quarantineManagedSession(managed, new Error('Unexpected cancellation result'));
      }
    } catch (error) {
      if (this.failureMapper.isNoActiveSession(error, managed.sessionId)) {
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
    if (!this.userCancelledSessions.has(managed)) {
      this.failureMapper.reportTranslation('audio-file-shutdown-uncertain', error, managed);
    }
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
    reason:
      | AudioFileSessionPhase
      | 'cancelled'
      | 'cancelled-before-start'
      | 'no-active-session'
      | 'session-stopped',
    quarantined: boolean,
    runPostCompletion = false,
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
    await managed.transcript.drainPendingProjections();
    if (runPostCompletion && !quarantined) {
      try {
        await managed.runPostCompletion();
      } catch (error) {
        this.dependencies.logger?.warn('llm', 'media transcript post-completion failed', error);
      }
    }
    if (this.activeSession === managed) this.activeSession = null;
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
        if (!this.userCancelledSessions.has(active)) {
          this.failureMapper.reportTranslation('audio-file-sidecar-failed', event, active);
        }
        active.abortController.abort(createAudioFileCancellationError());
        await this.finishManagedSession(active, 'cancelled', false);
      }
      return;
    }

    if (event.type === 'session_stopped') {
      this.releaseQuarantinedLease(event.sessionId);
      const active = this.activeSession;
      if (active === null || active.sessionId !== event.sessionId) return;
      active.abortController.abort(createAudioFileCancellationError());
      await this.finishManagedSession(
        active,
        'session-stopped',
        false,
        event.reason === 'user_stop' || event.reason === 'sentence_complete',
      );
      return;
    }

    if (event.type === 'warning' && event.code === 'no_active_session') {
      if (event.sessionId === undefined) return;
      this.releaseQuarantinedLease(event.sessionId);
      const active = this.activeSession;
      if (active === null || active.sessionId !== event.sessionId) return;
      active.abortController.abort(createAudioFileCancellationError());
      await this.finishManagedSession(active, 'no-active-session', false);
      return;
    }

    const active = this.activeSession;
    if (active === null) return;
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
    if (state === 'idle') {
      this.mediaProgress = null;
    }
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

function createMediaLlmSnapshot(settings: PluginSettings): MediaLlmSnapshot {
  const activePreset = resolveActivePresetEntry(
    settings.llmPostprocessActivePresetRef,
    settings.llmPostprocessUserPresets,
  ).preset;
  const effective = resolveEffectiveLlmGlobals(
    {
      minWords: settings.llmPostprocessSkipMinWords,
      temperature: settings.llmPostprocessTemperature,
      useNoteContext: settings.useLlmNoteContext,
    },
    activePreset,
  );
  return {
    noteContextChars: effective.useNoteContext ? settings.llmPostprocessNoteContextChars : 0,
    output: activePreset.output,
    prompt: activePreset.prompt,
    showRawBelow: settings.llmPostprocessShowRawBelow,
    temperature: effective.temperature,
    totalContextCap: settings.llmPostprocessTotalContextCap,
    useNoteContext: effective.useNoteContext,
  };
}

function isSuccessfulCancellationResult(
  result: CancelSessionResult,
  expectedSessionId: string,
): boolean {
  return (
    (result.type === 'session_stopped' && result.sessionId === expectedSessionId) ||
    (result.type === 'warning' &&
      result.code === 'no_active_session' &&
      result.sessionId === expectedSessionId)
  );
}
