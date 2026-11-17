import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLlmBuiltinPreset, type LlmPresetEntry } from '../src/llm/presets';
import { DEFAULT_PLUGIN_SETTINGS, resolvePluginSettings } from '../src/settings/plugin-settings';
import { PresetManagerModal } from '../src/ui/preset-manager-modal';
import type { PresetSearchHit } from '../src/ui/preset-search';
import { Setting, TestElement } from './__mocks__/obsidian';

describe('PresetManagerModal row interaction', () => {
  beforeEach(() => {
    Setting.reset();
    vi.stubGlobal('createFragment', () => new TestElement());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens and saves the requested preset directly without changing its identity or timing', async () => {
    let settings = resolvePluginSettings(undefined);
    const original = settings.llmPostprocessUserPresets.find(
      (preset) => preset.id === 'default:summary',
    );
    if (original === undefined) throw new Error('Missing default Summary preset.');
    const modal = new PresetManagerModal({} as never, {
      initialPresetRef: 'user:default:summary',
      feedback: { show: vi.fn() },
      getSettings: () => settings,
      mutatePresetState: async (mutate) => {
        const next = mutate({
          activePresetRef: settings.llmPostprocessActivePresetRef,
          userPresets: settings.llmPostprocessUserPresets,
        });
        settings = {
          ...settings,
          llmPostprocessActivePresetRef: next.activePresetRef,
          llmPostprocessUserPresets: next.userPresets,
        };
      },
    });
    modal.open();
    expect(Setting.named('Name').onlyText().inputEl.value).toBe('Summary');
    expect(Setting.named('Timing').onlyDropdown().selectEl.value).toBe('batch');
    expect(Setting.named('Timing').onlyDropdown().selectEl.disabled).toBe(false);
    Setting.named('Timing').onlyDropdown().change('per_utterance');
    Setting.named('Output').onlyDropdown().change('add_above');
    expect(Setting.named('Timing').descEl.textContent).toContain(
      'Add above or below runs when dictation stops',
    );
    expect(Setting.named('Timing').onlyDropdown().selectEl.value).toBe('batch');
    expect(Setting.named('Timing').onlyDropdown().selectEl.disabled).toBe(true);
    Setting.named('Output').onlyDropdown().change(original.output);
    expect(Setting.named('Timing').onlyDropdown().selectEl.disabled).toBe(false);
    Setting.named('Timing')
      .onlyDropdown()
      .change(original.timing ?? 'either');
    Setting.named('Name').onlyText().change('My summary');
    await Setting.buttonNamed('Save').click();
    await vi.waitFor(() =>
      expect(
        settings.llmPostprocessUserPresets.find((preset) => preset.id === original.id)?.label,
      ).toBe('My summary'),
    );
    const saved = settings.llmPostprocessUserPresets.find((preset) => preset.id === original.id);
    expect(saved?.timing).toBe(original.timing);
    expect(saved?.output).toBe(original.output);
    modal.close();
  });

  it('returns to the list with accurate feedback when the requested preset was removed', () => {
    const show = vi.fn();
    const mutatePresetState = vi.fn(async () => {});
    const modal = new PresetManagerModal({} as never, {
      initialPresetRef: 'user:removed',
      feedback: { show },
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      mutatePresetState,
    });
    modal.open();
    expect(Setting.named('Presets')).toBeDefined();
    expect(Setting.instances.some((setting) => setting.name === 'Name')).toBe(false);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' }));
    expect(mutatePresetState).not.toHaveBeenCalled();
    modal.close();
  });

  it('uses the information area as the explicit mouse target', async () => {
    const { entry, openEntry, row } = renderPresetRow();

    expect(row.infoEl.tabIndex).toBe(0);
    expect(row.infoEl.getAttribute('role')).toBe('button');
    expect(row.infoEl.getAttribute('aria-label')).toBe('Edit preset: Summary');

    await row.settingEl.click();
    expect(openEntry).not.toHaveBeenCalled();

    await row.infoEl.click();
    expect(openEntry).toHaveBeenCalledWith(entry);
  });

  it.each(['Enter', ' '])('opens a preset with the %j key', (key) => {
    const { entry, openEntry, row } = renderPresetRow();
    const preventDefault = vi.fn();

    row.infoEl.dispatchEvent({ key, preventDefault, type: 'keydown' });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openEntry).toHaveBeenCalledWith(entry);
  });
});

function renderPresetRow(): {
  entry: LlmPresetEntry;
  openEntry: ReturnType<typeof vi.fn>;
  row: Setting;
} {
  const entry: LlmPresetEntry = {
    isBuiltin: true,
    preset: getLlmBuiltinPreset('summary'),
    ref: 'user:default:summary',
  };
  const hit: PresetSearchHit = {
    description: entry.preset.description ?? '',
    descriptionMatches: null,
    entry,
    labelMatches: null,
  };
  const openEntry = vi.fn();
  const modal = Object.create(PresetManagerModal.prototype) as {
    deps: { getSettings: () => typeof DEFAULT_PLUGIN_SETTINGS };
    openEntry: (entry: LlmPresetEntry) => void;
    renderListSection(
      listEl: HTMLElement,
      heading: string,
      hits: PresetSearchHit[],
      activeRef: string,
    ): void;
  };
  modal.deps = { getSettings: () => DEFAULT_PLUGIN_SETTINGS };
  modal.openEntry = openEntry;
  modal.renderListSection(
    new TestElement() as unknown as HTMLElement,
    'Built-in',
    [hit],
    'builtin:not-active',
  );

  return { entry, openEntry, row: Setting.named('Summary') };
}
