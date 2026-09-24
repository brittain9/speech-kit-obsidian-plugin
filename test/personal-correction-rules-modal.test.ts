import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PersonalCorrectionRulesModal } from '../src/settings/personal-correction-rules-modal';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
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
      ).toBe('Not saved. Fix the rules and try again.'),
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
