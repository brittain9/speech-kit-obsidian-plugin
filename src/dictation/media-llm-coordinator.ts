import type { RawTranscriptRecoveryReceipt } from '../editor/raw-transcript-recovery';
import { resolveMediaLlmDisclosure } from '../llm/media-llm-policy';
import { type LlmReadinessIssueCode, resolveLlmReadiness } from '../llm/readiness';
import type { LlmRouter } from '../llm/router';
import { llmSettingsFingerprint } from '../llm/settings-fingerprint';
import { resolveLlmTransformSnapshot } from '../llm/transform-policy';
import type { MediaTranscriptionProgress } from '../media/media-source';
import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import type { MediaLlmEditorSession } from './audio-file-transcript-adapter';
import {
  type MediaLlmPreview,
  MediaLlmProcessingError,
  type MediaLlmSnapshot,
  processMediaLlm,
} from './media-llm-processor';

export interface MediaLlmCoordinatorDependencies {
  readonly confirm?: (preview: MediaLlmPreview, signal: AbortSignal) => Promise<boolean>;
  readonly createRouter?: (settings: PluginSettings) => LlmRouter | null;
  readonly feedback: Pick<UserFeedback, 'show'>;
  readonly getSecret?: (secretId: string) => string;
  readonly getSettings: () => PluginSettings;
  readonly logger?: PluginLogger;
  readonly onProgress?: (phase: MediaTranscriptionProgress['phase']) => void;
  readonly onRawTranscriptRecoveryAvailable?: (receipt: RawTranscriptRecoveryReceipt) => void;
}

export type MediaLlmReadinessFailureCode = LlmReadinessIssueCode | 'provider_unavailable';

export class MediaLlmCoordinator {
  private activeAbortController: AbortController | null = null;

  constructor(private readonly dependencies: MediaLlmCoordinatorDependencies) {}

  preflight(settings = this.dependencies.getSettings()): boolean {
    if (!settings.mediaLlmProcessing || !settings.llmFeaturesEnabled) return true;
    if (this.dependencies.createRouter === undefined || this.dependencies.confirm === undefined) {
      this.reportReadiness('provider_unavailable');
      return false;
    }
    return this.readinessIsValid(settings);
  }

  async run(session: MediaLlmEditorSession): Promise<void> {
    const settings = this.dependencies.getSettings();
    if (!settings.mediaLlmProcessing || !settings.llmFeaturesEnabled) return;
    if (!this.preflight(settings)) return;
    const router = this.dependencies.createRouter?.(settings) ?? null;
    if (router === null) {
      this.reportReadiness('provider_unavailable');
      return;
    }
    const rawText = session.joinRawSessionText();
    if (rawText.trim().length === 0) {
      this.feedback('media-llm-empty');
      return;
    }
    const transform = resolveLlmTransformSnapshot(settings);
    const disclosure = resolveMediaLlmDisclosure(settings, router, rawText.length, transform);
    const snapshot: MediaLlmSnapshot = {
      noteContextChars: transform.noteContextChars,
      output: transform.output,
      prompt: transform.prompt,
      showRawBelow: transform.showRawBelow,
      temperature: transform.temperature,
      totalContextCap: transform.totalContextCap,
      useNoteContext: transform.useNoteContext,
    };
    const confirm = this.dependencies.confirm;
    if (confirm === undefined) return;
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.dependencies.onProgress?.('ai_processing');
    try {
      await processMediaLlm(session, {
        confirm,
        isEnabled: () => this.isCurrentConfiguration(settings),
        onRawTranscriptRecoveryAvailable: (receipt) =>
          this.dependencies.onRawTranscriptRecoveryAvailable?.(receipt),
        previewMetadata: {
          disclosure,
          model: disclosure.model,
          providerId: disclosure.providerId,
        },
        router,
        signal: abortController.signal,
        snapshot,
      });
    } catch (error) {
      if (error instanceof MediaLlmProcessingError) {
        if (error.code === 'cancelled') return;
        this.feedback(
          error.code === 'empty'
            ? 'media-llm-empty'
            : error.code === 'range_unavailable'
              ? 'media-llm-range-unavailable'
              : 'media-llm-failed',
        );
        return;
      }
      if (abortController.signal.aborted) return;
      this.dependencies.logger?.warn('llm', 'media transcript post-completion failed', error);
      this.feedback('media-llm-failed');
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

  private reportReadiness(code: MediaLlmReadinessFailureCode): void {
    this.feedback('media-llm-readiness', code);
  }

  private feedback(
    key:
      | 'media-llm-empty'
      | 'media-llm-failed'
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
