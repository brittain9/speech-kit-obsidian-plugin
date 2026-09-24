import { type App, Modal } from 'obsidian';

import type { MediaLlmPreview } from '../dictation/media-llm-processor';
import { t } from '../shared/i18n';

export function confirmMediaLlmPreview(
  app: App,
  preview: MediaLlmPreview,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    let removeAbortListener = (): void => {};
    const finish = (confirmed: boolean): void => {
      removeAbortListener();
      resolve(confirmed);
    };
    const modal = new MediaLlmPreviewModal(app, preview, finish);
    const onAbort = (): void => {
      finish(false);
      modal.close();
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    }
    modal.open();
  });
}

class MediaLlmPreviewModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly preview: MediaLlmPreview,
    private readonly resolve: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: t('llm.mediaPreview.title') });
    contentEl.createEl('p', { text: t('llm.mediaPreview.description') });
    contentEl.createEl('pre', {
      cls: 'local-stt-media-llm-preview',
      text: this.preview.text,
    });

    const buttons = contentEl.createDiv({ cls: 'local-stt-media-llm-preview__actions' });
    const keepRaw = buttons.createEl('button', { text: t('common.cancel') });
    keepRaw.addEventListener('click', () => this.settle(false));
    const apply = buttons.createEl('button', {
      cls: 'mod-cta',
      text: t('llm.mediaPreview.apply'),
    });
    apply.addEventListener('click', () => this.settle(true));
  }

  override onClose(): void {
    this.contentEl.empty();
    this.settle(false);
  }

  private settle(confirmed: boolean): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolve(confirmed);
    this.close();
  }
}
