import { describe, expect, it } from 'vitest';
import {
  createDefaultPresets,
  isDefaultPreset,
  listPresetEntries,
  resolvePresetEntry,
} from '../src/llm/presets';
import { resolveLlmPostprocessMode } from '../src/llm/transform-policy';
import {
  DEFAULT_PLUGIN_SETTINGS,
  LLM_USER_PRESET_MAX_COUNT,
  resetLlmPostprocessDefaults,
  resolvePluginSettings,
} from '../src/settings/plugin-settings';
import { applyPresetDraftSave, draftFromPreset } from '../src/ui/preset-draft';
import { createUserPreset } from './fixtures/llm';

describe('editable starting presets', () => {
  it('seeds once, preserves legacy custom presets, and migrates the selected builtin ref', () => {
    const custom = createUserPreset({ id: 'mine', label: 'Summary' });
    const first = resolvePluginSettings({
      llmPostprocessUserPresets: [custom],
      llmPostprocessActivePresetRef: 'builtin:tldr',
    });
    expect(first.llmPostprocessUserPresets.filter(isDefaultPreset)).toHaveLength(23);
    expect(first.llmPostprocessUserPresets).toContainEqual(custom);
    expect(first.llmPostprocessActivePresetRef).toBe('user:default:tldr');
    expect(resolvePluginSettings(JSON.parse(JSON.stringify(first)))).toEqual(first);
  });

  it('persists a shipped preset edit and deletion without resurrecting defaults on reload', () => {
    const first = resolvePluginSettings(undefined);
    const summary = first.llmPostprocessUserPresets.find(
      (preset) => preset.id === 'default:summary',
    );
    if (!summary) throw new Error('Missing Summary');
    const state = {
      activePresetRef: first.llmPostprocessActivePresetRef,
      userPresets: first.llmPostprocessUserPresets,
    };
    const saved = applyPresetDraftSave(
      state,
      {
        ...draftFromPreset(summary),
        label: 'My summary',
        prompt: 'My instructions.',
        output: 'add_below',
        temperature: '0.7',
      },
      summary.id,
    );
    expect(saved.error).toBeNull();
    const reloaded = resolvePluginSettings({
      ...first,
      llmPostprocessUserPresets: saved.state.userPresets.filter(
        (preset) => preset.id !== 'default:tldr',
      ),
    });
    expect(
      reloaded.llmPostprocessUserPresets.find((preset) => preset.id === summary.id),
    ).toMatchObject({
      label: 'My summary',
      prompt: 'My instructions.',
      output: 'add_below',
      overrides: { temperature: 0.7 },
    });
    expect(resolvePresetEntry('builtin:tldr', reloaded.llmPostprocessUserPresets)).toBeNull();
    expect(listPresetEntries(reloaded.llmPostprocessUserPresets)).toHaveLength(22);
  });

  it('allows deletion of every preset and leaves no hidden AI transform after reload', () => {
    const empty = resolvePluginSettings({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmPostprocessMode: 'batch',
      llmPostprocessUserPresets: [],
    });
    expect(empty.llmPostprocessUserPresets).toEqual([]);
    expect(empty.llmPostprocessActivePresetRef).toBe('');
    expect(empty.llmPostprocessMode).toBe('off');
    expect(resolveLlmPostprocessMode(empty, createDefaultPresets()[0]!)).toBe('off');
    expect(resolvePluginSettings(empty).llmPostprocessUserPresets).toEqual([]);
  });

  it('restores changed and deleted defaults while preserving custom IDs, prompts, and colliding labels', () => {
    const custom = createUserPreset({
      id: 'mine',
      label: 'Summary',
      prompt: 'Keep this exact prompt.',
    });
    const edited = {
      ...createDefaultPresets()[0]!,
      label: 'Renamed starting preset',
      prompt: 'Modified default.',
    };
    const restored = resetLlmPostprocessDefaults({
      ...DEFAULT_PLUGIN_SETTINGS,
      llmPostprocessUserPresets: [custom, edited],
    });
    expect(restored.llmPostprocessUserPresets).toEqual([...createDefaultPresets(), custom]);
    expect(resetLlmPostprocessDefaults(restored).llmPostprocessUserPresets).toEqual(
      restored.llmPostprocessUserPresets,
    );
  });

  it('keeps custom presets editable when their existing name matches a newly seeded preset', () => {
    const custom = createUserPreset({ id: 'mine', label: 'Summary' });
    const presets = [...createDefaultPresets(), custom];
    const saved = applyPresetDraftSave(
      { activePresetRef: 'user:mine', userPresets: presets },
      { ...draftFromPreset(custom), prompt: 'Revised custom prompt.' },
      custom.id,
    );
    expect(saved.error).toBeNull();
    expect(saved.state.activePresetRef).toBe('user:mine');
    expect(saved.state.userPresets.at(-1)?.prompt).toBe('Revised custom prompt.');
  });

  it('restores starting presets without consuming or truncating the custom preset allowance', () => {
    const customs = Array.from({ length: LLM_USER_PRESET_MAX_COUNT }, (_, index) =>
      createUserPreset({ id: `custom-${index}` }),
    );
    const restored = resolvePluginSettings(
      resetLlmPostprocessDefaults({
        ...DEFAULT_PLUGIN_SETTINGS,
        llmPostprocessUserPresets: customs,
      }),
    );
    expect(restored.llmPostprocessUserPresets.filter((preset) => !isDefaultPreset(preset))).toEqual(
      customs,
    );
    expect(restored.llmPostprocessUserPresets.filter(isDefaultPreset)).toHaveLength(23);
  });
});
