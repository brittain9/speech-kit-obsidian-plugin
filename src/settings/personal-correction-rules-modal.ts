import { randomUUID } from 'node:crypto';

import type { App, TextAreaComponent } from 'obsidian';
import { Modal, Setting } from 'obsidian';

import { type TranslationKey, t, tPlural } from '../shared/i18n';
import {
  buildPersonalCorrectionRuleDrafts,
  compilePersonalCorrectionPreview,
  InvalidRuleDraft,
  normalizePersonalCorrectionRules,
  type PersonalCorrectionPreviewResult,
  type PersonalCorrectionRule,
  type PersonalCorrectionRuleDraft,
} from './personal-correction-rules';
import type { PluginSettings } from './plugin-settings';
import type { SettingsMutationFacade } from './settings-mutation';

interface PersonalCorrectionRulesModalDependencies {
  getSettings: () => PluginSettings;
  mutateSettings: SettingsMutationFacade['mutateSettings'];
}

type SaveState = 'conflict' | 'error' | 'idle' | 'saved' | 'saving' | 'unsaved';

const DEFAULT_PREVIEW_INPUT = 'The café AI system is ready.';

export class PersonalCorrectionRulesModal extends Modal {
  private draft: PersonalCorrectionRuleDraft[];
  private previewInput = DEFAULT_PREVIEW_INPUT;
  private previewResult: PersonalCorrectionPreviewResult | null = null;
  private previewStatusEl: HTMLElement | null = null;
  private previewOutput: TextAreaComponent | null = null;
  private countSetting: Setting | null = null;
  private saveStatusEl: HTMLElement | null = null;
  private readonly ruleRows = new Map<number, Setting>();
  private persistChain: Promise<void> = Promise.resolve();
  private pendingSaves = 0;
  private saveState: SaveState = 'idle';
  private dirtyRevision = 0;
  private dirty = false;
  private saveGeneration = 0;
  private knownSettingsFingerprint: string;

  constructor(
    app: App,
    private readonly dependencies: PersonalCorrectionRulesModalDependencies,
  ) {
    super(app);
    const settings = dependencies.getSettings();
    this.draft = buildPersonalCorrectionRuleDrafts(
      settings.personalCorrectionRules,
      settings.personalCorrectionRuleDiagnostics,
      settings.personalCorrectionRuleOrder,
    );
    this.knownSettingsFingerprint = correctionSettingsFingerprint(settings);
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
    this.countSetting = null;
    this.saveStatusEl = null;
    this.ruleRows.clear();
  }

  private markDirty(): void {
    this.dirty = true;
    this.dirtyRevision += 1;
    this.saveState = 'unsaved';
    this.updateSaveStatus();
  }

  private render(): void {
    this.contentEl.empty();
    this.previewStatusEl = null;
    this.previewOutput = null;
    this.countSetting = null;
    this.saveStatusEl = null;
    this.ruleRows.clear();

    this.contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('settings.corrections.modal.intro'),
    });

    const previewSetting = new Setting(this.contentEl)
      .setName(t('settings.corrections.modal.preview'))
      .setDesc(
        tPlural(
          0,
          {
            one: 'settings.corrections.modal.previewSummaryOne',
            other: 'settings.corrections.modal.previewSummaryOther',
          },
          { replacements: 0, rules: 0 },
        ),
      );
    previewSetting.addTextArea((textArea) => {
      textArea.setValue(this.previewInput);
      textArea.onChange((value) => {
        this.previewInput = value;
        // Editing the example is not a settings mutation and must not enqueue
        // a write or move focus while the user is typing.
        this.updatePreview(false);
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
    this.saveStatusEl = this.contentEl.createEl('p', {
      cls: 'local-stt-corrections-modal__save-status',
    });

    this.countSetting = new Setting(this.contentEl)
      .setName(this.countsLabel())
      .setDesc(this.draft.length === 0 ? t('settings.corrections.modal.empty') : '')
      .addButton((button) => {
        button.setButtonText(t('settings.corrections.modal.add')).onClick(() => {
          this.draft = [...this.draft, { enabled: true, find: '', id: randomUUID(), replace: '' }];
          this.markDirty();
          this.render();
        });
      });

    this.draft.forEach((rule, index) => {
      this.renderRule(rule, index);
    });
    this.updatePreview(false);
    this.updateSaveStatus();
  }

  private renderRule(rule: PersonalCorrectionRuleDraft, index: number): void {
    const row = new Setting(this.contentEl)
      .setName(this.ruleName(rule, index))
      .setDesc(this.ruleDescription(rule));
    this.ruleRows.set(index, row);

    row.addToggle((toggle) => {
      toggle.setValue(draftEnabled(rule));
      toggle.onChange((enabled) => this.updateRule(index, { enabled }));
    });
    if (isInvalidDraft(rule)) {
      row.addText((text) => {
        text.setPlaceholder(t('settings.corrections.field.id'));
        text.setValue(draftString(rule, 'id'));
        text.onChange((value) => this.updateRule(index, { id: value }));
      });
    }
    row.addText((text) => {
      text.setPlaceholder(t('settings.corrections.modal.find'));
      text.setValue(draftString(rule, 'find'));
      text.onChange((value) => this.updateRule(index, { find: value }));
    });
    row.addText((text) => {
      text.setPlaceholder(t('settings.corrections.modal.replace'));
      text.setValue(draftString(rule, 'replace'));
      text.onChange((value) => this.updateRule(index, { replace: value }));
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
          this.markDirty();
          this.render();
          this.persistIfValid();
        });
    });
  }

  private updateRule(index: number, update: Partial<PersonalCorrectionRule>): void {
    this.draft = this.draft.map((rule, ruleIndex) => {
      if (ruleIndex !== index) return rule;
      if (isInvalidDraft(rule)) {
        return rule.update(update);
      }
      return isRecord(rule) ? { ...rule, ...update } : { ...update };
    });
    this.markDirty();
    this.updateRuleLabels(index);
    this.updatePreview();
  }

  private moveRule(index: number, targetIndex: number): void {
    if (targetIndex < 0 || targetIndex >= this.draft.length) return;
    const next = [...this.draft];
    const [rule] = next.splice(index, 1);
    if (rule === undefined) return;
    next.splice(targetIndex, 0, rule);
    this.draft = next;
    this.markDirty();
    this.render();
    this.persistIfValid();
  }

  private updatePreview(persist = true): void {
    this.previewResult = compilePersonalCorrectionPreview(this.draftInputs(), this.previewInput);
    this.updateRuleHighlight();
    this.updateCountLabels();
    if (this.previewOutput !== null) {
      this.previewOutput.setValue(this.previewResult.ok ? this.previewResult.output : '');
    }
    if (this.previewStatusEl === null) return;
    if (this.previewResult.ok) {
      this.previewStatusEl.setText(
        tPlural(
          this.previewResult.replacements,
          {
            one: 'settings.corrections.modal.previewSummaryOne',
            other: 'settings.corrections.modal.previewSummaryOther',
          },
          {
            replacements: this.previewResult.replacements,
            rules: this.previewResult.rulesApplied,
          },
        ),
      );
      if (persist) this.persistIfValid();
      else this.updateSaveStatus();
      return;
    }
    this.previewStatusEl.setText(this.previewResult.error.message);
    if (this.dirty) this.saveState = 'unsaved';
    this.updateSaveStatus();
  }

  private updateRuleLabels(index: number): void {
    const rule = this.draft[index];
    const row = this.ruleRows.get(index);
    if (rule === undefined || row === undefined) return;
    row.setName(this.ruleName(rule, index)).setDesc(this.ruleDescription(rule));
  }

  private updateRuleHighlight(): void {
    const invalidIndex =
      this.previewResult?.ok === false ? this.previewResult.error.index : undefined;
    for (const [index, row] of this.ruleRows) {
      const invalid = invalidIndex === index;
      row.settingEl.classList.toggle('local-stt-corrections-modal__rule--invalid', invalid);
      row.settingEl.setAttribute('aria-invalid', String(invalid));
    }
  }

  private updateCountLabels(): void {
    this.countSetting?.setName(this.countsLabel());
  }

  private ruleName(rule: PersonalCorrectionRuleDraft, index: number): string {
    return `${index + 1}. ${draftString(rule, 'find') || t('settings.corrections.modal.find')}`;
  }

  private ruleDescription(rule: PersonalCorrectionRuleDraft): string {
    if (isInvalidDraft(rule)) {
      return t('settings.corrections.validation.invalidRule');
    }
    const find = draftString(rule, 'find');
    const replace = draftString(rule, 'replace');
    return `${t('settings.corrections.modal.find')}: ${find} → ${t('settings.corrections.modal.replace')}: ${replace} · ${t('settings.corrections.modal.enabled')}: ${draftEnabled(rule) ? t('common.on') : t('common.off')}`;
  }

  private countsLabel(): string {
    return tPlural(
      this.draft.length,
      {
        one: 'settings.corrections.modal.countsOne',
        other: 'settings.corrections.modal.countsOther',
      },
      {
        enabled: this.draft.filter((rule) => draftEnabled(rule)).length,
        total: this.draft.length,
      },
    );
  }

  private persistIfValid(): void {
    if (this.previewResult === null || !this.previewResult.ok) {
      this.saveState = 'unsaved';
      this.updateSaveStatus();
      return;
    }

    const generation = ++this.saveGeneration;
    const revision = this.dirtyRevision;
    const normalized = normalizePersonalCorrectionRules(this.draftInputs());
    const rules = normalized.rules;
    const order = normalized.order;
    this.pendingSaves += 1;
    this.saveState = 'saving';
    this.updateSaveStatus();
    const operation = this.persistChain.then(() =>
      this.dependencies.mutateSettings((settings) => {
        if (correctionSettingsFingerprint(settings) !== this.knownSettingsFingerprint) {
          throw new SettingsConflictError();
        }
        return {
          ...settings,
          personalCorrectionRuleDiagnostics: normalized.diagnostics,
          personalCorrectionRuleOrder: order,
          personalCorrectionRules: rules,
        };
      }),
    );
    this.persistChain = operation.catch(() => undefined);
    void operation
      .then(() => {
        this.pendingSaves -= 1;
        this.knownSettingsFingerprint = correctionSettingsFingerprint(
          this.dependencies.getSettings(),
        );
        if (
          generation === this.saveGeneration &&
          revision === this.dirtyRevision &&
          this.pendingSaves === 0
        ) {
          this.dirty = false;
          this.saveState = 'saved';
        }
        this.updateSaveStatus();
      })
      .catch((error: unknown) => {
        this.pendingSaves -= 1;
        if (generation === this.saveGeneration) {
          this.dirty = true;
          this.saveState = error instanceof SettingsConflictError ? 'conflict' : 'error';
        }
        this.updateSaveStatus();
      });
  }

  private draftInputs(): unknown[] {
    return this.draft.map((rule) => draftInput(rule));
  }

  private updateSaveStatus(): void {
    if (this.saveStatusEl === null) return;
    const isUnsaved = this.dirty && this.saveState === 'unsaved';
    const key: TranslationKey = isUnsaved
      ? 'settings.corrections.modal.unsaved'
      : this.pendingSaves > 0
        ? 'settings.corrections.modal.saving'
        : this.saveState === 'conflict'
          ? 'settings.corrections.modal.conflict'
          : this.saveState === 'error'
            ? 'settings.corrections.modal.retry'
            : this.dirty || this.previewResult?.ok === false
              ? 'settings.corrections.modal.unsaved'
              : 'settings.corrections.modal.saved';
    this.saveStatusEl.setText(t(key));
    this.saveStatusEl.setAttribute(
      'data-state',
      isUnsaved
        ? 'unsaved'
        : this.pendingSaves > 0
          ? 'saving'
          : this.saveState === 'conflict'
            ? 'conflict'
            : this.saveState === 'error'
              ? 'error'
              : this.dirty || this.previewResult?.ok === false
                ? 'unsaved'
                : 'saved',
    );
  }
}

function draftInput(draft: PersonalCorrectionRuleDraft): unknown {
  return isInvalidDraft(draft) ? draft.raw : draft;
}

function draftString(draft: PersonalCorrectionRuleDraft, field: 'find' | 'id' | 'replace'): string {
  const source = isInvalidDraft(draft)
    ? isRecord(draft.raw)
      ? draft.raw
      : null
    : isRecord(draft)
      ? draft
      : null;
  return source !== null && typeof source[field] === 'string' ? source[field] : '';
}

function draftEnabled(draft: PersonalCorrectionRuleDraft): boolean {
  const source = isInvalidDraft(draft) ? draft.raw : draft;
  return isRecord(source) && source.enabled === true;
}

function isInvalidDraft(draft: PersonalCorrectionRuleDraft): draft is InvalidRuleDraft {
  return draft instanceof InvalidRuleDraft;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class SettingsConflictError extends Error {
  constructor() {
    super('Correction rules changed elsewhere.');
    this.name = 'SettingsConflictError';
  }
}

function correctionSettingsFingerprint(settings: PluginSettings): string {
  return JSON.stringify({
    diagnostics: settings.personalCorrectionRuleDiagnostics,
    order: settings.personalCorrectionRuleOrder,
    rules: settings.personalCorrectionRules,
  });
}
