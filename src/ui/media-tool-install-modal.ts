import { type App, Modal, Setting } from 'obsidian';

import {
  installMediaTools,
  isMediaToolInstalled,
  type MediaToolInstallProgress,
} from '../audio/media-tool-installer';
import { t } from '../shared/i18n';

export class MediaToolInstallModal extends Modal {
  private abortController: AbortController | null = null;
  private closed = false;
  private installed = false;
  private error = '';
  private progress: MediaToolInstallProgress | null = null;

  constructor(
    app: App,
    private readonly pluginDirectory: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t('media.tools.title'));
    this.render();
    void isMediaToolInstalled(this.pluginDirectory).then((installed) => {
      if (this.closed) return;
      this.installed = installed;
      this.render();
    });
  }

  override onClose(): void {
    this.closed = true;
    this.abortController?.abort();
    this.contentEl.empty();
  }

  private render(): void {
    if (this.closed) return;
    this.contentEl.empty();
    this.contentEl.createEl('p', {
      text: this.installed ? t('media.tools.ready') : t('media.tools.description'),
    });
    if (this.progress !== null) {
      const progress = this.progress;
      const downloaded =
        progress.totalBytes !== null && progress.totalBytes > 0
          ? ` ${String(Math.floor((progress.bytesDownloaded / progress.totalBytes) * 100))}%`
          : '';
      this.contentEl.createEl('p', {
        attr: { role: 'status', 'aria-live': 'polite' },
        text: `${t(`media.tools.phase.${progress.phase}`)}${downloaded}`,
      });
    }
    if (this.error.length > 0) {
      this.contentEl.createEl('p', { attr: { role: 'alert' }, text: this.error });
    }
    const actions = new Setting(this.contentEl);
    actions.addButton((button) => {
      button
        .setButtonText(this.abortController === null ? t('common.close') : t('media.tools.cancel'))
        .onClick(() => {
          if (this.abortController !== null) this.abortController.abort();
          else this.close();
        });
    });
    if (this.abortController === null) {
      actions.addButton((button) => {
        button
          .setButtonText(this.installed ? t('media.tools.reinstall') : t('media.tools.install'))
          .setCta()
          .onClick(() => void this.install());
      });
    }
  }

  private async install(): Promise<void> {
    if (this.abortController !== null) return;
    const controller = new AbortController();
    this.abortController = controller;
    this.error = '';
    this.progress = { bytesDownloaded: 0, totalBytes: null, phase: 'download' };
    this.render();
    try {
      await installMediaTools({
        pluginDirectory: this.pluginDirectory,
        signal: controller.signal,
        onProgress: (progress) => {
          this.progress = progress;
          this.render();
        },
      });
      this.installed = true;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.error = error instanceof Error ? error.message : t('media.tools.failed');
      }
    } finally {
      this.abortController = null;
      this.progress = null;
      this.render();
    }
  }
}
