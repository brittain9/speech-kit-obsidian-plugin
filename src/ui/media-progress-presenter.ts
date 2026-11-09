import type { MediaTranscriptionProgress } from '../media/media-source';
import { t } from '../shared/i18n';

export function renderMediaProgressStatus(
  element: HTMLElement,
  progress: MediaTranscriptionProgress | null,
  hasPartialRecovery = false,
  openRecovery?: () => void,
): void {
  element.empty();
  element.removeAttribute('aria-label');
  if (progress === null && hasPartialRecovery) {
    const message = t('media.progress.needsAttention');
    element.removeAttribute('role');
    element.removeAttribute('aria-live');
    const button = element.createEl('button', {
      attr: { type: 'button' },
      cls: 'local-stt-status-action',
      text: message,
    });
    button.addEventListener('click', () => openRecovery?.());
    const live = element.createSpan({ cls: 'local-stt-status-live', text: message });
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    element.toggle(true);
    return;
  }
  if (progress === null) {
    element.toggle(false);
    element.removeAttribute('role');
    element.removeAttribute('aria-live');
    return;
  }

  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-label', mediaProgressText(progress));
  element.toggle(true);
  element.setText(mediaProgressText(progress));
}

export function mediaProgressText(progress: MediaTranscriptionProgress): string {
  switch (progress.phase) {
    case 'captions':
      return t('media.progress.captions');
    case 'acquire':
      return t('media.progress.acquire');
    case 'decode':
      return t('media.progress.decode');
    case 'transcribe':
      return t('media.progress.transcribe');
    case 'format':
      return t('media.progress.format');
    case 'ai_processing':
      return t('media.progress.aiProcessing');
    case 'insert':
      return t('media.progress.insert');
  }
}
