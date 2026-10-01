import { describe, expect, it } from 'vitest';

import {
  createDefaultPresets,
  describePresetBehavior,
  getLlmBuiltinPreset,
  LLM_BUILTIN_PRESETS,
  listPresetEntries,
  resolveActivePresetEntry,
  resolveEffectiveLlmGlobals,
  resolvePresetEntry,
} from '../src/llm/presets';
import { createUserPreset } from './fixtures/llm';

const GLOBALS = { minWords: 4, temperature: 0.2, useNoteContext: false };

describe('LLM presets', () => {
  it('ships the approved built-in lineup', () => {
    expect(LLM_BUILTIN_PRESETS.map((preset) => preset.id)).toEqual([
      'summary',
      'tldr',
      'key-takeaways',
      'explain-simply',
      'outline',
      'youtube-notes',
      'podcast-show-notes',
      'study-notes',
      'meeting-notes',
      'claims-and-evidence',
      'timeline',
      'story-version',
      'one-page-briefing',
      'explain-with-analogies',
      'comedy-recap',
      'markdown-formatting',
    ]);
  });

  it('forbids implicit translation in every built-in transform', () => {
    for (const preset of LLM_BUILTIN_PRESETS) {
      expect(preset.prompt).toContain('original language');
      expect(preset.prompt).toContain('Never translate');
    }
  });

  it('all shipped presets initially process the full transcript on completion', () => {
    expect(LLM_BUILTIN_PRESETS.every((preset) => preset.timing === 'batch')).toBe(true);
  });

  it('listPresetEntries returns built-ins then user presets with refs', () => {
    const entries = listPresetEntries([...createDefaultPresets(), createUserPreset({ id: 'abc' })]);
    expect(entries[0]).toMatchObject({ isBuiltin: true, ref: 'user:default:summary' });
    expect(entries.at(-1)).toMatchObject({ isBuiltin: false, ref: 'user:abc' });
  });

  it('resolvePresetEntry returns null for unknown refs (including removed built-ins)', () => {
    expect(resolvePresetEntry('builtin:voice-commands', [])).toBeNull();
    expect(resolvePresetEntry('builtin:brain-dump', [])).toBeNull();
    expect(resolvePresetEntry('user:missing', [])).toBeNull();
    expect(resolvePresetEntry(null, [])).toBeNull();
  });

  it('resolveActivePresetEntry falls back to an available saved preset', () => {
    expect(resolveActivePresetEntry('builtin:voice-commands', createDefaultPresets()).ref).toBe(
      'user:default:summary',
    );
    expect(resolveActivePresetEntry('user:abc', [createUserPreset({ id: 'abc' })]).ref).toBe(
      'user:abc',
    );
  });

  it('resolveEffectiveLlmGlobals applies per-field overrides', () => {
    const preset = createUserPreset({
      overrides: { temperature: 0.9, useNoteContext: true },
    });
    expect(resolveEffectiveLlmGlobals(GLOBALS, preset)).toEqual({
      minWords: 4,
      temperature: 0.9,
      useNoteContext: true,
    });
    expect(resolveEffectiveLlmGlobals(GLOBALS, createUserPreset())).toEqual(GLOBALS);
  });

  it('describePresetBehavior summarizes timing, output, and overrides', () => {
    expect(describePresetBehavior(getLlmBuiltinPreset('tldr'))).toBe(
      'Runs once on stop · adds new content above the transcript · overrides min words, temperature, note context',
    );
    expect(
      describePresetBehavior(createUserPreset({ overrides: { minWords: 0, temperature: 1 } })),
    ).toBe('Runs in either mode · rewrites the dictated text · overrides min words, temperature');
  });
});
