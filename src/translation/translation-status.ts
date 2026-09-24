import { t } from '../shared/i18n';
import type { TranslationJobState } from './translation-job';

/** Presents the detached translation job as a keyboard-operable live action. */
export class TranslationStatusController {
  private readonly button: HTMLButtonElement;
  private readonly liveRegion: HTMLElement;
  private reopen: (() => void) | null = null;

  constructor(private readonly element: HTMLElement) {
    this.button = this.element.createEl('button', {
      attr: { type: 'button' },
      cls: 'local-stt-translation-status',
    });
    this.liveRegion = this.button.createSpan({
      attr: {
        'aria-atomic': 'true',
        'aria-live': 'polite',
        role: 'status',
      },
    });
    this.button.addEventListener('click', () => this.reopen?.());
    this.clear();
  }

  update(state: TranslationJobState | null, reopen: () => void): void {
    if (state === null) {
      this.clear();
      return;
    }
    const text = translationStatusText(state);
    const label = t('translation.modal.reopen', { status: text });
    this.reopen = reopen;
    this.button.disabled = false;
    this.button.setAttribute('aria-label', label);
    this.button.setAttribute('title', label);
    this.liveRegion.textContent = text;
    this.element.toggle(true);
  }

  private clear(): void {
    this.reopen = null;
    this.button.disabled = true;
    this.button.removeAttribute('aria-label');
    this.button.removeAttribute('title');
    this.liveRegion.textContent = '';
    this.element.toggle(false);
  }
}

function translationStatusText(state: TranslationJobState): string {
  switch (state.phase) {
    case 'idle':
    case 'loading':
      return t('translation.modal.loading');
    case 'translating':
      return state.total > 1
        ? t('translation.modal.translatingProgress', {
            completed: state.completed,
            total: state.total,
          })
        : t('translation.modal.translating');
    case 'missing_model':
      return t('translation.modal.missingModel');
    case 'cancelled':
      return t('translation.modal.canceled');
    case 'failed':
      return t('translation.modal.failed');
    case 'completed':
      return t('translation.modal.ready');
    default:
      return assertNever(state);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled translation status: ${value as string}`);
}
