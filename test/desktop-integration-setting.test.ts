import type { App } from 'obsidian';
import { Modal, Platform } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DesktopIntegrationSettingsModal,
  formatDesktopShortcut,
  renderDesktopIntegrationSetting,
} from '../src/settings/desktop-integration-setting';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { type Modal as MockModal, Setting, TestElement } from './__mocks__/obsidian';

beforeEach(() => {
  Setting.reset();
  Object.assign(Platform, { isMacOS: true, isWin: false, isLinux: false });
});
afterEach(() => Object.assign(Platform, { isMacOS: false, isWin: false, isLinux: true }));

function harness() {
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    desktopControlsEnabled: true,
    globalDictationShortcut: 'Control+Alt+J',
  };
  let listener = () => {};
  let status = 'Control+Alt+J';
  const unsubscribe = vi.fn();
  const deps = {
    access: {
      getSettings: () => settings,
      persistOne: vi.fn(
        async <K extends keyof PluginSettings>(key: K, value: PluginSettings[K]) => {
          settings = { ...settings, [key]: value };
        },
      ),
    },
    getStatus: () => status,
    subscribeStatus: vi.fn((callback: () => void) => {
      listener = callback;
      return unsubscribe;
    }),
    retry: vi.fn(async () => {}),
    onError: vi.fn(),
  };
  return {
    deps,
    unsubscribe,
    settings: () => settings,
    status: (value: string) => {
      status = value;
      listener();
    },
  };
}

describe('desktop integration settings', () => {
  it('keeps Capture to one toggle and a gear, with the shortcut visible', async () => {
    const h = harness();
    const restore = vi.fn();
    renderDesktopIntegrationSetting(new TestElement() as unknown as HTMLElement, {} as App, {
      ...h.deps,
      onDialogOpened: () => restore,
    });
    expect(Setting.instances).toHaveLength(1);
    const row = Setting.named('Desktop integration');
    expect(row.descEl.textContent).toContain('⌃⌥J');
    expect(row.toggleComponents).toHaveLength(1);
    expect(row.extraButtonComponents[0]?.tooltip).toBe('Desktop integration settings');
    await row.extraButtonComponents[0]?.click();
    const modal = (Modal as unknown as typeof MockModal).instances.at(-1);
    expect(modal?.titleEl.textContent).toBe('Desktop integration');
    modal?.close();
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
  });

  it('uses Mac copy and keeps detailed explanations in tooltips', () => {
    const h = harness();
    new DesktopIntegrationSettingsModal({} as App, h.deps).open();
    expect(Setting.named('Show in menu bar').onlyToggle()).toBeDefined();
    const copy = Setting.instances
      .map((row) =>
        [
          row.name,
          row.descEl.textContent,
          ...row.extraButtonComponents.map((button) => button.tooltip),
        ].join(' '),
      )
      .join(' ');
    expect(copy).not.toMatch(/GNOME|Wayland|system tray|Windows/);
    expect(Setting.named('Global shortcut').extraButtonComponents[0]?.tooltip).toContain(
      'Control+Alt+J',
    );
  });

  it('updates status without replacing the shortcut field and unsubscribes on close', () => {
    const h = harness();
    const modal = new DesktopIntegrationSettingsModal({} as App, h.deps);
    modal.open();
    const shortcut = Setting.named('Global shortcut').onlyText();
    shortcut.change('Control+Shift+K');
    h.status('Shortcut already in use');
    expect(Setting.named('Global shortcut').onlyText()).toBe(shortcut);
    expect(shortcut.getValue()).toBe('Control+Shift+K');
    expect(Setting.named('Status').descEl.textContent).toBe('Shortcut already in use');
    modal.close();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it('saves an unfinished shortcut on close and leaves the master switch off', async () => {
    const h = harness();
    await h.deps.access.persistOne('desktopControlsEnabled', false);
    const modal = new DesktopIntegrationSettingsModal({} as App, h.deps);
    modal.open();
    Setting.named('Global shortcut').onlyText().change(' Control+Alt+K ');
    modal.close();
    await vi.waitFor(() => expect(h.settings().globalDictationShortcut).toBe('Control+Alt+K'));
    expect(h.settings().desktopControlsEnabled).toBe(false);
    expect(h.deps.retry).not.toHaveBeenCalled();
  });

  it('waits for a blurred shortcut save before refreshing the parent on close', async () => {
    const h = harness();
    let finish!: () => void;
    const original = h.deps.access.persistOne.getMockImplementation();
    h.deps.access.persistOne.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await original?.(key, value);
    });
    const onClosed = vi.fn();
    const modal = new DesktopIntegrationSettingsModal({} as App, { ...h.deps, onClosed });
    modal.open();
    const input = Setting.named('Global shortcut').onlyText();
    input.change('Control+Alt+K');
    input.inputEl.dispatchEvent({ type: 'blur' });
    await vi.waitFor(() => expect(finish).toBeDefined());
    modal.close();
    await Promise.resolve();
    expect(onClosed).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
    expect(h.settings().globalDictationShortcut).toBe('Control+Alt+K');
  });

  it('keeps Retry from registering the old shortcut after a save failure', async () => {
    const h = harness();
    new DesktopIntegrationSettingsModal({} as App, h.deps).open();
    Setting.named('Global shortcut').onlyText().change('Control+Alt+K');
    h.deps.access.persistOne.mockRejectedValueOnce(new Error('save failed'));
    await Setting.buttonNamed('Retry').click();
    expect(h.deps.onError).toHaveBeenCalledOnce();
    expect(h.deps.retry).not.toHaveBeenCalled();
  });

  it('does not overwrite a concurrent shortcut change when the draft was untouched', async () => {
    const h = harness();
    const onClosed = vi.fn();
    const modal = new DesktopIntegrationSettingsModal({} as App, { ...h.deps, onClosed });
    modal.open();
    await h.deps.access.persistOne('globalDictationShortcut', 'Control+Alt+K');
    modal.close();
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledOnce());
    expect(h.settings().globalDictationShortcut).toBe('Control+Alt+K');
    expect(h.deps.access.persistOne).toHaveBeenCalledOnce();
  });

  it('formats shortcuts for display without changing their stored syntax', () => {
    expect(formatDesktopShortcut('Control+Alt+J', 'macos')).toBe('⌃⌥J');
    expect(formatDesktopShortcut('CommandOrControl+Shift+KeyK', 'macos')).toBe('⇧⌘K');
    expect(formatDesktopShortcut('Control+Alt+J', 'windows')).toBe('Ctrl+Alt+J');
  });
});
