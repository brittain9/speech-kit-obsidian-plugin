import type { PluginSettings } from '../settings/plugin-settings';
import {
  type LlmPostprocessMode,
  type LlmPresetOutput,
  resolveActivePresetEntry,
  resolveEffectiveLlmGlobals,
} from './presets';

export interface LlmTransformSnapshot {
  readonly noteContextChars: number;
  readonly output: LlmPresetOutput;
  readonly priorUtterancesN: number;
  readonly prompt: string;
  readonly showRawBelow: boolean;
  readonly skipMinWords: number;
  readonly temperature: number;
  readonly totalContextCap: number;
  readonly useNoteContext: boolean;
}

export function resolveLlmTransformSnapshot(settings: PluginSettings): LlmTransformSnapshot {
  const activePreset = resolveActivePresetEntry(
    settings.llmPostprocessActivePresetRef,
    settings.llmPostprocessUserPresets,
  ).preset;
  const effective = resolveEffectiveLlmGlobals(
    {
      minWords: settings.llmPostprocessSkipMinWords,
      temperature: settings.llmPostprocessTemperature,
      useNoteContext: settings.useLlmNoteContext,
    },
    activePreset,
  );
  return {
    noteContextChars: effective.useNoteContext ? settings.llmPostprocessNoteContextChars : 0,
    output: activePreset.output,
    priorUtterancesN: settings.llmPostprocessPriorUtterancesN,
    prompt: activePreset.prompt,
    showRawBelow: settings.llmPostprocessShowRawBelow,
    skipMinWords: effective.minWords,
    temperature: effective.temperature,
    totalContextCap: settings.llmPostprocessTotalContextCap,
    useNoteContext: effective.useNoteContext,
  };
}

export function resolveLlmPostprocessMode(
  settings: PluginSettings,
  activePreset: ReturnType<typeof resolveActivePresetEntry>['preset'],
): LlmPostprocessMode {
  return settings.llmPostprocessMode === 'off'
    ? 'off'
    : (activePreset.timing ?? settings.llmPostprocessMode);
}

export type LlmOutputBehavior =
  | { readonly kind: 'replace' }
  | { readonly kind: 'add'; readonly placement: 'above' | 'below' };

export function resolveLlmOutputBehavior(output: LlmPresetOutput): LlmOutputBehavior {
  return output === 'replace'
    ? { kind: 'replace' }
    : { kind: 'add', placement: output === 'add_above' ? 'above' : 'below' };
}

export function renderBatchProviderUserMessage(
  noteContext: string | null,
  transcriptText: string,
): string {
  const sections: string[] = [];
  if (noteContext !== null && noteContext.trim().length > 0) {
    sections.push(`<note_context>\n${noteContext.trim()}\n</note_context>`);
  }
  sections.push(`<session_transcript>\n${transcriptText.trim()}\n</session_transcript>`);
  return sections.join('\n\n');
}
