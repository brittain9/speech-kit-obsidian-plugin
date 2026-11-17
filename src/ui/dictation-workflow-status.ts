import type {
  DictationControllerState,
  DictationWorkflowStatus,
} from '../dictation/dictation-session-controller';
import { t } from '../shared/i18n';

export function renderDictationWorkflowStatus(
  element: HTMLElement,
  status: DictationWorkflowStatus,
): void {
  const parts: string[] = [];
  if (status.capture === 'starting') parts.push(t('dictation.status.starting'));
  if (status.capture === 'listening') parts.push(t('dictation.status.listening'));
  if (status.transcribing) parts.push(t('dictation.status.transcribing'));
  if (status.queue === 'catching_up') parts.push(t('dictation.status.catchingUp'));
  if (status.queue === 'falling_behind' || status.queue === 'saturated')
    parts.push(t('dictation.status.fallingBehind'));
  if (status.finishing) parts.push(t('dictation.status.finishing'));
  if (status.providerCleanup) parts.push(t('dictation.status.provider'));
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setText(parts.join(' · '));
  element.toggle(parts.length > 0);
}

export function mountDictationStatusControl(
  element: HTMLElement,
  toggleDictation: () => Promise<void>,
): {
  render: (state: DictationControllerState, status: DictationWorkflowStatus) => void;
  dispose: () => void;
} {
  element.empty();
  element.addClass('local-stt-dictation-status');
  const button = element.createEl('button', {
    cls: 'local-stt-dictation-status__button',
    attr: { type: 'button' },
  });
  const statusEl = element.createSpan();
  const onClick = (): void => {
    void toggleDictation();
  };
  button.addEventListener('click', onClick);
  let disposed = false;
  return {
    render: (state, status) => {
      if (disposed) return;
      const active = state === 'listening' || state === 'speech_detected';
      const action =
        state === 'starting'
          ? 'starting'
          : active
            ? 'active'
            : state === 'error'
              ? 'error'
              : 'idle';
      const text = t(`dictation.control.${action}.text`);
      const label = t(`dictation.control.${action}.label`);
      button.setText(text);
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(active || state === 'starting'));
      renderDictationWorkflowStatus(statusEl, status);
      element.toggle(true);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      button.removeEventListener('click', onClick);
      element.empty();
    },
  };
}
