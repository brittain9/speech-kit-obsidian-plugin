import { type App, type ButtonComponent, Modal, Setting } from 'obsidian';

import { DICTATION_LANGUAGE_OPTIONS, type DictationLanguage } from '../language/dictation-language';
import { describeMediaLlmConfiguration } from '../llm/media-llm-policy';
import { listPresetEntries, resolvePresetEntry } from '../llm/presets';
import { resolveLlmTransformSnapshot } from '../llm/transform-policy';
import type { MediaTranscriptionProgress } from '../media/media-source';
import {
  chooseDefaultMediaTranscriptionModel,
  type MediaTranscriptionJobOptions,
  type MediaTranscriptionModelOption,
} from '../media/media-transcription-options';
import type {
  PluginSettings,
  TimestampDensity,
  TranscriptFormattingMode,
} from '../settings/plugin-settings';
import { validateTimestampIntervalSeconds } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import { mediaProgressText } from './media-progress-presenter';

export interface MediaTranscriptionModalDependencies {
  readonly cancel: () => Promise<void>;
  readonly getModels: (language: DictationLanguage) => readonly MediaTranscriptionModelOption[];
  readonly getLastError: () => unknown;
  readonly getPartialTranscript: () => string | null;
  readonly insertPartialTranscript: () => boolean;
  readonly getProgress: () => MediaTranscriptionProgress | null;
  readonly getSettings: () => PluginSettings;
  readonly isTranscribing: () => boolean;
  readonly onManageModels: () => void;
  readonly startFile: (file: File, options: MediaTranscriptionJobOptions) => Promise<void>;
  readonly subscribeProgress: (
    listener: (progress: MediaTranscriptionProgress | null) => void,
  ) => () => void;
}

export class MediaTranscriptionModalRegistry {
  private modal: MediaTranscriptionModal | null = null;

  open(app: App, dependencies: MediaTranscriptionModalDependencies): void {
    if (this.modal !== null) return;
    const modal = new MediaTranscriptionModal(app, dependencies, () => {
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
  private file: File | null = null;
  private timestampEnabled: boolean;
  private timestampDensity: TimestampDensity;
  private timestampSparseIntervalSeconds: string;
  private diarizationEnabled: boolean;
  private language: DictationLanguage;
  private modelSelectionKey = '';
  private mediaPresetRef: string | null;
  private transcriptFormatting: TranscriptFormattingMode;
  private optionsExpanded = false;
  private busy = false;
  private cancelRequested = false;
  private progressEl: HTMLElement | null = null;
  private progressRowEl: HTMLElement | null = null;
  private progressSpinnerEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private partialEl: HTMLElement | null = null;
  private requirementEl: HTMLElement | null = null;
  private fileNameEl: HTMLElement | null = null;
  private primaryButton: ButtonComponent | null = null;
  private closeButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly dependencies: MediaTranscriptionModalDependencies,
    private readonly onClosed: () => void,
  ) {
    super(app);
    const settings = dependencies.getSettings();
    this.timestampEnabled = settings.timestampsEnabled;
    this.timestampSparseIntervalSeconds = String(settings.timestampSparseIntervalMs / 1_000);
    this.timestampDensity =
      settings.timestampDensity === 'paragraph' && settings.transcriptFormatting !== 'smart'
        ? 'sparse'
        : settings.timestampDensity;
    this.diarizationEnabled = settings.diarizationEnabled;
    this.language = settings.dictationLanguage;
    this.transcriptFormatting = settings.transcriptFormatting;
    this.mediaPresetRef = settings.mediaLlmProcessing
      ? settings.llmPostprocessActivePresetRef
      : null;
    this.releaseProgress = dependencies.subscribeProgress((progress) =>
      this.renderProgress(progress),
    );
  }

  override onOpen(): void {
    this.modalEl.addClass('local-stt-media-modal');
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
    this.primaryButton = null;
    this.closeButton = null;
    const source = this.contentEl.createDiv({ cls: 'local-stt-media-source' });
    this.renderFileSource(source);
    this.renderAiPreset();
    this.renderJobOptions();

    this.requirementEl = this.contentEl.createDiv({
      cls: 'local-stt-media-requirement',
      attr: { role: 'status', 'aria-live': 'polite' },
    });

    const progressRow = this.contentEl.createDiv({ cls: 'local-stt-media-progress' });
    this.progressRowEl = progressRow;
    this.progressSpinnerEl = progressRow.createSpan({
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
        .setButtonText(this.busy ? t('media.modal.cancelJob') : t('media.modal.start'))
        .setCta()
        .onClick(() => {
          if (this.busy) void this.cancelJob();
          else void this.startJob();
        });
    });
    this.updatePrimaryButton();
  }

  private renderFileSource(parent: HTMLElement): void {
    const dropZone = parent.createDiv({
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

  private renderJobOptions(): void {
    const models = this.dependencies.getModels(this.language);
    const settings = this.dependencies.getSettings();
    const defaultModel = chooseDefaultMediaTranscriptionModel(models, settings.selectedModel);
    if (!models.some((option) => modelKey(option) === this.modelSelectionKey)) {
      this.modelSelectionKey = modelKey(defaultModel ?? models[0]);
    }
    const section = this.contentEl.createEl('details', { cls: 'local-stt-media-options' });
    section.open = this.optionsExpanded;
    section.addEventListener('toggle', () => {
      this.optionsExpanded = section.open;
    });
    const summary = section.createEl('summary');
    summary.createSpan({ text: t('media.modal.optionsTitle') });
    const selectedModel = models.find((option) => modelKey(option) === this.modelSelectionKey);
    const selectedLanguage = DICTATION_LANGUAGE_OPTIONS.find(
      (option) => option.value === this.language,
    );
    const summaryDetail = summary.createSpan({
      cls: 'local-stt-media-options-summary',
      text: selectedModel
        ? `${selectedLanguage?.label ?? this.language} · ${selectedModel.label}`
        : t('media.modal.noBatchModel'),
    });
    const grid = section.createDiv({ cls: 'local-stt-media-options-grid' });
    new Setting(grid).setName(t('media.modal.language')).addDropdown((dropdown) => {
      for (const option of DICTATION_LANGUAGE_OPTIONS)
        dropdown.addOption(option.value, option.label);
      dropdown.setValue(this.language);
      dropdown.onChange((value) => {
        this.language = value as DictationLanguage;
        this.optionsExpanded = true;
        this.render();
      });
    });
    if (models.length === 0) {
      section.createEl('p', { text: t('media.modal.noBatchModel') });
      new Setting(section).addButton((button) =>
        button.setButtonText(t('media.modal.manageModels')).onClick(() => {
          this.close();
          this.dependencies.onManageModels();
        }),
      );
      return;
    }
    if (models.length > 0)
      new Setting(grid).setName(t('media.modal.model')).addDropdown((dropdown) => {
        models.forEach((option) => {
          dropdown.addOption(modelKey(option), option.label);
        });
        dropdown.setValue(this.modelSelectionKey);
        dropdown.onChange((value) => {
          this.modelSelectionKey = value;
          const chosen = models.find((option) => modelKey(option) === value);
          summaryDetail.setText(
            `${selectedLanguage?.label ?? this.language} · ${chosen?.label ?? ''}`,
          );
          this.updatePrimaryButton();
        });
      });
    new Setting(grid).setName(t('settings.timestamps.enable.name')).addToggle((toggle) => {
      toggle.setValue(this.timestampEnabled).onChange((value) => {
        this.timestampEnabled = value;
        this.optionsExpanded = true;
        this.render();
      });
    });
    if (this.timestampEnabled) {
      new Setting(grid).setName(t('settings.timestamps.frequency.name')).addDropdown((dropdown) => {
        dropdown.addOption('sparse', t('settings.timestamps.frequency.atIntervals'));
        dropdown.addOption('every_utterance', t('settings.timestamps.frequency.everyPhrase'));
        if (this.transcriptFormatting === 'smart') {
          dropdown.addOption('paragraph', t('settings.timestamps.frequency.atParagraphBreaks'));
        }
        dropdown.setValue(this.timestampDensity);
        dropdown.onChange((value) => {
          this.timestampDensity = value as TimestampDensity;
          this.optionsExpanded = true;
          this.render();
        });
      });
      if (this.timestampDensity === 'sparse') {
        new Setting(grid)
          .setName(t('settings.timestamps.interval.name'))
          .setDesc(t('settings.timestamps.interval.desc', { min: 10, max: 600 }))
          .addText((text) => {
            text.inputEl.type = 'number';
            text.inputEl.min = '10';
            text.inputEl.max = '600';
            text.inputEl.step = '1';
            text.setValue(this.timestampSparseIntervalSeconds).onChange((value) => {
              this.timestampSparseIntervalSeconds = value;
              this.updatePrimaryButton();
            });
          });
      }
    }
    new Setting(grid).setName(t('settings.speakerLabels.name')).addToggle((toggle) => {
      toggle.setValue(this.diarizationEnabled).onChange((value) => {
        this.diarizationEnabled = value;
      });
    });
    new Setting(grid).setName(t('settings.transcriptFormatting.name')).addDropdown((dropdown) => {
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
        this.optionsExpanded = true;
        this.render();
      });
    });
  }

  private renderAiPreset(): void {
    const settings = this.dependencies.getSettings();
    const presets = listPresetEntries(settings.llmPostprocessUserPresets);
    const container = this.contentEl.createDiv({ cls: 'local-stt-media-preset' });
    if (
      this.mediaPresetRef !== null &&
      !presets.some((entry) => entry.ref === this.mediaPresetRef)
    ) {
      this.mediaPresetRef = null;
    }
    new Setting(container)
      .setName(t('media.modal.aiPreset'))
      .setDesc(
        this.mediaPresetRef === null
          ? t('media.modal.aiPresetDesc')
          : `${t('media.modal.aiPresetDesc')} ${describeMediaLlmConfiguration({
              ...settings,
              llmPostprocessActivePresetRef: this.mediaPresetRef,
            })}`,
      )
      .addDropdown((dropdown) => {
        dropdown.addOption('', t('media.modal.aiPresetNone'));
        for (const entry of presets) dropdown.addOption(entry.ref, entry.preset.label);
        dropdown.setValue(this.mediaPresetRef ?? '');
        dropdown.onChange((value) => {
          this.mediaPresetRef = value || null;
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
    const blocker = this.busy ? null : this.startBlocker();
    this.primaryButton?.setButtonText(
      this.busy ? t('media.modal.cancelJob') : t('media.modal.start'),
    );
    this.primaryButton?.setDisabled(this.cancelRequested || blocker !== null);
    this.closeButton?.buttonEl.toggle(!this.busy);
    this.progressSpinnerEl?.toggle(this.busy && !this.cancelRequested);
    this.requirementEl?.setText(blocker ?? '');
  }

  private startBlocker(): string | null {
    if (this.dependencies.isTranscribing()) return t('media.modal.alreadyRunning');
    if (this.dependencies.getModels(this.language).length === 0)
      return t('media.modal.noBatchModel');
    if (this.file === null) return t('media.modal.selectFile');
    if (this.mediaPresetRef !== null && this.dependencies.getSettings().llmRoutingPolicy === null) {
      return t('media.modal.aiProviderRequired');
    }
    if (this.timestampEnabled && this.timestampDensity === 'sparse') {
      const interval = validateTimestampIntervalSeconds(this.timestampSparseIntervalSeconds);
      if (!interval.valid) return interval.message;
    }
    return null;
  }

  private renderProgress(progress: MediaTranscriptionProgress | null): void {
    if (this.progressEl !== null) {
      const message =
        progress === null
          ? this.busy
            ? this.acquisitionProgressText()
            : this.dependencies.isTranscribing()
              ? t('media.modal.alreadyRunning')
              : ''
          : this.busy
            ? progress.phase === 'acquire'
              ? this.acquisitionProgressText()
              : mediaProgressText(progress)
            : t('media.modal.completed');
      this.progressEl.setText(message);
      this.progressRowEl?.toggle(message.length > 0);
    }
    this.updatePrimaryButton();
  }

  private acquisitionProgressText(): string {
    return t('media.progress.acquire');
  }

  private async startJob(): Promise<void> {
    if (this.busy) return;
    const blocker = this.startBlocker();
    if (blocker !== null) {
      this.errorEl?.setText(blocker);
      this.updatePrimaryButton();
      return;
    }
    const model = this.dependencies
      .getModels(this.language)
      .find((option) => modelKey(option) === this.modelSelectionKey);
    if (model === undefined || this.file === null) return;
    const settings = this.dependencies.getSettings();
    const preset = resolvePresetEntry(this.mediaPresetRef, settings.llmPostprocessUserPresets);
    if (this.mediaPresetRef !== null && preset === null) {
      this.errorEl?.setText(t('media.modal.aiPresetMissing'));
      return;
    }
    const interval = validateTimestampIntervalSeconds(this.timestampSparseIntervalSeconds);
    const options: MediaTranscriptionJobOptions = {
      diarizationEnabled: this.diarizationEnabled,
      language: this.language,
      ...(model === undefined ? {} : { modelSelection: model.selection }),
      timestampDensity: this.timestampDensity,
      timestampSparseIntervalMs: interval.valid
        ? interval.milliseconds
        : settings.timestampSparseIntervalMs,
      timestampsEnabled: this.timestampEnabled,
      transcriptFormatting: this.transcriptFormatting,
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
    this.partialEl?.empty();
    this.updatePrimaryButton();
    this.renderProgress(this.dependencies.getProgress());
    try {
      await this.dependencies.startFile(this.file, options);
      if (!this.lifecycle.signal.aborted && !this.cancelRequested) {
        const error = this.dependencies.getLastError();
        if (error !== null) {
          this.showError(error);
        } else {
          this.progressEl?.setText(t('media.modal.completed'));
          this.progressRowEl?.toggle(true);
        }
      }
    } catch (error) {
      if (!this.lifecycle.signal.aborted) this.showError(error);
    } finally {
      this.busy = false;
      this.cancelRequested = false;
      this.updatePrimaryButton();
    }
  }

  private showError(error: unknown): void {
    this.progressEl?.setText('');
    this.progressRowEl?.toggle(false);
    this.errorEl?.setText(
      t('media.modal.recoverableError', {
        detail: errorDetail(error),
      }),
    );
    this.renderPartialRecovery();
  }

  private renderPartialRecovery(): void {
    this.partialEl?.empty();
    const partial = this.dependencies.getPartialTranscript();
    if (partial === null || this.partialEl === null) return;
    this.partialEl.createEl('p', { text: t('media.modal.partialAvailable') });
    const copy = this.partialEl.createEl('button', { text: t('media.modal.copyPartial') });
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(partial);
    });
    const insert = this.partialEl.createEl('button', { text: t('media.modal.insertPartial') });
    insert.addEventListener('click', () => {
      if (this.dependencies.insertPartialTranscript()) this.partialEl?.empty();
      else this.errorEl?.setText(t('media.modal.partialTargetChanged'));
    });
  }

  private async cancelJob(): Promise<void> {
    this.cancelRequested = true;
    this.updatePrimaryButton();
    await this.dependencies.cancel();
    this.busy = false;
    this.progressEl?.setText(t('media.modal.cancelled'));
    this.progressRowEl?.toggle(true);
    this.renderPartialRecovery();
    this.updatePrimaryButton();
  }
}

function modelKey(option: MediaTranscriptionModelOption | null | undefined): string {
  return option === null || option === undefined ? '' : JSON.stringify(option.selection);
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
