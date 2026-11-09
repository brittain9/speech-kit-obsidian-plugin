import { Menu, Setting, setIcon } from 'obsidian';
import { t } from '../shared/i18n';

interface ModelSummaryAction {
  label: string;
  onSelect: () => void;
}

export function renderModelSummaryRow(
  parent: HTMLElement,
  options: {
    taskLabel: string;
    modelName: string;
    icon: string;
    streaming: boolean;
    status: { modifier: string; text: string } | null;
    detail?: string;
    onOpen: () => void;
    actions: readonly ModelSummaryAction[];
  },
): void {
  const setting = new Setting(parent).setClass('local-stt-model-summary-row');
  setting.infoEl.empty();
  setting.infoEl.classList.add('local-stt-model-summary-info');
  setting.controlEl.classList.add('local-stt-model-summary-control');
  const primary = setting.infoEl.createEl('button', {
    cls: 'local-stt-model-summary-open',
    attr: { type: 'button' },
  });
  const icon = primary.createSpan({
    cls: 'local-stt-model-summary-icon',
    attr: { 'aria-hidden': 'true' },
  });
  setIcon(icon, options.icon);
  const text = primary.createSpan({ cls: 'local-stt-model-summary-text' });
  text.createSpan({
    cls: 'setting-item-name local-stt-model-summary-label',
    text: options.taskLabel,
  });
  const value = text.createSpan({ cls: 'local-stt-model-summary-value' });
  value.createSpan({ text: options.modelName });
  if (options.streaming)
    value.createSpan({
      cls: 'local-stt-badge local-stt-badge--streaming',
      text: t('settings.model.streaming'),
    });
  if (options.status !== null)
    value.createSpan({
      cls: `local-stt-badge local-stt-badge--${options.status.modifier}`,
      text: options.status.text,
    });
  if (options.detail)
    text.createSpan({ cls: 'local-stt-model-summary-detail', text: options.detail });
  const chevron = primary.createSpan({
    cls: 'local-stt-model-summary-chevron',
    attr: { 'aria-hidden': 'true' },
  });
  setIcon(chevron, 'chevron-right');
  primary.addEventListener('click', options.onOpen);

  if (options.actions.length > 0) {
    const more = setting.controlEl.createEl('button', {
      cls: 'clickable-icon local-stt-model-summary-more',
      attr: {
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-label': t('settings.model.moreActions', { task: options.taskLabel }),
      },
    });
    setIcon(more, 'ellipsis');
    more.addEventListener('click', () => {
      const menu = new Menu();
      for (const action of options.actions)
        menu.addItem((item) => item.setTitle(action.label).onClick(action.onSelect));
      const bounds = more.getBoundingClientRect();
      menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, more.ownerDocument);
    });
  }
}
