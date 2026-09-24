import { type App, type ButtonComponent, Modal, Setting, type TextComponent } from 'obsidian';

import {
  discoverYtDlpCandidates,
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
} from '../media/youtube-helper';
import type { YouTubeConsentGrant } from '../media/youtube-media-source';
import {
  explicitYouTubeRightsConfirmation,
  hasYouTubeRightsConfirmation,
  YOUTUBE_POLICY_VERSION,
} from '../media/youtube-media-source';
import { parseYouTubeVideoUrl, type YouTubeVideoRef } from '../media/youtube-url';
import { t } from '../shared/i18n';

export interface YouTubeMediaSourceRequest {
  readonly consent: YouTubeConsentGrant;
  readonly ref: YouTubeVideoRef;
}

export interface YouTubeMediaSourceModalDependencies {
  readonly getHelperPath: () => string;
  readonly getPolicyVersion: () => string | null;
  readonly onHelperSelected: (path: string, version: string, signal: AbortSignal) => Promise<void>;
  readonly onRightsConfirmed: (signal: AbortSignal) => Promise<void>;
}

export function openYouTubeMediaSourceModal(
  app: App,
  dependencies: YouTubeMediaSourceModalDependencies,
): Promise<YouTubeMediaSourceRequest | null> {
  return new Promise((resolve) => {
    new YouTubeMediaSourceModal(app, dependencies, resolve).open();
  });
}

class YouTubeMediaSourceModal extends Modal {
  private readonly lifecycle = new AbortController();
  private probeController: AbortController | null = null;
  private generation = 0;
  private settled = false;
  private helperPath: string;
  private helperVersion = '';
  private url = '';
  private rightsConfirmed = false;
  private errorEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private confirmButton: ButtonComponent | null = null;
  private resolveRequest: ((request: YouTubeMediaSourceRequest | null) => void) | null;

  constructor(
    app: App,
    private readonly dependencies: YouTubeMediaSourceModalDependencies,
    resolveRequest: (request: YouTubeMediaSourceRequest | null) => void,
  ) {
    super(app);
    this.helperPath = dependencies.getHelperPath();
    this.rightsConfirmed = hasYouTubeRightsConfirmation(dependencies.getPolicyVersion());
    this.resolveRequest = resolveRequest;
  }

  override onOpen(): void {
    this.setTitle(`${t('commands.transcribeYouTube')} · ${t('youtube.modal.experimentalBadge')}`);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: t('youtube.modal.disclosure') });
    this.contentEl.createEl('p', { text: t('youtube.modal.urlDescription') });

    const helperSetting = new Setting(this.contentEl).setName(t('youtube.modal.helperName'));
    helperSetting.addText((text: TextComponent) => {
      text.setPlaceholder(t('youtube.modal.helperPlaceholder'));
      text.setValue(this.helperPath);
      text.onChange((value) => {
        this.helperPath = value;
        this.helperVersion = '';
      });
    });
    helperSetting.addButton((button) =>
      button.setButtonText(t('youtube.modal.checkHelper')).onClick(() => {
        void this.probeSelectedHelper();
      }),
    );
    const suggestions = discoverYtDlpCandidates();
    if (suggestions.length > 0) {
      this.contentEl.createEl('p', {
        text: t('youtube.modal.suggestions', { suggestions: suggestions.join(', ') }),
      });
    }
    this.contentEl.createEl('p', {
      text: this.rightsConfirmed
        ? t('youtube.modal.policyAccepted', { policy: YOUTUBE_POLICY_VERSION })
        : t('youtube.modal.policyRequired'),
    });
    if (!this.rightsConfirmed) {
      new Setting(this.contentEl).setName(t('youtube.modal.rightsLabel')).addToggle((toggle) => {
        toggle.setValue(false);
        toggle.onChange((value) => {
          this.rightsConfirmed = value;
        });
      });
    }

    new Setting(this.contentEl)
      .setName(t('youtube.modal.urlName'))
      .addText((text: TextComponent) => {
        text.setPlaceholder(t('youtube.modal.urlPlaceholder'));
        text.onChange((value) => {
          this.url = value;
          this.updateSummary();
        });
      });
    this.summaryEl = this.contentEl.createDiv({ cls: 'local-stt-youtube-source-summary' });
    this.errorEl = this.contentEl.createDiv({ attr: { role: 'alert' } });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t('common.cancel')).onClick(() => this.close()))
      .addButton((button) => {
        this.confirmButton = button;
        button
          .setButtonText(t('youtube.modal.transcribe'))
          .setCta()
          .onClick(() => {
            void this.submit();
          });
      });
    this.updateSummary();
    if (this.helperPath.length > 0) void this.probeSelectedHelper();
  }

  override onClose(): void {
    this.settled = true;
    this.generation += 1;
    this.lifecycle.abort();
    this.probeController?.abort();
    this.probeController = null;
    this.contentEl.empty();
    this.errorEl = null;
    this.summaryEl = null;
    this.confirmButton = null;
    this.resolveRequest?.(null);
    this.resolveRequest = null;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.settled && !signal.aborted && generation === this.generation;
  }

  private updateSummary(): void {
    if (this.summaryEl === null) return;
    this.summaryEl.empty();
    if (this.url.trim().length === 0) return;
    try {
      const video = parseYouTubeVideoUrl(this.url);
      this.summaryEl.setText(
        t('youtube.modal.summary', {
          canonicalUrl: video.canonicalUrl,
          host: video.host,
          videoId: video.videoId,
        }),
      );
    } catch {
      this.summaryEl.setText(t('youtube.modal.invalidSummary'));
    }
  }

  private async probeSelectedHelper(): Promise<void> {
    this.probeController?.abort();
    const controller = new AbortController();
    this.probeController = controller;
    const generation = this.generation;
    const normalized = normalizeYouTubeHelperPath(this.helperPath);
    if (normalized === null) {
      this.setError(t('youtube.modal.pathRequired'));
      return;
    }
    try {
      const result = await probeYtDlpVersion(normalized, { signal: controller.signal });
      if (!this.isCurrent(generation, controller.signal)) return;
      this.helperPath = result.path;
      this.helperVersion = result.version;
      await this.dependencies.onHelperSelected(result.path, result.version, this.lifecycle.signal);
      if (!this.isCurrent(generation, controller.signal)) return;
      this.setError(t('youtube.modal.helperReady', { version: result.version }));
    } catch {
      if (this.isCurrent(generation, controller.signal)) {
        this.helperVersion = '';
        this.setError(t('youtube.modal.helperError'));
      }
    } finally {
      if (this.probeController === controller) this.probeController = null;
    }
  }

  private async submit(): Promise<void> {
    if (this.settled) return;
    this.confirmButton?.setDisabled(true);
    this.setError('');
    const generation = this.generation;
    try {
      const video = parseYouTubeVideoUrl(this.url);
      const normalized = normalizeYouTubeHelperPath(this.helperPath);
      if (normalized === null) throw new Error('absolute helper path required');
      if (this.helperVersion.length === 0) {
        await this.probeSelectedHelper();
        if (!this.isCurrent(generation, this.lifecycle.signal)) return;
      }
      if (!this.rightsConfirmed) throw new Error('rights confirmation required');
      if (!hasYouTubeRightsConfirmation(this.dependencies.getPolicyVersion())) {
        await this.dependencies.onRightsConfirmed(this.lifecycle.signal);
        if (!this.isCurrent(generation, this.lifecycle.signal)) return;
      }
      const request: YouTubeMediaSourceRequest = {
        consent: explicitYouTubeRightsConfirmation(),
        ref: video,
      };
      if (!this.isCurrent(generation, this.lifecycle.signal)) return;
      this.settled = true;
      this.resolveRequest?.(request);
      this.resolveRequest = null;
      this.close();
    } catch {
      if (this.isCurrent(generation, this.lifecycle.signal)) {
        this.setError(t('youtube.modal.submitError'));
      }
    } finally {
      this.confirmButton?.setDisabled(false);
    }
  }

  private setError(message: string): void {
    this.errorEl?.setText(message);
  }
}
