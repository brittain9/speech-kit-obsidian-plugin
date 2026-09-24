import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PersonalCorrectionRulesModal } from '../src/settings/personal-correction-rules-modal';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { Setting } from './__mocks__/obsidian';

describe('PersonalCorrectionRulesModal', () => {
  beforeEach(() => Setting.reset());

  it('does not persist or preview an invalid blank draft', async () => {
    const saveSettings = vi.fn(async () => {});
    new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      saveSettings,
    }).open();

    await Setting.buttonNamed('Add rule').click();

    const previewTextAreas = Setting.instances.flatMap((setting) => setting.textAreaComponents);
    expect(previewTextAreas.at(-2)?.inputEl.value).toBe('The café AI system is ready.');
    expect(previewTextAreas.at(-1)?.inputEl.value).toBe('');
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('validates, previews, and persists a rule while preserving newer settings', async () => {
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      autoCopyFinalizedUtterances: true,
    };
    const saveSettings = vi.fn(async (next: typeof settings) => {
      settings = next;
    });
    new PersonalCorrectionRulesModal({} as never, {
      getSettings: () => settings,
      saveSettings,
    }).open();

    const previewTextArea = Setting.instances[0]?.textAreaComponents[0];
    previewTextArea?.change('cat and cat');
    await Setting.buttonNamed('Add rule').click();

    const row = Setting.named('1. Find');
    row.textComponents[0]?.change('cat');
    row.textComponents[1]?.change('dog');
    await vi.waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          autoCopyFinalizedUtterances: true,
          personalCorrectionRules: [
            expect.objectContaining({ enabled: true, find: 'cat', replace: 'dog' }),
          ],
        }),
      );
    });
    expect(settings.personalCorrectionRules[0]?.replace).toBe('dog');
  });
});
