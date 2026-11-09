import { describe, expect, it, vi } from 'vitest';

import { SettingsTabLifecycle } from '../src/settings/settings-tab-lifecycle';
import { TestElement } from './__mocks__/obsidian';

describe('SettingsTabLifecycle', () => {
  it('does not restore dialog focus after settings hides or another control takes focus', () => {
    const container = new TestElement();
    Object.defineProperty(container, 'isConnected', { value: true });
    const controls = addSettingRow(container, 'Models', 1);
    const lifecycle = new SettingsTabLifecycle({
      containerEl: container as unknown as HTMLElement,
      display: () => {},
    });
    lifecycle.markVisible();
    const returnFocus = lifecycle.focusAfterDialog({ settingName: 'Models', controlIndex: 0 });
    const other = new TestElement(container.ownerDocument, 'button');
    other.focus();
    returnFocus();
    expect(container.ownerDocument.activeElement).toBe(other);
    lifecycle.markHidden();
    lifecycle.markVisible();
    container.ownerDocument.activeElement = null;
    returnFocus();
    expect(container.ownerDocument.activeElement).toBeNull();
    expect(controls[0]).toBeDefined();
  });
  it('uses display on legacy hosts and preserves focused control identity', () => {
    const container = new TestElement();
    const originalControls = addSettingRow(container, 'Listening mode', 2);
    originalControls[1]?.focus();
    const display = vi.fn(() => {
      container.empty();
      addSettingRow(container, 'Listening mode', 2);
    });
    const lifecycle = new SettingsTabLifecycle({
      containerEl: container as unknown as HTMLElement,
      display,
    });

    lifecycle.markVisible();
    lifecycle.refresh();

    expect(display).toHaveBeenCalledOnce();
    const refreshedControls = container.querySelectorAll('button');
    expect(container.ownerDocument.activeElement).toBe(refreshedControls[1]);
  });

  it('uses update on current hosts without also calling display', () => {
    const container = new TestElement();
    const display = vi.fn();
    const update = vi.fn();
    const lifecycle = new SettingsTabLifecycle({
      containerEl: container as unknown as HTMLElement,
      display,
      update,
    });

    lifecycle.markVisible();
    lifecycle.refresh();

    expect(update).toHaveBeenCalledOnce();
    expect(display).not.toHaveBeenCalled();
  });

  it('ignores a late refresh after the settings tab is hidden', () => {
    const display = vi.fn();
    const update = vi.fn();
    const lifecycle = new SettingsTabLifecycle({
      containerEl: new TestElement() as unknown as HTMLElement,
      display,
      update,
    });

    lifecycle.markVisible();
    lifecycle.markHidden();
    lifecycle.refresh();

    expect(update).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
  });
});

function addSettingRow(container: TestElement, name: string, controlCount: number): TestElement[] {
  const row = container.createDiv({ cls: 'setting-item' });
  row.createDiv({ cls: 'setting-item-name', text: name });
  const controls = row.createDiv({ cls: 'setting-item-control' });
  return Array.from({ length: controlCount }, () => controls.createEl('button'));
}
