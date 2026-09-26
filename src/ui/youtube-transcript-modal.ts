import { type App, type ButtonComponent, Modal, Setting } from 'obsidian';
import type { MediaLlmRunOutcome } from '../dictation/media-llm-coordinator';
import { DICTATION_LANGUAGE_OPTIONS, type DictationLanguage } from '../language/dictation-language';
import { describeMediaLlmConfiguration } from '../llm/media-llm-policy';
import { listPresetEntries, resolvePresetEntry } from '../llm/presets';
import { resolveLlmTransformSnapshot } from '../llm/transform-policy';
import type { MediaTranscriptionProgress } from '../media/media-source';
import type { MediaTranscriptionJobOptions } from '../media/media-transcription-options';
import { CaptionAcquisitionError } from '../media/youtube-captions';
import { parseYouTubeVideoUrl } from '../media/youtube-url';
import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import { mediaProgressText } from './media-progress-presenter';

export interface YouTubeTranscriptModalDependencies {
  readonly cancel: () => Promise<void>;
  readonly getProgress: () => MediaTranscriptionProgress | null;
  readonly getPartialTranscript: () => string | null;
  readonly getResultSource: () => 'creator_captions' | 'automatic_captions' | null;
  readonly getAiOutcome: () => MediaLlmRunOutcome | null;
  readonly getSettings: () => PluginSettings;
  readonly insertPartialTranscript: () => boolean;
  readonly isBusy: () => boolean;
  readonly start: (url: string, options: MediaTranscriptionJobOptions) => Promise<void>;
  readonly subscribeProgress: (
    listener: (progress: MediaTranscriptionProgress | null) => void,
  ) => () => void;
}

export class YouTubeTranscriptModalRegistry {
  private modal: YouTubeTranscriptModal | null = null;

  open(app: App, dependencies: YouTubeTranscriptModalDependencies): void {
    if (this.modal !== null) return;
    const modal = new YouTubeTranscriptModal(app, dependencies, () => {
      if (this.modal === modal) this.modal = null;
    });
    this.modal = modal;
    modal.open();
  }

  closeAll(): void {
    this.modal?.close();
    this.modal = null;
  }
}

class YouTubeTranscriptModal extends Modal {
  private readonly releaseProgress: () => void;
  private url = '';
  private language: DictationLanguage;
  private timestampsEnabled: boolean;
  private timestampIntervalSeconds = 60;
  private mediaPresetRef: string | null;
  private busy = false;
  private completedVideoId: string | null = null;
  private cancelRequested = false;
  private progressRowEl: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private spinnerEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private partialEl: HTMLElement | null = null;
  private primaryButton: ButtonComponent | null = null;
  private closeButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly dependencies: YouTubeTranscriptModalDependencies,
    private readonly onClosed: () => void,
  ) {
    super(app);
    const settings = dependencies.getSettings();
    this.language = 'auto';
    this.timestampsEnabled = settings.timestampsEnabled;
    this.mediaPresetRef = settings.mediaLlmProcessing
      ? settings.llmPostprocessActivePresetRef
      : null;
    this.releaseProgress = dependencies.subscribeProgress((progress) =>
      this.renderProgress(progress),
    );
  }

  override onOpen(): void {
    this.modalEl.addClass('local-stt-youtube-transcript-modal');
    this.setTitle(t('youtube.modal.title'));
    this.render();
  }

  override onClose(): void {
    this.releaseProgress();
    if (this.busy) void this.dependencies.cancel();
    this.contentEl.empty();
    this.onClosed();
  }

  private render(): void {
    this.contentEl.empty();
    this.primaryButton = null;
    this.closeButton = null;

    new Setting(this.contentEl).setName(t('youtube.modal.urlName')).addText((text) => {
      text.setPlaceholder(t('youtube.modal.urlPlaceholder')).setValue(this.url);
      text.inputEl.addClass('local-stt-youtube-transcript-url');
      text.onChange((value) => {
        this.url = value;
        this.updatePrimaryButton();
      });
    });
    this.contentEl.createEl('p', {
      text: t('youtube.modal.captionDescription'),
      cls: 'local-stt-media-source-hint',
    });
    this.renderOptions();
    this.renderAiPreset();

    const progressRow = this.contentEl.createDiv({ cls: 'local-stt-media-progress' });
    this.progressRowEl = progressRow;
    this.spinnerEl = progressRow.createSpan({
      cls: 'local-stt-media-spinner',
      attr: { 'aria-hidden': 'true' },
    });
    this.progressEl = progressRow.createSpan({
      cls: 'local-stt-media-progress-text',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.errorEl = this.contentEl.createDiv({
      cls: 'local-stt-media-error',
      attr: { role: 'alert' },
    });
    this.partialEl = this.contentEl.createDiv({ cls: 'local-stt-media-partial-actions' });
    this.renderProgress(this.dependencies.getProgress());

    const footer = this.contentEl.createDiv({ cls: 'local-stt-media-footer' });
    const actions = new Setting(footer);
    actions.addButton((button) => {
      this.closeButton = button;
      button.setButtonText(t('common.close')).onClick(() => this.close());
    });
    actions.addButton((button) => {
      this.primaryButton = button;
      button
        .setButtonText(t('media.modal.start'))
        .setCta()
        .onClick(() => {
          if (this.busy) void this.cancelJob();
          else void this.startJob();
        });
    });
    this.updatePrimaryButton();
  }

  private renderAiPreset(): void {
    const settings = this.dependencies.getSettings();
    const presets = listPresetEntries(settings.llmPostprocessUserPresets);
    if (
      this.mediaPresetRef !== null &&
      !presets.some((entry) => entry.ref === this.mediaPresetRef)
    ) {
      this.mediaPresetRef = null;
    }
    new Setting(this.contentEl)
      .setName(t('youtube.modal.aiPreset'))
      .setDesc(t('youtube.modal.aiPresetDesc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('', t('media.modal.aiPresetNone'));
        for (const entry of presets) dropdown.addOption(entry.ref, entry.preset.label);
        dropdown.setValue(this.mediaPresetRef ?? '');
        dropdown.onChange((value) => {
          this.mediaPresetRef = value || null;
          this.render();
        });
      });
    if (this.mediaPresetRef !== null) {
      this.contentEl.createEl('p', {
        text: describeMediaLlmConfiguration({
          ...settings,
          llmPostprocessActivePresetRef: this.mediaPresetRef,
        }),
        cls: 'local-stt-media-source-hint',
      });
    }
  }

  private renderOptions(): void {
    const grid = this.contentEl.createDiv({ cls: 'local-stt-youtube-options' });

    new Setting(grid)
      .setName(t('youtube.modal.captionLanguage'))
      .setDesc(t('youtube.modal.captionLanguageDesc'))
      .addDropdown((dropdown) => {
        for (const option of DICTATION_LANGUAGE_OPTIONS)
          dropdown.addOption(
            option.value,
            option.value === 'auto' ? t('youtube.modal.originalLanguage') : option.label,
          );
        dropdown.setValue(this.language).onChange((value) => {
          this.language = value as DictationLanguage;
        });
      });
    new Setting(grid)
      .setName(t('youtube.modal.timestamps'))
      .setDesc(t('youtube.modal.timestampsDesc'))
      .addToggle((toggle) => {
        toggle.setValue(this.timestampsEnabled).onChange((value) => {
          this.timestampsEnabled = value;
          this.render();
        });
      });
    if (this.timestampsEnabled) {
      new Setting(grid)
        .setName(t('youtube.modal.timeGrouping'))
        .setDesc(t('youtube.modal.timeGroupingDesc'))
        .addDropdown((dropdown) => {
          dropdown.addOption('30', t('youtube.modal.interval30'));
          dropdown.addOption('60', t('youtube.modal.interval60'));
          dropdown.addOption('120', t('youtube.modal.interval120'));
          dropdown.addOption('300', t('youtube.modal.interval300'));
          dropdown.setValue(String(this.timestampIntervalSeconds)).onChange((value) => {
            this.timestampIntervalSeconds = Number(value);
          });
        });
    }
  }

  private updatePrimaryButton(): void {
    const blocker = this.busy ? null : this.startBlocker();
    const alreadyAdded = this.completedVideoId !== null && this.completedVideoId === this.videoId();
    this.primaryButton?.setButtonText(
      this.busy
        ? t('media.modal.cancelJob')
        : alreadyAdded
          ? t('youtube.modal.alreadyAdded')
          : t('media.modal.start'),
    );
    this.primaryButton?.setDisabled(this.cancelRequested || blocker !== null || alreadyAdded);
    this.closeButton?.buttonEl.toggle(!this.busy);
    this.spinnerEl?.toggle(this.busy && !this.cancelRequested);
  }

  private videoId(): string | null {
    try {
      return parseYouTubeVideoUrl(this.url).videoId;
    } catch {
      return null;
    }
  }

  private startBlocker(): string | null {
    if (this.dependencies.isBusy()) return t('media.modal.alreadyRunning');
    if (this.url.trim().length === 0) return t('youtube.modal.enterUrl');
    try {
      parseYouTubeVideoUrl(this.url);
    } catch {
      return t('media.modal.invalidYouTubeUrl');
    }
    if (this.mediaPresetRef !== null && this.dependencies.getSettings().llmRoutingPolicy === null) {
      return t('media.modal.aiProviderRequired');
    }
    return null;
  }

  private renderProgress(progress: MediaTranscriptionProgress | null): void {
    if (this.progressEl === null) return;
    const message = !this.busy
      ? ''
      : progress === null
        ? t('media.progress.captions')
        : mediaProgressText(progress);
    this.progressEl.setText(message);
    this.progressRowEl?.toggle(message.length > 0 || this.busy);
    this.updatePrimaryButton();
  }

  private async startJob(): Promise<void> {
    const blocker = this.startBlocker();
    if (blocker !== null) {
      this.errorEl?.setText(blocker);
      return;
    }
    const settings = this.dependencies.getSettings();
    const preset = resolvePresetEntry(this.mediaPresetRef, settings.llmPostprocessUserPresets);
    if (this.mediaPresetRef !== null && preset === null) {
      this.errorEl?.setText(t('media.modal.aiPresetMissing'));
      return;
    }
    const submittedUrl = this.url.trim();
    const submittedVideoId = parseYouTubeVideoUrl(submittedUrl).videoId;
    const options: MediaTranscriptionJobOptions = {
      diarizationEnabled: false,
      language: this.language,
      timestampDensity: 'sparse',
      timestampSparseIntervalMs: this.timestampIntervalSeconds * 1_000,
      timestampsEnabled: this.timestampsEnabled,
      transcriptFormatting: 'space',
      mediaLlmSnapshot:
        preset === null
          ? null
          : resolveLlmTransformSnapshot({
              ...settings,
              llmPostprocessActivePresetRef: preset.ref,
            }),
    };
    this.busy = true;
    this.cancelRequested = false;
    this.errorEl?.setText('');
    this.updatePrimaryButton();
    this.renderProgress(this.dependencies.getProgress());
    try {
      await this.dependencies.start(submittedUrl, options);
      this.completedVideoId = submittedVideoId;
      const source = this.dependencies.getResultSource();
      const aiOutcome = this.dependencies.getAiOutcome();
      this.progressEl?.setText(
        source === 'creator_captions'
          ? t('youtube.modal.completedCreatorCaptions')
          : t('youtube.modal.completedAutomaticCaptions'),
      );
      this.progressEl?.toggle(true);
      if (aiOutcome === 'failed' || aiOutcome === 'cancelled') {
        this.errorEl?.setText(t('youtube.modal.aiCouldNotFinish'));
      }
    } catch (error) {
      if (!this.cancelRequested) {
        this.progressEl?.setText('');
        this.progressRowEl?.hide();
        const detail = errorMessage(error);
        this.errorEl?.setText(
          this.dependencies.getResultSource() === null
            ? detail
            : t('youtube.modal.aiFailedRawKept', { reason: detail }),
        );
        this.renderPartialRecovery();
      }
    } finally {
      this.busy = false;
      this.cancelRequested = false;
      this.updatePrimaryButton();
    }
  }

  private async cancelJob(): Promise<void> {
    this.cancelRequested = true;
    this.updatePrimaryButton();
    await this.dependencies.cancel();
    this.busy = false;
    this.progressEl?.setText(t('media.modal.cancelled'));
    this.progressEl?.toggle(true);
    this.renderPartialRecovery();
    this.updatePrimaryButton();
  }

  private renderPartialRecovery(): void {
    this.partialEl?.empty();
    const partial = this.dependencies.getPartialTranscript();
    if (partial === null || this.partialEl === null) return;
    this.partialEl.createEl('p', { text: t('media.modal.partialAvailable') });
    this.partialEl
      .createEl('button', { text: t('media.modal.copyPartial') })
      .addEventListener('click', () => {
        void navigator.clipboard.writeText(partial);
      });
    this.partialEl
      .createEl('button', { text: t('media.modal.insertPartial') })
      .addEventListener('click', () => {
        if (this.dependencies.insertPartialTranscript()) this.partialEl?.empty();
        else this.errorEl?.setText(t('media.modal.partialTargetChanged'));
      });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof CaptionAcquisitionError && error.availableLanguages.length > 0) {
    const displayNames = new Intl.DisplayNames(undefined, { type: 'language' });
    const languages = error.availableLanguages.map((code) => {
      try {
        return displayNames.of(code) ?? code;
      } catch {
        return code;
      }
    });
    return `${error.message} ${t('youtube.caption.availableLanguages', { languages: languages.join(', ') })}`;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return t('media.modal.unknownFailure');
}
