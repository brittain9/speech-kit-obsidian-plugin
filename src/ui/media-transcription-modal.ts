import { type App, type ButtonComponent, Modal, Setting } from 'obsidian';

import { DICTATION_LANGUAGE_OPTIONS, type DictationLanguage } from '../language/dictation-language';
import type { MediaTranscriptionProgress } from '../media/media-source';
import {
  chooseDefaultMediaTranscriptionModel,
  type MediaTranscriptionJobOptions,
  type MediaTranscriptionModelOption,
} from '../media/media-transcription-options';
import {
  explicitYouTubeRightsConfirmation,
  hasYouTubeRightsConfirmation,
  YOUTUBE_POLICY_VERSION,
} from '../media/youtube-media-source';
import { parseYouTubeVideoUrl } from '../media/youtube-url';
import type {
  PluginSettings,
  TimestampDensity,
  TranscriptFormattingMode,
} from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import { mediaProgressText } from './media-progress-presenter';

export type MediaTranscriptionTab = 'file' | 'youtube';

export interface MediaTranscriptionModalDependencies {
  readonly cancel: () => Promise<void>;
  readonly getModels: (language: DictationLanguage) => readonly MediaTranscriptionModelOption[];
  readonly getLastError: () => unknown;
  readonly getProgress: () => MediaTranscriptionProgress | null;
  readonly getSettings: () => PluginSettings;
  readonly getYouTubeHelperPath: () => string;
  readonly getYouTubePolicyVersion: () => string | null;
  readonly isTranscribing: () => boolean;
  readonly isYouTubeEnabled: () => boolean;
  readonly onManageModels: () => void;
  readonly startFile: (file: File, options: MediaTranscriptionJobOptions) => Promise<void>;
  readonly startYouTube: (
    url: string,
    options: MediaTranscriptionJobOptions,
    consent: ReturnType<typeof explicitYouTubeRightsConfirmation>,
  ) => Promise<void>;
  readonly subscribeProgress: (
    listener: (progress: MediaTranscriptionProgress | null) => void,
  ) => () => void;
}

export class MediaTranscriptionModalRegistry {
  private modal: MediaTranscriptionModal | null = null;

  open(
    app: App,
    dependencies: MediaTranscriptionModalDependencies,
    initialTab: MediaTranscriptionTab,
  ): void {
    if (this.modal !== null) return;
    const modal = new MediaTranscriptionModal(app, dependencies, initialTab, () => {
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

class MediaTranscriptionModal extends Modal {
  private readonly lifecycle = new AbortController();
  private readonly releaseProgress: () => void;
  private tab: MediaTranscriptionTab;
  private file: File | null = null;
  private url = '';
  private rightsConfirmed: boolean;
  private timestampEnabled: boolean;
  private timestampDensity: TimestampDensity;
  private diarizationEnabled: boolean;
  private language: DictationLanguage;
  private modelSelectionKey = '';
  private transcriptFormatting: TranscriptFormattingMode;
  private busy = false;
  private cancelRequested = false;
  private progressEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private fileNameEl: HTMLElement | null = null;
  private primaryButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly dependencies: MediaTranscriptionModalDependencies,
    initialTab: MediaTranscriptionTab,
    private readonly onClosed: () => void,
  ) {
    super(app);
    const settings = dependencies.getSettings();
    this.tab = initialTab;
    this.rightsConfirmed = hasYouTubeRightsConfirmation(dependencies.getYouTubePolicyVersion());
    this.timestampEnabled = settings.timestampsEnabled;
    this.timestampDensity =
      settings.timestampDensity === 'paragraph' && settings.transcriptFormatting !== 'smart'
        ? 'sparse'
        : settings.timestampDensity;
    this.diarizationEnabled = settings.diarizationEnabled;
    this.language = settings.dictationLanguage;
    this.transcriptFormatting = settings.transcriptFormatting;
    this.releaseProgress = dependencies.subscribeProgress((progress) =>
      this.renderProgress(progress),
    );
  }

  override onOpen(): void {
    this.setTitle(t('media.modal.title'));
    this.render();
  }

  override onClose(): void {
    this.lifecycle.abort();
    this.releaseProgress();
    if (this.busy) void this.dependencies.cancel();
    this.contentEl.empty();
    this.onClosed();
  }

  private render(): void {
    this.contentEl.empty();
    const tabs = this.contentEl.createDiv({ cls: 'local-stt-media-source-tabs' });
    tabs.setAttribute('role', 'tablist');
    this.addTab(tabs, 'file', t('media.modal.fileTab'));
    if (this.dependencies.isYouTubeEnabled()) {
      this.addTab(tabs, 'youtube', t('media.modal.youtubeTab'));
    }

    if (this.tab === 'file') this.renderFileSource();
    else this.renderYouTubeSource();
    this.renderJobOptions();

    this.progressEl = this.contentEl.createDiv({
      cls: 'local-stt-media-progress',
      attr: { role: 'status', 'aria-live': 'polite' },
    });
    this.errorEl = this.contentEl.createDiv({
      cls: 'local-stt-media-error',
      attr: { role: 'alert' },
    });
    this.renderProgress(this.dependencies.getProgress());

    const actions = new Setting(this.contentEl);
    actions.addButton((button) =>
      button.setButtonText(t('common.cancel')).onClick(() => this.close()),
    );
    actions.addButton((button) => {
      this.primaryButton = button;
      button
        .setButtonText(this.busy ? t('media.modal.cancelJob') : t('media.modal.start'))
        .setCta()
        .onClick(() => {
          if (this.busy) void this.cancelJob();
          else void this.startJob();
        });
    });
    this.updatePrimaryButton();
  }

  private addTab(parent: HTMLElement, tab: MediaTranscriptionTab, label: string): void {
    const button = parent.createEl('button', { text: label, attr: { role: 'tab' } });
    button.setAttribute('aria-selected', String(this.tab === tab));
    button.toggleClass('is-active', this.tab === tab);
    button.addEventListener('click', () => {
      if (this.busy) return;
      this.tab = tab;
      this.render();
    });
  }

  private renderFileSource(): void {
    const dropZone = this.contentEl.createDiv({
      cls: 'local-stt-media-drop-zone',
      attr: { role: 'group', tabindex: '0', 'aria-label': t('media.modal.dropLabel') },
    });
    dropZone.createEl('p', { text: t('media.modal.dropDescription') });
    this.fileNameEl = dropZone.createEl('p', { cls: 'local-stt-media-selected-file' });
    const input = dropZone.createEl('input', {
      attr: { type: 'file', accept: 'audio/*,video/*,.mkv,.webm,.mov,.mp4', hidden: '' },
    });
    const browse = dropZone.createEl('button', { text: t('media.modal.browse') });
    browse.addEventListener('click', (event) => {
      event.preventDefault();
      input.click();
    });
    input.addEventListener('change', () => this.setFile(input.files?.[0] ?? null));
    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.addClass('is-dragging');
    });
    dropZone.addEventListener('dragleave', () => dropZone.removeClass('is-dragging'));
    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.removeClass('is-dragging');
      this.setFile(event.dataTransfer?.files[0] ?? null);
    });
    dropZone.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === dropZone) {
        event.preventDefault();
        input.click();
      }
    });
    this.updateFileName();
  }

  private renderYouTubeSource(): void {
    this.contentEl.createEl('p', { text: t('youtube.modal.disclosure') });
    this.contentEl.createEl('p', { text: t('media.modal.youtubeFreshTranscript') });
    if (this.dependencies.getYouTubeHelperPath().length === 0) {
      this.contentEl.createEl('p', { text: t('media.modal.configureYouTubeHelper') });
    }
    if (!this.rightsConfirmed) {
      new Setting(this.contentEl).setName(t('youtube.modal.rightsLabel')).addToggle((toggle) => {
        toggle.setValue(false).onChange((value) => {
          this.rightsConfirmed = value;
          this.updatePrimaryButton();
        });
      });
    } else {
      this.contentEl.createEl('p', {
        text: t('youtube.modal.policyAccepted', { policy: YOUTUBE_POLICY_VERSION }),
      });
    }
    new Setting(this.contentEl).setName(t('youtube.modal.urlName')).addText((text) => {
      text.setPlaceholder(t('youtube.modal.urlPlaceholder')).setValue(this.url);
      text.onChange((value) => {
        this.url = value;
        this.updatePrimaryButton();
      });
    });
  }

  private renderJobOptions(): void {
    this.contentEl.createEl('h3', { text: t('media.modal.optionsTitle') });
    const models = this.dependencies.getModels(this.language);
    const settings = this.dependencies.getSettings();
    const defaultModel = chooseDefaultMediaTranscriptionModel(models, settings.selectedModel);
    if (!models.some((option) => modelKey(option) === this.modelSelectionKey)) {
      this.modelSelectionKey = modelKey(defaultModel ?? models[0]);
    }
    new Setting(this.contentEl).setName(t('media.modal.language')).addDropdown((dropdown) => {
      for (const option of DICTATION_LANGUAGE_OPTIONS)
        dropdown.addOption(option.value, option.label);
      dropdown.setValue(this.language);
      dropdown.onChange((value) => {
        this.language = value as DictationLanguage;
        this.render();
      });
    });
    if (models.length === 0) {
      this.contentEl.createEl('p', { text: t('media.modal.noBatchModel') });
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText(t('media.modal.manageModels')).onClick(() => {
          this.close();
          this.dependencies.onManageModels();
        }),
      );
      return;
    }
    new Setting(this.contentEl).setName(t('media.modal.model')).addDropdown((dropdown) => {
      models.forEach((option) => {
        dropdown.addOption(modelKey(option), option.label);
      });
      dropdown.setValue(this.modelSelectionKey);
      dropdown.onChange((value) => {
        this.modelSelectionKey = value;
        this.updatePrimaryButton();
      });
    });
    new Setting(this.contentEl)
      .setName(t('settings.timestamps.enable.name'))
      .addToggle((toggle) => {
        toggle.setValue(this.timestampEnabled).onChange((value) => {
          this.timestampEnabled = value;
        });
      });
    new Setting(this.contentEl)
      .setName(t('settings.timestamps.frequency.name'))
      .addDropdown((dropdown) => {
        dropdown.addOption('sparse', t('settings.timestamps.frequency.atIntervals'));
        dropdown.addOption('every_utterance', t('settings.timestamps.frequency.everyPhrase'));
        if (this.transcriptFormatting === 'smart') {
          dropdown.addOption('paragraph', t('settings.timestamps.frequency.atParagraphBreaks'));
        }
        dropdown.setValue(this.timestampDensity);
        dropdown.onChange((value) => {
          this.timestampDensity = value as TimestampDensity;
        });
      });
    new Setting(this.contentEl).setName(t('settings.speakerLabels.name')).addToggle((toggle) => {
      toggle.setValue(this.diarizationEnabled).onChange((value) => {
        this.diarizationEnabled = value;
      });
    });
    new Setting(this.contentEl)
      .setName(t('settings.transcriptFormatting.name'))
      .addDropdown((dropdown) => {
        dropdown.addOption('smart', t('settings.transcriptFormatting.smartParagraphs'));
        dropdown.addOption('space', t('settings.transcriptFormatting.space'));
        dropdown.addOption('new_line', t('settings.transcriptFormatting.newLine'));
        dropdown.addOption('new_paragraph', t('settings.transcriptFormatting.newParagraph'));
        dropdown.setValue(this.transcriptFormatting);
        dropdown.onChange((value) => {
          this.transcriptFormatting = value as TranscriptFormattingMode;
          if (this.transcriptFormatting !== 'smart' && this.timestampDensity === 'paragraph') {
            this.timestampDensity = 'sparse';
          }
          this.render();
        });
      });
  }

  private setFile(file: File | null): void {
    this.file = file;
    this.updateFileName();
    this.updatePrimaryButton();
  }

  private updateFileName(): void {
    if (this.fileNameEl === null) return;
    this.fileNameEl.setText(
      this.file === null
        ? ''
        : t('media.modal.fileSelected', {
            name: this.file.name,
            size: formatBytes(this.file.size),
          }),
    );
  }

  private updatePrimaryButton(): void {
    this.primaryButton?.setDisabled(
      this.busy ||
        this.dependencies.isTranscribing() ||
        this.dependencies.getModels(this.language).length === 0 ||
        (this.tab === 'file' && this.file === null) ||
        (this.tab === 'youtube' && (!this.rightsConfirmed || !isValidYouTubeUrl(this.url))),
    );
  }

  private renderProgress(progress: MediaTranscriptionProgress | null): void {
    if (this.progressEl !== null) {
      this.progressEl.setText(
        progress === null
          ? this.dependencies.isTranscribing()
            ? t('media.modal.alreadyRunning')
            : ''
          : this.busy
            ? mediaProgressText(progress)
            : t('media.modal.completed'),
      );
    }
    this.updatePrimaryButton();
  }

  private async startJob(): Promise<void> {
    if (this.busy) return;
    if (this.dependencies.isTranscribing()) {
      this.errorEl?.setText(t('media.modal.alreadyRunning'));
      this.updatePrimaryButton();
      return;
    }
    const model = this.dependencies
      .getModels(this.language)
      .find((option) => modelKey(option) === this.modelSelectionKey);
    if (model === undefined) return;
    if (this.tab === 'file' && this.file === null) return;
    if (this.tab === 'youtube' && (!this.rightsConfirmed || !isValidYouTubeUrl(this.url))) return;
    const options: MediaTranscriptionJobOptions = {
      diarizationEnabled: this.diarizationEnabled,
      language: this.language,
      modelSelection: model.selection,
      timestampDensity: this.timestampDensity,
      timestampsEnabled: this.timestampEnabled,
      transcriptFormatting: this.transcriptFormatting,
    };
    this.busy = true;
    this.cancelRequested = false;
    this.errorEl?.setText('');
    this.updatePrimaryButton();
    this.renderProgress(this.dependencies.getProgress());
    try {
      if (this.tab === 'file') await this.dependencies.startFile(this.file as File, options);
      else
        await this.dependencies.startYouTube(
          this.url.trim(),
          options,
          explicitYouTubeRightsConfirmation(),
        );
      if (!this.lifecycle.signal.aborted && !this.cancelRequested) {
        const error = this.dependencies.getLastError();
        if (error !== null) {
          this.errorEl?.setText(
            t('media.modal.recoverableError', {
              detail: errorDetail(error),
            }),
          );
        } else this.progressEl?.setText(t('media.modal.completed'));
      }
    } catch (error) {
      if (!this.lifecycle.signal.aborted) {
        this.errorEl?.setText(
          t('media.modal.recoverableError', {
            detail: errorDetail(error),
          }),
        );
      }
    } finally {
      this.busy = false;
      this.updatePrimaryButton();
    }
  }

  private async cancelJob(): Promise<void> {
    this.cancelRequested = true;
    await this.dependencies.cancel();
    this.busy = false;
    this.progressEl?.setText(t('media.modal.cancelled'));
    this.updatePrimaryButton();
  }
}

function modelKey(option: MediaTranscriptionModelOption | null | undefined): string {
  return option === null || option === undefined ? '' : JSON.stringify(option.selection);
}

function isValidYouTubeUrl(value: string): boolean {
  try {
    parseYouTubeVideoUrl(value);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return t('media.modal.unknownFailure');
}
