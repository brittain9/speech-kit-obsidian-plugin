import { type App, type ButtonComponent, Modal, Setting, type TextComponent } from 'obsidian';
import type { MediaRights, SourceRef } from '../media/media-source';
import {
  discoverYtDlpCandidates,
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
} from '../media/youtube-helper';
import {
  explicitYouTubeRightsConfirmation,
  hasYouTubeRightsConfirmation,
  YOUTUBE_POLICY_VERSION,
} from '../media/youtube-media-source';
import { parseYouTubeVideoUrl } from '../media/youtube-url';
import { t } from '../shared/i18n';

export interface YouTubeMediaSourceRequest {
  readonly helperPath: string;
  readonly helperVersion: string;
  readonly ref: SourceRef;
  readonly rights: MediaRights;
}

export interface YouTubeMediaSourceModalDependencies {
  readonly getHelperPath: () => string;
  readonly getPolicyVersion: () => string | null;
  readonly onHelperSelected: (path: string, version: string) => Promise<void>;
  readonly onRightsConfirmed: () => Promise<void>;
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
    this.setTitle(`${t('commands.transcribeYouTube')} · Experimental`);
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: 'Unofficial helper disclosure: yt-dlp contacts YouTube using an external executable and may stop working when YouTube changes. Speech Kit does not bundle or update it.',
    });
    this.contentEl.createEl('p', {
      text: 'Enter exactly one public YouTube VOD watch, youtu.be, or Shorts URL. Playlists, channels, live streams, and arbitrary URLs are not supported.',
    });

    const helperSetting = new Setting(this.contentEl).setName('yt-dlp executable');
    helperSetting.addText((text: TextComponent) => {
      text.setPlaceholder('/absolute/path/to/yt-dlp');
      text.setValue(this.helperPath);
      text.onChange((value) => {
        this.helperPath = value;
        this.helperVersion = '';
      });
    });
    helperSetting.addButton((button) =>
      button.setButtonText('Check helper').onClick(() => {
        void this.probeSelectedHelper();
      }),
    );
    const suggestions = discoverYtDlpCandidates();
    if (suggestions.length > 0) {
      this.contentEl.createEl('p', {
        text: `Existing PATH suggestions (not executed during discovery): ${suggestions.join(', ')}`,
      });
    }
    this.contentEl.createEl('p', {
      text: this.rightsConfirmed
        ? `Rights confirmation already accepted for policy ${YOUTUBE_POLICY_VERSION}; no repeated prompt will be shown.`
        : 'One-time rights confirmation: I own this video or am authorized to process it. Public visibility is not permission.',
    });
    if (!this.rightsConfirmed) {
      new Setting(this.contentEl)
        .setName('I own or am authorized to process this video')
        .addToggle((toggle) => {
          toggle.setValue(false);
          toggle.onChange((value) => {
            this.rightsConfirmed = value;
          });
        });
    }

    new Setting(this.contentEl).setName('YouTube VOD URL').addText((text: TextComponent) => {
      text.setPlaceholder('https://www.youtube.com/watch?v=…');
      text.onChange((value) => {
        this.url = value;
        this.updateSummary();
      });
    });
    this.summaryEl = this.contentEl.createDiv({ cls: 'local-stt-youtube-source-summary' });
    this.errorEl = this.contentEl.createDiv({ attr: { role: 'alert' } });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) => {
        this.confirmButton = button;
        button
          .setButtonText('Transcribe')
          .setCta()
          .onClick(() => {
            void this.submit();
          });
      });
    this.updateSummary();
    if (this.helperPath.length > 0) {
      void this.probeSelectedHelper();
    }
  }

  override onClose(): void {
    this.contentEl.empty();
    this.errorEl = null;
    this.summaryEl = null;
    this.confirmButton = null;
    this.resolveRequest?.(null);
    this.resolveRequest = null;
  }

  private updateSummary(): void {
    if (this.summaryEl === null) return;
    this.summaryEl.empty();
    if (this.url.trim().length === 0) return;
    try {
      const video = parseYouTubeVideoUrl(this.url);
      this.summaryEl.setText(
        `Canonical video: ${video.canonicalUrl} · Host: ${video.host} · ID: ${video.videoId}`,
      );
    } catch {
      this.summaryEl.setText('Enter one valid YouTube VOD URL.');
    }
  }

  private async probeSelectedHelper(text?: TextComponent): Promise<void> {
    const normalized = normalizeYouTubeHelperPath(this.helperPath);
    if (normalized === null) return;
    try {
      const result = await probeYtDlpVersion(normalized);
      this.helperPath = result.path;
      this.helperVersion = result.version;
      text?.setValue(result.path);
      await this.dependencies.onHelperSelected(result.path, result.version);
      this.setError(`Helper ready: ${result.version}`);
    } catch {
      this.helperVersion = '';
      this.setError('The selected helper is missing, unsupported, or could not be run.');
    }
  }

  private async submit(): Promise<void> {
    this.confirmButton?.setDisabled(true);
    this.setError('');
    try {
      const video = parseYouTubeVideoUrl(this.url);
      const normalized = normalizeYouTubeHelperPath(this.helperPath);
      if (normalized === null) throw new Error('absolute helper path required');
      if (this.helperVersion.length === 0) {
        const result = await probeYtDlpVersion(normalized);
        this.helperPath = result.path;
        this.helperVersion = result.version;
        await this.dependencies.onHelperSelected(result.path, result.version);
      }
      if (!this.rightsConfirmed) throw new Error('rights confirmation required');
      if (!hasYouTubeRightsConfirmation(this.dependencies.getPolicyVersion())) {
        await this.dependencies.onRightsConfirmed();
      }
      const request: YouTubeMediaSourceRequest = {
        helperPath: this.helperPath,
        helperVersion: this.helperVersion,
        ref: { kind: 'youtube_video_id', videoId: video.videoId },
        rights: explicitYouTubeRightsConfirmation(),
      };
      this.resolveRequest?.(request);
      this.resolveRequest = null;
      this.close();
    } catch {
      this.setError(
        'Enter a valid single VOD URL, select a supported absolute helper, and confirm rights.',
      );
    } finally {
      this.confirmButton?.setDisabled(false);
    }
  }

  private setError(message: string): void {
    this.errorEl?.setText(message);
  }
}
