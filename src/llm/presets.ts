import { t } from '../shared/i18n';

export const LLM_POSTPROCESS_MODES = ['off', 'per_utterance', 'batch'] as const;

export type LlmPostprocessMode = (typeof LLM_POSTPROCESS_MODES)[number];

export function isLlmPostprocessMode(value: unknown): value is LlmPostprocessMode {
  return typeof value === 'string' && (LLM_POSTPROCESS_MODES as readonly string[]).includes(value);
}

export type LlmPresetTiming = Exclude<LlmPostprocessMode, 'off'>;

export function isLlmPresetTiming(value: unknown): value is LlmPresetTiming {
  return value === 'per_utterance' || value === 'batch';
}

export const LLM_PRESET_OUTPUTS = ['replace', 'add_above', 'add_below'] as const;

export type LlmPresetOutput = (typeof LLM_PRESET_OUTPUTS)[number];

export function isLlmPresetOutput(value: unknown): value is LlmPresetOutput {
  return typeof value === 'string' && (LLM_PRESET_OUTPUTS as readonly string[]).includes(value);
}

export interface LlmPresetOverrides {
  minWords?: number;
  temperature?: number;
  useNoteContext?: boolean;
}

export interface LlmPreset {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  // undefined = either; presets with add_* output are always 'batch'.
  timing?: LlmPresetTiming;
  output: LlmPresetOutput;
  overrides?: LlmPresetOverrides;
}

export type LlmBuiltinPresetId =
  | 'tldr'
  | 'markdown-formatting'
  | 'summary'
  | 'key-takeaways'
  | 'explain-simply'
  | 'outline'
  | 'study-notes'
  | 'meeting-notes'
  | 'claims-and-evidence'
  | 'timeline'
  | 'story-version'
  | 'podcast-show-notes'
  | 'one-page-briefing'
  | 'explain-with-analogies'
  | 'youtube-notes'
  | 'comedy-recap';

export interface LlmPresetEntry {
  isBuiltin: boolean;
  preset: LlmPreset;
  ref: string;
}

const TLDR_PROMPT = t('llm.preset.builtin.tldr.prompt');

const MARKDOWN_FORMATTING_PROMPT = t('llm.preset.builtin.markdownFormatting.prompt');

export const LLM_BUILTIN_PRESETS = [
  {
    id: 'summary',
    label: t('llm.preset.builtin.summary.label'),
    description: t('llm.preset.builtin.summary.description'),
    output: 'replace',
    prompt: t('llm.preset.builtin.summary.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'tldr',
    label: t('llm.preset.builtin.tldr.label'),
    description: t('llm.preset.builtin.tldr.description'),
    output: 'add_above',
    prompt: TLDR_PROMPT,
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'key-takeaways',
    label: t('llm.preset.builtin.keyTakeaways.label'),
    description: t('llm.preset.builtin.keyTakeaways.description'),
    output: 'replace',
    prompt: t('llm.preset.builtin.keyTakeaways.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'explain-simply',
    label: t('llm.preset.builtin.explainSimply.label'),
    description: t('llm.preset.builtin.explainSimply.description'),
    output: 'replace',
    prompt: t('llm.preset.builtin.explainSimply.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'outline',
    label: t('llm.preset.builtin.outline.label'),
    description: t('llm.preset.builtin.outline.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.outline.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'youtube-notes',
    label: t('llm.preset.builtin.youtubeNotes.label'),
    description: t('llm.preset.builtin.youtubeNotes.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.youtubeNotes.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'podcast-show-notes',
    label: t('llm.preset.builtin.podcastShowNotes.label'),
    description: t('llm.preset.builtin.podcastShowNotes.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.podcastShowNotes.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'study-notes',
    label: t('llm.preset.builtin.studyNotes.label'),
    description: t('llm.preset.builtin.studyNotes.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.studyNotes.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'meeting-notes',
    label: t('llm.preset.builtin.meetingNotes.label'),
    description: t('llm.preset.builtin.meetingNotes.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.meetingNotes.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },

  {
    id: 'claims-and-evidence',
    label: t('llm.preset.builtin.claimsAndEvidence.label'),
    description: t('llm.preset.builtin.claimsAndEvidence.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.claimsAndEvidence.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },

  {
    id: 'timeline',
    label: t('llm.preset.builtin.timeline.label'),
    description: t('llm.preset.builtin.timeline.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.timeline.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'story-version',
    label: t('llm.preset.builtin.storyVersion.label'),
    description: t('llm.preset.builtin.storyVersion.description'),
    output: 'replace',
    prompt: t('llm.preset.builtin.storyVersion.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.4, useNoteContext: false },
  },

  {
    id: 'one-page-briefing',
    label: t('llm.preset.builtin.onePageBriefing.label'),
    description: t('llm.preset.builtin.onePageBriefing.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.onePageBriefing.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'explain-with-analogies',
    label: t('llm.preset.builtin.explainWithAnalogies.label'),
    description: t('llm.preset.builtin.explainWithAnalogies.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.explainWithAnalogies.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.4, useNoteContext: false },
  },
  {
    id: 'comedy-recap',
    label: t('llm.preset.builtin.comedyRecap.label'),
    description: t('llm.preset.builtin.comedyRecap.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.comedyRecap.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.5, useNoteContext: false },
  },
  {
    id: 'markdown-formatting',
    label: t('llm.preset.builtin.markdownFormatting.label'),
    description: t('llm.preset.builtin.markdownFormatting.description'),
    output: 'replace',
    prompt: MARKDOWN_FORMATTING_PROMPT,
    timing: 'batch',
  },
] as const satisfies readonly (LlmPreset & { id: LlmBuiltinPresetId })[];

// Retained only to recognize untouched copies from the initial preset rollout.
const RETIRED_STARTING_PRESETS: readonly LlmPreset[] = [
  {
    id: 'flashcards',
    label: t('llm.preset.builtin.flashcards.label'),
    description: t('llm.preset.builtin.flashcards.description'),
    output: 'add_below',
    prompt: t('llm.preset.builtin.flashcards.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'cheat-sheet',
    label: t('llm.preset.builtin.cheatSheet.label'),
    description: t('llm.preset.builtin.cheatSheet.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.cheatSheet.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'step-by-step-guide',
    label: t('llm.preset.builtin.stepByStepGuide.label'),
    description: t('llm.preset.builtin.stepByStepGuide.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.stepByStepGuide.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'faq',
    label: t('llm.preset.builtin.faq.label'),
    description: t('llm.preset.builtin.faq.description'),
    output: 'add_above',
    prompt: t('llm.preset.builtin.faq.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'social-post',
    label: t('llm.preset.builtin.socialPost.label'),
    description: t('llm.preset.builtin.socialPost.description'),
    output: 'add_below',
    prompt: t('llm.preset.builtin.socialPost.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.4, useNoteContext: false },
  },
  {
    id: 'memorable-quotes',
    label: t('llm.preset.builtin.memorableQuotes.label'),
    description: t('llm.preset.builtin.memorableQuotes.description'),
    output: 'add_below',
    prompt: t('llm.preset.builtin.memorableQuotes.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.2, useNoteContext: false },
  },
  {
    id: 'ideas-to-try',
    label: t('llm.preset.builtin.ideasToTry.label'),
    description: t('llm.preset.builtin.ideasToTry.description'),
    output: 'add_below',
    prompt: t('llm.preset.builtin.ideasToTry.prompt'),
    timing: 'batch',
    overrides: { minWords: 0, temperature: 0.4, useNoteContext: false },
  },
];

export const DEFAULT_LLM_BUILTIN_PRESET_ID: LlmBuiltinPresetId = 'summary';

export function getLlmBuiltinPreset(id: LlmBuiltinPresetId): LlmPreset {
  const preset = LLM_BUILTIN_PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`Unknown LLM built-in preset id: ${id}`);
  }
  return preset;
}

export type LlmStyleRef =
  | { kind: 'builtin'; id: LlmBuiltinPresetId }
  | { kind: 'user'; id: string };

const BUILTIN_REF_PREFIX = 'builtin:';
const USER_REF_PREFIX = 'user:';

export function formatStyleRef(ref: LlmStyleRef): string {
  if (ref.kind === 'builtin') {
    return `${BUILTIN_REF_PREFIX}${ref.id}`;
  }
  return `${USER_REF_PREFIX}${ref.id}`;
}

export function parseStyleRef(value: unknown): LlmStyleRef | null {
  if (typeof value !== 'string') {
    return null;
  }

  if (value.startsWith(BUILTIN_REF_PREFIX)) {
    const id = value.slice(BUILTIN_REF_PREFIX.length);
    if (LLM_BUILTIN_PRESETS.some((entry) => entry.id === id)) {
      return { kind: 'builtin', id: id as LlmBuiltinPresetId };
    }
    return null;
  }

  if (value.startsWith(USER_REF_PREFIX)) {
    const id = value.slice(USER_REF_PREFIX.length);
    if (id.length === 0) {
      return null;
    }
    return { kind: 'user', id };
  }

  return null;
}

export function createDefaultPresets(): LlmPreset[] {
  return LLM_BUILTIN_PRESETS.map((preset: LlmPreset) => ({
    ...preset,
    id: `default:${preset.id}`,
    ...(preset.overrides !== undefined ? { overrides: { ...preset.overrides } } : {}),
  }));
}

export function isDefaultPreset(preset: LlmPreset): boolean {
  return LLM_BUILTIN_PRESETS.some((entry) => preset.id === `default:${entry.id}`);
}

function samePresetSettings(saved: LlmPreset, template: LlmPreset): boolean {
  return (
    saved.label === template.label &&
    saved.description === template.description &&
    saved.prompt === template.prompt &&
    saved.output === template.output &&
    saved.timing === template.timing &&
    saved.overrides?.minWords === template.overrides?.minWords &&
    saved.overrides?.temperature === template.overrides?.temperature &&
    saved.overrides?.useNoteContext === template.overrides?.useNoteContext
  );
}

function normalizedPresetLabel(preset: LlmPreset): string {
  return preset.label.trim().toLocaleLowerCase();
}

export function reconcileStartingPresets(presets: readonly LlmPreset[]): LlmPreset[] {
  return presets.filter((preset) => {
    const template = [...LLM_BUILTIN_PRESETS, ...RETIRED_STARTING_PRESETS].find(
      (entry) => preset.id === `default:${entry.id}`,
    );
    // Edited copies remain user-owned, even when their starting template retires.
    if (!template || !samePresetSettings(preset, template)) return true;
    if (RETIRED_STARTING_PRESETS.includes(template)) return false;
    return !presets.some(
      (other) =>
        other.id !== preset.id &&
        !other.id.startsWith('default:') &&
        normalizedPresetLabel(other) === normalizedPresetLabel(preset),
    );
  });
}

export function restoreDefaultPresets(presets: readonly LlmPreset[]): LlmPreset[] {
  return reconcileStartingPresets([
    ...createDefaultPresets(),
    ...presets.filter((preset) => !isDefaultPreset(preset)),
  ]);
}

export function listPresetEntries(presets: readonly LlmPreset[]): LlmPresetEntry[] {
  return presets.map((preset) => ({
    isBuiltin: isDefaultPreset(preset),
    preset,
    ref: formatStyleRef({ kind: 'user', id: preset.id }),
  }));
}

export function resolvePresetEntry(
  ref: string | null,
  presets: readonly LlmPreset[],
): LlmPresetEntry | null {
  const parsed = parseStyleRef(ref);
  if (parsed === null) return null;
  // Old builtin refs point to the saved, editable copy during migration.
  const id = parsed.kind === 'builtin' ? `default:${parsed.id}` : parsed.id;
  return listPresetEntries(presets).find((entry) => entry.preset.id === id) ?? null;
}

export function resolveActivePresetEntry(
  ref: string | null,
  presets: readonly LlmPreset[],
): LlmPresetEntry {
  return (
    resolvePresetEntry(ref, presets) ??
    resolvePresetEntry(`user:default:${DEFAULT_LLM_BUILTIN_PRESET_ID}`, presets) ??
    listPresetEntries(presets).find(
      (entry) =>
        normalizedPresetLabel(entry.preset) ===
        normalizedPresetLabel(getLlmBuiltinPreset(DEFAULT_LLM_BUILTIN_PRESET_ID)),
    ) ??
    listPresetEntries(presets)[0] ?? {
      isBuiltin: false,
      preset: {
        id: '',
        label: t('llm.preset.none'),
        output: 'replace',
        prompt: '',
        timing: 'batch',
      },
      ref: '',
    }
  );
}

export interface LlmTransformGlobals {
  minWords: number;
  temperature: number;
  useNoteContext: boolean;
}

// The extension point for future per-preset overrides: add an optional field
// to LlmPresetOverrides and resolve it here; absent fields inherit globals.
export function resolveEffectiveLlmGlobals(
  globals: LlmTransformGlobals,
  preset: LlmPreset,
): LlmTransformGlobals {
  return {
    minWords: preset.overrides?.minWords ?? globals.minWords,
    temperature: preset.overrides?.temperature ?? globals.temperature,
    useNoteContext: preset.overrides?.useNoteContext ?? globals.useNoteContext,
  };
}

export function describePresetTiming(timing: LlmPresetTiming | undefined): string {
  if (timing === 'per_utterance') {
    return t('llm.preset.timing.perUtterance');
  }
  if (timing === 'batch') {
    return t('llm.preset.timing.batch');
  }
  return t('llm.preset.timing.either');
}

export function describePresetBehavior(preset: LlmPreset): string {
  const output =
    preset.output === 'add_above'
      ? t('llm.preset.behavior.addAbove')
      : preset.output === 'add_below'
        ? t('llm.preset.behavior.addBelow')
        : t('llm.preset.behavior.replace');
  const overridden: string[] = [];
  if (preset.overrides?.minWords !== undefined) {
    overridden.push(t('llm.preset.override.minimumWords'));
  }
  if (preset.overrides?.temperature !== undefined) {
    overridden.push(t('llm.preset.override.temperature'));
  }
  if (preset.overrides?.useNoteContext !== undefined) {
    overridden.push(t('llm.preset.override.noteContext'));
  }
  const parts = [describePresetTiming(preset.timing), output];
  if (overridden.length > 0) {
    parts.push(t('llm.preset.behavior.overrides', { fields: overridden.join(', ') }));
  }
  return parts.join(' · ');
}
