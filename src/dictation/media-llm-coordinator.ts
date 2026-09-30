import type { RawTranscriptRecoveryReceipt } from '../editor/raw-transcript-recovery';
import {
  formatLlmProviderName,
  getProviderModel,
  type LlmProviderId,
  ProviderError,
} from '../llm/provider';
import { type LlmReadinessIssueCode, resolveLlmReadiness } from '../llm/readiness';
import type { LlmRouter } from '../llm/router';
import { selectLlmProviderId } from '../llm/routing-policy';
import { llmSettingsFingerprint } from '../llm/settings-fingerprint';
import { resolveLlmTransformSnapshot } from '../llm/transform-policy';
import type { MediaTranscriptionProgress } from '../media/media-source';
import type { PluginSettings } from '../settings/plugin-settings';
import { type TranslationKey, t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import type { MediaLlmEditorSession } from './audio-file-transcript-adapter';
import {
  MediaLlmProcessingError,
  type MediaLlmSnapshot,
  processMediaLlm,
} from './media-llm-processor';

export interface MediaLlmCoordinatorDependencies {
  readonly createRouter?: (settings: PluginSettings) => LlmRouter | null;
  readonly feedback: Pick<UserFeedback, 'show'>;
  readonly getSecret?: (secretId: string) => string;
  readonly getSettings: () => PluginSettings;
  readonly logger?: PluginLogger;
  readonly onProgress?: (phase: MediaTranscriptionProgress['phase']) => void;
  readonly onRawTranscriptRecoveryAvailable?: (receipt: RawTranscriptRecoveryReceipt) => void;
}

export type MediaLlmReadinessFailureCode = LlmReadinessIssueCode | 'provider_unavailable';

export interface MediaLlmJob {
  readonly settings: PluginSettings;
  readonly snapshot: MediaLlmSnapshot;
}

export type MediaLlmRunOutcome = 'skipped' | 'applied' | 'failed' | 'cancelled';

export type MediaLlmFailureCategory =
  | 'auth'
  | 'connection'
  | 'empty'
  | 'filtered'
  | 'invalid_response'
  | 'model_unavailable'
  | 'note_changed'
  | 'output_limit'
  | 'provider_error'
  | 'provider_unavailable'
  | 'rate_limited'
  | 'refused'
  | 'refusal_like_reply'
  | 'timeout';

export interface MediaLlmRunResult {
  readonly failureCategory: MediaLlmFailureCategory | null;
  readonly model: string | null;
  readonly outcome: MediaLlmRunOutcome;
  readonly providerId: LlmProviderId | null;
  readonly refusalReply?: string;
}

const failureMessageKeys: Record<MediaLlmFailureCategory, TranslationKey> = {
  auth: 'media-llm-auth',
  connection: 'media-llm-connection',
  empty: 'media-llm-empty',
  filtered: 'media-llm-filtered',
  invalid_response: 'media-llm-invalid_response',
  model_unavailable: 'media-llm-model_unavailable',
  note_changed: 'media-llm-note_changed',
  output_limit: 'media-llm-output_limit',
  provider_error: 'media-llm-provider_error',
  provider_unavailable: 'media-llm-provider_unavailable',
  rate_limited: 'media-llm-rate_limited',
  refused: 'media-llm-refused',
  refusal_like_reply: 'media-llm-refusal_like_reply',
  timeout: 'media-llm-timeout',
};

export function formatMediaLlmFailure(result: MediaLlmRunResult): string {
  if (result.failureCategory === null) return '';
  const provider =
    result.providerId === null
      ? t('media-llm-provider-name')
      : formatLlmProviderName(result.providerId);
  return t(failureMessageKeys[result.failureCategory], {
    model: result.model || t('media-llm-model-name'),
    provider,
  });
}

export function formatMediaLlmFailureForModal(result: MediaLlmRunResult): string {
  const summary = formatMediaLlmFailure(result);
  return (result.failureCategory === 'refused' ||
    result.failureCategory === 'refusal_like_reply') &&
    result.refusalReply !== undefined
    ? `${summary} ${t('media-llm-refusal-reply', { reply: result.refusalReply })}`
    : summary;
}

export function formatMediaLlmCompletion(result: MediaLlmRunResult): string {
  if (result.outcome === 'failed') return formatMediaLlmFailure(result);
  if (result.outcome === 'cancelled') return t('media-llm-cancelled');
  if (result.outcome === 'applied') return t('media-llm-completed');
  return t('media-llm-transcript-only');
}

export class MediaLlmCoordinator {
  private activeAbortController: AbortController | null = null;

  constructor(private readonly dependencies: MediaLlmCoordinatorDependencies) {}

  preflight(settings = this.dependencies.getSettings(), job?: MediaLlmJob | null): boolean {
    if (job === null) return true;
    if (job === undefined && (!settings.mediaLlmProcessing || !settings.llmFeaturesEnabled)) {
      return true;
    }
    if (this.dependencies.createRouter === undefined) {
      this.reportReadiness('provider_unavailable');
      return false;
    }
    return this.readinessIsValid(settings);
  }

  async run(
    session: MediaLlmEditorSession,
    job?: MediaLlmJob | null,
    transcriptText?: string,
  ): Promise<MediaLlmRunResult> {
    if (job === null) return emptyResult('skipped');
    const settings = job?.settings ?? this.dependencies.getSettings();
    if (job === undefined && (!settings.mediaLlmProcessing || !settings.llmFeaturesEnabled))
      return emptyResult('skipped');
    const rawText = transcriptText ?? session.joinRawSessionText();
    const providerId =
      settings.llmRoutingPolicy === null
        ? null
        : selectLlmProviderId(settings.llmRoutingPolicy, rawText.length);
    const model =
      providerId === null
        ? null
        : getProviderModel(settings.llmProviderConfigurations, providerId) || null;
    const context = { providerId, model };
    if (!this.preflight(settings, job)) {
      return failedResult(this.preflightFailureCategory(settings), context);
    }
    const router = this.dependencies.createRouter?.(settings) ?? null;
    if (router === null) {
      this.reportReadiness('provider_unavailable');
      return failedResult('provider_unavailable', context);
    }
    if (rawText.trim().length === 0) {
      return failedResult('empty', context);
    }
    const transform = job?.snapshot ?? resolveLlmTransformSnapshot(settings);
    const snapshot: MediaLlmSnapshot = {
      noteContextChars: transform.noteContextChars,
      output: transform.output,
      prompt: transform.prompt,
      showRawBelow: transform.showRawBelow,
      temperature: transform.temperature,
      totalContextCap: transform.totalContextCap,
      useNoteContext: transform.useNoteContext,
    };
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.dependencies.onProgress?.('ai_processing');
    try {
      await processMediaLlm(session, {
        isEnabled: () =>
          job === undefined
            ? this.isCurrentConfiguration(settings)
            : this.isCurrentProviderConfiguration(settings),
        onRawTranscriptRecoveryAvailable: (receipt) =>
          this.dependencies.onRawTranscriptRecoveryAvailable?.(receipt),
        router,
        signal: abortController.signal,
        snapshot,
        transcriptText: rawText,
      });
      return { ...context, failureCategory: null, outcome: 'applied' };
    } catch (error) {
      if (error instanceof MediaLlmProcessingError) {
        if (error.code === 'cancelled')
          return { ...context, failureCategory: null, outcome: 'cancelled' };
        return failedResult(categoryForError(error), context, error.refusalReply);
      }
      if (abortController.signal.aborted)
        return { ...context, failureCategory: null, outcome: 'cancelled' };
      this.dependencies.logger?.warn('llm', 'media transcript post-completion failed', error);
      return failedResult(
        categoryForError(error),
        context,
        error instanceof ProviderError ? error.refusalReply : undefined,
      );
    } finally {
      if (this.activeAbortController === abortController) this.activeAbortController = null;
    }
  }

  settingsChanged(): void {
    this.cancel();
  }

  cancel(): void {
    this.activeAbortController?.abort(
      new MediaLlmProcessingError('cancelled', 'Settings changed.'),
    );
  }

  async dispose(): Promise<void> {
    this.cancel();
  }

  private isCurrentConfiguration(settings: PluginSettings): boolean {
    const current = this.dependencies.getSettings();
    return (
      current.mediaLlmProcessing &&
      current.llmFeaturesEnabled &&
      llmSettingsFingerprint(current) === llmSettingsFingerprint(settings)
    );
  }

  private isCurrentProviderConfiguration(settings: PluginSettings): boolean {
    const current = this.dependencies.getSettings();
    return (
      JSON.stringify(current.llmRoutingPolicy) === JSON.stringify(settings.llmRoutingPolicy) &&
      JSON.stringify(current.llmProviderConfigurations) ===
        JSON.stringify(settings.llmProviderConfigurations)
    );
  }

  private readinessIsValid(settings: PluginSettings): boolean {
    const readiness = resolveLlmReadiness({
      configurations: settings.llmProviderConfigurations,
      getSecret: this.dependencies.getSecret ?? (() => ''),
      policy: settings.llmRoutingPolicy,
    });
    if (readiness.ready) return true;
    this.reportReadiness(readiness.issue.code);
    return false;
  }

  private preflightFailureCategory(settings: PluginSettings): MediaLlmFailureCategory {
    if (this.dependencies.createRouter === undefined) return 'provider_unavailable';
    const readiness = resolveLlmReadiness({
      configurations: settings.llmProviderConfigurations,
      getSecret: this.dependencies.getSecret ?? (() => ''),
      policy: settings.llmRoutingPolicy,
    });
    if (readiness.ready) return 'provider_unavailable';
    switch (readiness.issue.code) {
      case 'api_key_missing':
        return 'auth';
      case 'model_missing':
        return 'model_unavailable';
      case 'base_url_invalid':
        return 'provider_error';
      case 'provider_missing':
      case 'routing_invalid':
        return 'provider_unavailable';
    }
  }

  private reportReadiness(code: MediaLlmReadinessFailureCode): void {
    this.feedback('media-llm-readiness', code);
  }

  private feedback(
    key:
      | 'media-llm-empty'
      | 'media-llm-failed'
      | 'media-llm-refused'
      | 'media-llm-range-unavailable'
      | 'media-llm-readiness',
    issue?: MediaLlmReadinessFailureCode,
  ): void {
    if (key === 'media-llm-readiness' && issue !== undefined) {
      const messageKey = readinessMessageKeys[issue];
      this.dependencies.feedback.show({
        intent: 'warning',
        key: messageKey,
        message: t(messageKey),
      });
      return;
    }
    this.dependencies.feedback.show({ intent: 'warning', key, message: t(key) });
  }
}

function emptyResult(outcome: MediaLlmRunOutcome): MediaLlmRunResult {
  return { failureCategory: null, model: null, outcome, providerId: null };
}

function failedResult(
  failureCategory: MediaLlmFailureCategory,
  context: Pick<MediaLlmRunResult, 'providerId' | 'model'>,
  refusalReply?: string,
): MediaLlmRunResult {
  return {
    ...context,
    failureCategory,
    outcome: 'failed',
    ...(refusalReply === undefined ? {} : { refusalReply }),
  };
}

function categoryForError(error: unknown): MediaLlmFailureCategory {
  if (error instanceof MediaLlmProcessingError) {
    switch (error.code) {
      case 'empty':
        return 'empty';
      case 'range_unavailable':
        return 'note_changed';
      case 'refused':
        return 'refusal_like_reply';
      case 'cancelled':
        return 'provider_error';
      case 'failed':
        break;
    }
  }
  if (!(error instanceof ProviderError)) return 'provider_error';
  switch (error.code) {
    case 'auth_invalid':
    case 'permission_denied':
      return 'auth';
    case 'connection_failed':
      return 'connection';
    case 'content_filtered':
      return 'filtered';
    case 'empty_response':
      return 'empty';
    case 'output_limit':
      return 'output_limit';
    case 'invalid_response':
      return 'invalid_response';
    case 'model_refusal':
      return 'refused';
    case 'model_not_configured':
    case 'unknown_model':
      return 'model_unavailable';
    case 'rate_limited':
      return 'rate_limited';
    case 'timeout':
      return 'timeout';
    case 'http_error':
      return 'provider_error';
    case 'aborted':
      return 'provider_error';
  }
}

const readinessMessageKeys: Record<
  MediaLlmReadinessFailureCode,
  | 'media-llm-readiness-provider_missing'
  | 'media-llm-readiness-provider_unavailable'
  | 'media-llm-readiness-routing_invalid'
  | 'media-llm-readiness-model_missing'
  | 'media-llm-readiness-api_key_missing'
  | 'media-llm-readiness-base_url_invalid'
> = {
  provider_missing: 'media-llm-readiness-provider_missing',
  provider_unavailable: 'media-llm-readiness-provider_unavailable',
  routing_invalid: 'media-llm-readiness-routing_invalid',
  model_missing: 'media-llm-readiness-model_missing',
  api_key_missing: 'media-llm-readiness-api_key_missing',
  base_url_invalid: 'media-llm-readiness-base_url_invalid',
};
