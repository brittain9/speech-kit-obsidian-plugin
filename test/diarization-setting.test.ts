import { describe, expect, it, vi } from 'vitest';

import {
  diarizationSettingDescription,
  renderDiarizationSetting,
} from '../src/settings/diarization-setting';

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { Setting as MockSetting, TestElement } from './__mocks__/obsidian';

describe('diarizationSettingDescription', () => {
  it('shows a saved speaker preference as inactive on streaming and restores it for batch', async () => {
    MockSetting.reset();
    let streaming = true;
    let update = () => {};
    const save = vi.fn(async () => {});
    const choose = vi.fn();
    const configure = vi.fn();
    const dispose = vi.fn();
    const unsubscribe = renderDiarizationSetting(new TestElement() as unknown as HTMLElement, {
      getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, diarizationEnabled: true }),
      saveEnabled: save,
      streamingModelSelected: () => streaming,
      subscribe: (listener) => {
        update = listener;
        return dispose;
      },
      chooseModel: choose,
      configure,
    });
    const row = MockSetting.named('Speaker labels');
    expect(row.onlyToggle().value).toBe(false);
    expect(row.onlyToggle().toggleEl.disabled).toBe(true);
    expect(row.descEl.textContent).toContain('Not active');
    await row.buttonComponents[0]?.click();
    expect(choose).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    row.onlyToggle().change(true);
    expect(save).not.toHaveBeenCalled();
    await row.extraButtonComponents[0]?.click();
    expect(configure).not.toHaveBeenCalled();
    streaming = false;
    update();
    expect(row.onlyToggle().value).toBe(true);
    expect(row.onlyToggle().toggleEl.disabled).toBe(false);
    await row.extraButtonComponents[0]?.click();
    expect(configure).toHaveBeenCalledOnce();
    expect(row.buttonComponents[0]?.buttonEl.style.display).toBe('none');
    row.onlyToggle().change(false);
    expect(save).toHaveBeenCalledWith(false);
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shows the speaker-label limitation only for a streaming model', () => {
    const limitation = 'streaming model';

    expect(diarizationSettingDescription(true)).toContain(limitation);
    expect(diarizationSettingDescription(false)).not.toContain(limitation);
    expect(diarizationSettingDescription(false)).toContain('Labels are estimates');
  });
});
