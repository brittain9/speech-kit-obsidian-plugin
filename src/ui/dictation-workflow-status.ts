import type { DictationWorkflowStatus } from '../dictation/dictation-session-controller';
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
