import type { MediaTranscriptionProgress } from '../media/media-source';
import { t } from '../shared/i18n';

export function renderMediaProgressStatus(
  element: HTMLElement,
  progress: MediaTranscriptionProgress | null,
): void {
  element.empty();
  element.removeAttribute('aria-label');
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
