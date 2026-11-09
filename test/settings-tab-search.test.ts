import type { App } from 'obsidian';
import { Setting, type SettingDefinitionRender, type SettingGroup } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { DiarizationSettingsModal } from '../src/settings/diarization-settings-modal';
import { LlmPresetStateStore } from '../src/settings/llm-preset-state';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { createSettingAccess } from '../src/settings/setting-helpers';
import {
  LocalSttSettingTab,
  renderAutomaticCopyFinalizedUtterancesSetting,
  renderNotePinningSetting,
  renderReadAloudHighlightSetting,
} from '../src/settings/settings-tab';
import { type Setting as MockSetting, TestElement } from './__mocks__/obsidian';

describe('LocalSttSettingTab Obsidian 1.13 compatibility', () => {
  it('provides a microphone icon when registered in Settings', () => {
    const tab = new LocalSttSettingTab({} as never, {} as never, {} as never);
    expect(tab.icon).toBe('mic');
  });
  it('opts the composite settings UI out of declarative row rendering', () => {
    const tab = Object.create(LocalSttSettingTab.prototype) as LocalSttSettingTab;

    expect(tab.getSettingDefinitions()).toEqual([]);
  });

  it('models Obsidian suppressing display when a declarative definition is returned', () => {
    const container = new TestElement();
    const display = vi.fn();
    const definitions: SettingDefinitionRender[] = [
      {
        name: 'Speech Kit',
        render: (setting) => {
          setting.setName('Speech Kit');
        },
      },
    ];

    reconcileObsidian13Settings(container, definitions, display);

    expect(display).not.toHaveBeenCalled();
    expect(container.findByText('Speech Kit')).toBeDefined();
  });

  it('keeps the composite settings visible after Obsidian reconciles declarative rows', () => {
    const tab = Object.create(LocalSttSettingTab.prototype) as LocalSttSettingTab;
    const container = new TestElement();
    const renderSettings = vi.fn((host: TestElement) => {
      host.createDiv({ text: 'Microphone' });
    });
    Object.defineProperty(tab, 'renderSettings', { value: renderSettings });
    Object.defineProperty(tab, 'display', {
      value: () => renderSettings(container),
    });

    reconcileObsidian13Settings(container, tab.getSettingDefinitions(), () => {
      tab.display();
    });

    expect(container.findByText('Microphone')).toBeDefined();
  });

  it('preserves a queued provider change when an unrelated setting is toggled', async () => {
    let current: PluginSettings = { ...DEFAULT_PLUGIN_SETTINGS };
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const store = new LlmPresetStateStore({
      getSettings: () => current,
      loadData: async () => current,
      commit: async (next) => {
        if (next.llmNetworkTimeoutSec === 42 && current.llmNetworkTimeoutSec !== 42) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        current = next;
      },
      onExternalChange: vi.fn(),
      warn: vi.fn(),
    });
    const llmSave = store.mutateSettings((settings) => ({ ...settings, llmNetworkTimeoutSec: 42 }));
    await waiting;
    const access = createSettingAccess(() => current, store);
    const setting = renderAutomaticCopyFinalizedUtterancesSetting(
      new TestElement() as unknown as HTMLElement,
      access,
    ) as unknown as MockSetting;
    setting.onlyToggle().change(true);
    release();
    await llmSave;
    await vi.waitFor(() => expect(current.autoCopyFinalizedUtterances).toBe(true));
    expect(current.llmNetworkTimeoutSec).toBe(42);
  });

  it('preserves a queued provider change when an unrelated settings modal saves', async () => {
    let current: PluginSettings = { ...DEFAULT_PLUGIN_SETTINGS, diarizationEnabled: true };
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const store = new LlmPresetStateStore({
      getSettings: () => current,
      loadData: async () => current,
      commit: async (next) => {
        if (next.llmNetworkTimeoutSec === 42 && current.llmNetworkTimeoutSec !== 42) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        current = next;
      },
      onExternalChange: vi.fn(),
      warn: vi.fn(),
    });
    const llmSave = store.mutateSettings((settings) => ({ ...settings, llmNetworkTimeoutSec: 42 }));
    await waiting;
    const modal = new DiarizationSettingsModal({} as App, {
      getSettings: () => current,
      savePatch: (patch) => store.mutateSettings((settings) => ({ ...settings, ...patch })),
    });
    modal.open();
    (Setting as unknown as typeof import('./__mocks__/obsidian').Setting)
      .named('Maximum speakers')
      .onlyDropdown()
      .change('2');
    await Promise.resolve();
    release();
    await llmSave;
    await vi.waitFor(() => expect(current.diarizationMaxSpeakers).toBe(2));
    expect(current.llmNetworkTimeoutSec).toBe(42);
  });

  it('renders a default-off automatic-copy toggle with explicit clipboard replacement copy', async () => {
    const persistOne = vi.fn(async () => {});
    const setting = renderAutomaticCopyFinalizedUtterancesSetting(
      new TestElement() as unknown as HTMLElement,
      {
        getSettings: () => DEFAULT_PLUGIN_SETTINGS,
        persistOne,
      },
    ) as unknown as MockSetting;

    expect(setting.name).toBe('Automatically copy finalized utterances');
    expect(setting.descEl.textContent).toBe('Each finalized phrase replaces the system clipboard.');
    expect(setting.onlyToggle().value).toBe(false);

    setting.onlyToggle().change(true);

    await vi.waitFor(() => {
      expect(persistOne).toHaveBeenCalledWith('autoCopyFinalizedUtterances', true);
    });
  });

  it('explains temporary note pinning and lets the user disable it', async () => {
    const persistOne = vi.fn(async () => {});
    const setting = renderNotePinningSetting(new TestElement() as unknown as HTMLElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      persistOne,
    }) as unknown as MockSetting;

    expect(setting.name).toBe('Temporarily pin the target note');
    expect(setting.descEl.textContent).toContain('next dictation or file transcription');
    expect(setting.descEl.textContent).toContain('stops dictation');
    expect(setting.onlyToggle().value).toBe(true);
    setting.onlyToggle().change(false);
    await vi.waitFor(() => {
      expect(persistOne).toHaveBeenCalledWith('pinNoteDuringTranscription', false);
    });
  });

  it('renders the enabled read-aloud highlight toggle and persists live changes', async () => {
    const persistOne = vi.fn(async () => {});
    const setting = renderReadAloudHighlightSetting(new TestElement() as unknown as HTMLElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      persistOne,
    }) as unknown as MockSetting;

    expect(setting.name).toBe('Highlight spoken text');
    expect(setting.descEl.textContent).toBe(
      'Highlight the current spoken block in the editor while Read Aloud is playing.',
    );
    expect(setting.onlyToggle().value).toBe(true);

    setting.onlyToggle().change(false);
    await vi.waitFor(() => {
      expect(persistOne).toHaveBeenCalledWith('highlightSpokenText', false);
    });
  });
});

function reconcileObsidian13Settings(
  container: TestElement,
  definitions: readonly SettingDefinitionRender[],
  display: () => void,
): void {
  if (definitions.length === 0) {
    display();
    return;
  }

  const rows = definitions.map((definition) => {
    const setting = new Setting(container as unknown as HTMLElement);
    setting.setName(definition.name);
    definition.render(setting, {} as SettingGroup);
    return setting.settingEl as unknown as TestElement;
  });

  // Obsidian 1.13.4 reasserts ownership of each framework-created row.
  container.setChildrenInPlace(rows);
}
