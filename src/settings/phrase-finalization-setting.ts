import { t } from '../shared/i18n';
import type { SpeakingStyle } from '../sidecar/protocol';

export const PHRASE_FINALIZATION_TOOLTIP = [
  `${t('settings.phraseFinalization.responsiveOption')}: ${t('settings.phraseFinalization.responsive')}`,
  `${t('settings.phraseFinalization.balancedOption')}: ${t('settings.phraseFinalization.balanced')}`,
  `${t('settings.phraseFinalization.patientOption')}: ${t('settings.phraseFinalization.patient')}`,
  t('settings.phraseFinalization.tooltip'),
].join('\n\n');

export function phraseFinalizationDescription(style: SpeakingStyle): string {
  return t(`settings.phraseFinalization.${style}`);
}
