import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PersonalCorrectionRulesModal } from '../src/settings/personal-correction-rules-modal';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { Setting } from './__mocks__/obsidian';

describe('PersonalCorrectionRulesModal', () => {
  beforeEach(() => Setting.reset());

  it('does not persist or preview an invalid blank draft', async () => {
    const mutateSettings = vi.fn(async () => {});
    const modal = new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      mutateSettings,
    });
    modal.open();

    await Setting.buttonNamed('Add rule').click();

    const previewTextAreas = Setting.instances.flatMap((setting) => setting.textAreaComponents);
    expect(previewTextAreas.at(-2)?.inputEl.value).toBe('The café AI system is ready.');
    expect(previewTextAreas.at(-1)?.inputEl.value).toBe('');
    const row = Setting.named('1. Find');
    expect(row.settingEl.classList.contains('local-stt-corrections-modal__rule--invalid')).toBe(
      true,
    );
    expect(
      modal.contentEl.querySelector('.local-stt-corrections-modal__status')?.textContent,
    ).toContain('Rule 1');
    expect(row.settingEl.getAttribute('aria-invalid')).toBe('true');
    expect(
      modal.contentEl.querySelector('.local-stt-corrections-modal__save-status')?.textContent,
    ).toBe('Unsaved changes');
    expect(mutateSettings).not.toHaveBeenCalled();
  });

  it('serializes correction mutations against the latest settings snapshot', async () => {
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      autoCopyFinalizedUtterances: true,
    };
    let firstWrite = true;
    const mutateSettings = vi.fn(
      async (mutation: (current: typeof settings) => typeof settings) => {
        if (firstWrite) {
          firstWrite = false;
          settings = { ...settings, autoCopyFinalizedUtterances: false };
        }
        settings = mutation(settings);
      },
    );
    const modal = new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      mutateSettings,
    });
    modal.open();
    await Setting.buttonNamed('Add rule').click();

    const row = Setting.named('1. Find');
    row.textComponents[0]?.change('cat');
    row.textComponents[1]?.change('dog');
    row.textComponents[1]?.change('hound');

    await vi.waitFor(() => expect(mutateSettings).toHaveBeenCalledTimes(2));
    expect(settings.autoCopyFinalizedUtterances).toBe(false);
    expect(settings.personalCorrectionRules[0]?.replace).toBe('hound');
  });

  it('keeps a rejected draft dirty and exposes failed then saved state', async () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      personalCorrectionRules: [{ enabled: true, find: 'cat', id: 'rule-1', replace: 'dog' }],
    };
    let rejectNext = true;
    const mutateSettings = vi.fn(async () => {
      if (rejectNext) {
        rejectNext = false;
        throw new Error('disk full');
      }
    });
    const modal = new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      mutateSettings,
    });
    modal.open();

    Setting.named('1. cat').textComponents[0]?.change('kitten');
    await vi.waitFor(() =>
      expect(
        modal.contentEl.querySelector('.local-stt-corrections-modal__save-status')?.textContent,
      ).toBe('Save failed. Retry saving.'),
    );
    expect(settings.personalCorrectionRules[0]?.find).toBe('cat');

    Setting.named('1. kitten').textComponents[0]?.change('cat');
    await vi.waitFor(() =>
      expect(
        modal.contentEl.querySelector('.local-stt-corrections-modal__save-status')?.textContent,
      ).toBe('Saved'),
    );
    expect(mutateSettings).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale save completion overwrite a newer draft', async () => {
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      personalCorrectionRules: [{ enabled: true, find: 'cat', id: 'rule-1', replace: 'dog' }],
    };
    let releaseFirstSave: (() => void) | undefined;
    let mutationCount = 0;
    const mutateSettings = vi.fn(
      async (mutation: (current: typeof settings) => typeof settings) => {
        mutationCount += 1;
        if (mutationCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSave = () => {
              settings = mutation(settings);
              resolve();
            };
          });
          return;
        }
        settings = mutation(settings);
      },
    );
    const modal = new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      mutateSettings,
    });
    modal.open();

    const row = Setting.named('1. cat');
    row.textComponents[1]?.change('hound');
    row.textComponents[1]?.change('fox');
    await vi.waitFor(() => expect(releaseFirstSave).toBeDefined());
    releaseFirstSave?.();
    await vi.waitFor(() => expect(mutateSettings).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(settings.personalCorrectionRules[0]?.replace).toBe('fox'));
    expect(
      modal.contentEl.querySelector('.local-stt-corrections-modal__save-status')?.textContent,
    ).toBe('Saved');
  });

  it('rejects a same-key external change instead of overwriting it', async () => {
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      personalCorrectionRules: [{ enabled: true, find: 'cat', id: 'rule-1', replace: 'dog' }],
    };
    const externalRule = { enabled: true, find: 'external', id: 'external', replace: 'value' };
    const mutateSettings = vi.fn(
      async (mutation: (current: typeof settings) => typeof settings) => {
        settings = { ...settings, personalCorrectionRules: [externalRule] };
        mutation(settings);
      },
    );
    const modal = new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      mutateSettings,
    });
    modal.open();

    Setting.named('1. cat').textComponents[0]?.change('kitten');
    await vi.waitFor(() =>
      expect(
        modal.contentEl.querySelector('.local-stt-corrections-modal__save-status')?.textContent,
      ).toBe('Correction rules changed elsewhere. Reopen this dialog before saving.'),
    );
    expect(settings.personalCorrectionRules).toEqual([externalRule]);
  });

  it('renders an invalid persisted row as repairable draft input', async () => {
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      personalCorrectionRuleDiagnostics: [
        {
          code: 'blank_id' as const,
          field: 'id' as const,
          index: 0,
          message: 'Each rule needs an ID.',
          raw: { enabled: true, find: 'old', replace: 'new' },
        },
      ],
    };
    const mutateSettings = vi.fn(async (mutation: (current: PluginSettings) => PluginSettings) => {
      settings = mutation(settings);
    });
    new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      mutateSettings,
    }).open();

    const row = Setting.named('1. old');
    row.textComponents[0]?.change('repaired');
    await vi.waitFor(() => expect(settings.personalCorrectionRules).toHaveLength(1));
    expect(settings.personalCorrectionRules[0]).toMatchObject({ id: 'repaired' });
    expect(settings.personalCorrectionRuleDiagnostics).toEqual([]);
  });

  it('validates, previews, and persists a rule while preserving newer settings', async () => {
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      autoCopyFinalizedUtterances: true,
    };
    const mutateSettings = vi.fn(
      async (mutation: (current: typeof settings) => typeof settings) => {
        settings = mutation(settings);
      },
    );
    new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      mutateSettings,
    }).open();

    const previewTextArea = Setting.instances[0]?.textAreaComponents[0];
    previewTextArea?.change('cat and cat');
    await Setting.buttonNamed('Add rule').click();

    const row = Setting.named('1. Find');
    row.textComponents[0]?.change('cat');
    row.textComponents[1]?.change('dog');
    const updatedRow = Setting.named('1. cat');
    updatedRow.toggleComponents[0]?.change(false);
    expect(updatedRow.descEl.textContent).toContain('Off');
    expect(Setting.named('0 enabled · 1 rule')).toBeDefined();
    await vi.waitFor(() => {
      expect(mutateSettings).toHaveBeenCalledWith(expect.any(Function));
    });
    expect(settings.personalCorrectionRules[0]?.replace).toBe('dog');
  });
});
