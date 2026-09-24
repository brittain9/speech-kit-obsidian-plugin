import { randomUUID } from 'node:crypto';

import type { App, TextAreaComponent } from 'obsidian';
import { Modal, Setting } from 'obsidian';

import { t } from '../shared/i18n';
import {
  compilePersonalCorrectionPreview,
  type PersonalCorrectionPreviewResult,
  type PersonalCorrectionRule,
} from './personal-correction-rules';
import type { PluginSettings } from './plugin-settings';

interface PersonalCorrectionRulesModalDependencies {
  getSettings: () => PluginSettings;
  saveSettings: (settings: PluginSettings) => Promise<void>;
}

const DEFAULT_PREVIEW_INPUT = 'The café AI system is ready.';

export class PersonalCorrectionRulesModal extends Modal {
  private draft: PersonalCorrectionRule[];
  private previewInput = DEFAULT_PREVIEW_INPUT;
  private previewResult: PersonalCorrectionPreviewResult | null = null;
  private previewStatusEl: HTMLElement | null = null;
  private previewOutput: TextAreaComponent | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    app: App,
    private readonly dependencies: PersonalCorrectionRulesModalDependencies,
  ) {
    super(app);
    this.draft = cloneRules(dependencies.getSettings().personalCorrectionRules);
  }

  override onOpen(): void {
    this.setTitle(t('settings.corrections.modal.title'));
    this.modalEl.addClass('local-stt-corrections-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.empty();
    this.previewStatusEl = null;
    this.previewOutput = null;
  }

  private render(): void {
    this.contentEl.empty();
    this.previewStatusEl = null;
    this.previewOutput = null;

    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.corrections.modal.intro'),
    });

    const previewSetting = new Setting(this.contentEl)
      .setName(t('settings.corrections.modal.preview'))
      .setDesc(
        t('settings.corrections.modal.previewSummary', {
          replacements: 0,
          rules: 0,
        }),
      );
    previewSetting.addTextArea((textArea) => {
      textArea.setValue(this.previewInput);
      textArea.onChange((value) => {
        this.previewInput = value;
        this.updatePreview();
      });
    });
    this.contentEl.createEl('p', {
      cls: 'local-stt-corrections-modal__label',
      text: t('settings.corrections.modal.previewInput'),
    });
    let outputTextArea: TextAreaComponent | null = null;
    new Setting(this.contentEl)
      .setName(t('settings.corrections.modal.previewOutput'))
      .addTextArea((textArea) => {
        outputTextArea = textArea;
        textArea.setValue('');
        textArea.setDisabled(true);
      });
    this.previewOutput = outputTextArea;
    this.previewStatusEl = this.contentEl.createEl('p', {
      cls: 'local-stt-corrections-modal__status',
    });

    new Setting(this.contentEl)
      .setName(
        t('settings.corrections.modal.counts', {
          enabled: this.draft.filter((rule) => rule.enabled).length,
          total: this.draft.length,
        }),
      )
      .setDesc(this.draft.length === 0 ? t('settings.corrections.modal.empty') : '')
      .addButton((button) => {
        button.setButtonText(t('settings.corrections.modal.add')).onClick(() => {
          this.draft = [...this.draft, { enabled: true, find: '', id: randomUUID(), replace: '' }];
          this.render();
        });
      });

    this.draft.forEach((rule, index) => {
      this.renderRule(rule, index);
    });
    this.updatePreview(false);
  }

  private renderRule(rule: PersonalCorrectionRule, index: number): void {
    const row = new Setting(this.contentEl)
      .setName(`${index + 1}. ${rule.find || t('settings.corrections.modal.find')}`)
      .setDesc(
        `${t('settings.corrections.modal.find')}: ${rule.find} → ${t('settings.corrections.modal.replace')}: ${rule.replace} · ${t('settings.corrections.modal.enabled')}: ${rule.enabled ? t('common.on') : t('common.off')}`,
      );

    row.addToggle((toggle) => {
      toggle.setValue(rule.enabled);
      toggle.onChange((enabled) => {
        this.updateRule(index, { enabled });
      });
    });
    row.addText((text) => {
      text.setPlaceholder(t('settings.corrections.modal.find'));
      text.setValue(rule.find);
      text.onChange((value) => {
        this.updateRule(index, { find: value });
      });
    });
    row.addText((text) => {
      text.setPlaceholder(t('settings.corrections.modal.replace'));
      text.setValue(rule.replace);
      text.onChange((value) => {
        this.updateRule(index, { replace: value });
      });
    });
    row.addExtraButton((button) => {
      button
        .setIcon('arrow-up')
        .setTooltip(t('settings.corrections.modal.moveUp'))
        .onClick(() => this.moveRule(index, index - 1));
    });
    row.addExtraButton((button) => {
      button
        .setIcon('arrow-down')
        .setTooltip(t('settings.corrections.modal.moveDown'))
        .onClick(() => this.moveRule(index, index + 1));
    });
    row.addExtraButton((button) => {
      button
        .setIcon('trash')
        .setTooltip(t('settings.corrections.modal.delete'))
        .onClick(() => {
          this.draft = this.draft.filter((_, ruleIndex) => ruleIndex !== index);
          this.render();
          this.persistIfValid();
        });
    });
  }

  private updateRule(index: number, update: Partial<PersonalCorrectionRule>): void {
    this.draft = this.draft.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...update } : rule,
    );
    this.updatePreview();
  }

  private moveRule(index: number, targetIndex: number): void {
    if (targetIndex < 0 || targetIndex >= this.draft.length) return;
    const next = [...this.draft];
    const [rule] = next.splice(index, 1);
    if (rule === undefined) return;
    next.splice(targetIndex, 0, rule);
    this.draft = next;
    this.render();
    this.persistIfValid();
  }

  private updatePreview(persist = true): void {
    this.previewResult = compilePersonalCorrectionPreview(this.draft, this.previewInput);
    if (this.previewOutput !== null) {
      this.previewOutput.setValue(this.previewResult.ok ? this.previewResult.output : '');
    }
    if (this.previewStatusEl === null) return;
    if (this.previewResult.ok) {
      this.previewStatusEl.setText(
        t('settings.corrections.modal.previewSummary', {
          replacements: this.previewResult.replacements,
          rules: this.previewResult.rulesApplied,
        }),
      );
      if (persist) this.persistIfValid();
      return;
    }
    this.previewStatusEl.setText(this.previewResult.error.message);
  }

  private persistIfValid(): void {
    if (this.previewResult === null || !this.previewResult.ok) return;
    const nextSettings = {
      ...this.dependencies.getSettings(),
      personalCorrectionRules: cloneRules(this.draft),
    };
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(() => this.dependencies.saveSettings(nextSettings));
  }
}

function cloneRules(rules: readonly PersonalCorrectionRule[]): PersonalCorrectionRule[] {
  return rules.map((rule) => ({ ...rule }));
}
