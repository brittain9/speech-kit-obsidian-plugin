import { Setting } from 'obsidian';
import { t } from '../shared/i18n';

export function renderLlmProviderSettings(parent: HTMLElement, openSidebar: () => void): void {
  new Setting(parent)
    .setName(t('settings.llm.provider.name'))
    .setDesc(t('settings.llm.provider.desc'))
    .addButton((button) =>
      button.setButtonText(t('settings.llm.provider.button')).onClick(openSidebar),
    );
}
