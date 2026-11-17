import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import {
  diarizationSettingDescription,
  renderDiarizationSetting,
} from '../src/settings/diarization-setting';

import { DiarizationSettingsModal } from '../src/settings/diarization-settings-modal';
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
    expect(configure).toHaveBeenCalledOnce();
    streaming = false;
    update();
    expect(row.onlyToggle().value).toBe(true);
    expect(row.onlyToggle().toggleEl.disabled).toBe(false);
    await row.extraButtonComponents[0]?.click();
    expect(configure).toHaveBeenCalledTimes(2);
    expect(row.buttonComponents[0]?.buttonEl.style.display).toBe('none');
    row.onlyToggle().change(false);
    expect(save).toHaveBeenCalledWith(false);
    unsubscribe();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('opens streaming speaker settings from the gear, preserves preferences and offers the batch picker', async () => {
    MockSetting.reset();
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      diarizationEnabled: true,
      diarizationMaxSpeakers: 3,
    };
    const save = vi.fn(async () => {});
    const chooseModel = vi.fn();
    const modal = new DiarizationSettingsModal({} as App, {
      getSettings: () => settings,
      savePatch: save,
      streamingModelSelected: () => true,
      chooseModel,
    });
    const close = vi.spyOn(modal, 'close');
    const unsubscribe = renderDiarizationSetting(new TestElement() as unknown as HTMLElement, {
      getSettings: () => settings,
      saveEnabled: save,
      streamingModelSelected: () => true,
      subscribe: () => () => {},
      chooseModel,
      configure: () => modal.open(),
    });
    await MockSetting.named('Speaker labels').extraButtonComponents[0]?.click();
    expect(modal.titleEl.textContent).toBe('Speaker label settings');
    const content = modal.contentEl as unknown as TestElement;
    expect(
      content.findByText(
        'Not active with this streaming model. Choose a batch model to use speaker labels; your preference is kept.',
      ),
    ).toBeDefined();
    const limit = MockSetting.named('Maximum speakers').onlyDropdown();
    expect(limit.selectEl.value).toBe('3');
    expect(limit.selectEl.disabled).toBe(true);
    limit.change('4');
    const reset = MockSetting.buttonNamed('Reset');
    expect(reset.disabled).toBe(true);
    await reset.click();
    const picker = MockSetting.instances
      .filter((setting) => content.contains(setting.settingEl))
      .flatMap((setting) => setting.buttonComponents)
      .find((button) => button.text === 'Choose batch model');
    expect(picker).toBeDefined();
    await picker?.click();
    expect(close).toHaveBeenCalledOnce();
    expect(chooseModel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(settings).toMatchObject({ diarizationEnabled: true, diarizationMaxSpeakers: 3 });
    unsubscribe();
  });

  it('shows the speaker-label limitation only for a streaming model', () => {
    const limitation = 'streaming model';

    expect(diarizationSettingDescription(true)).toContain(limitation);
    expect(diarizationSettingDescription(false)).not.toContain(limitation);
    expect(diarizationSettingDescription(false)).toContain('Labels are estimates');
  });
});
