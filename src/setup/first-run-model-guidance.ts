import {
  catalogModelSupportsLanguage,
  type DictationLanguage,
} from '../language/dictation-language';
import type { ModelManagerState } from '../models/model-install-manager';
import { type CatalogModelRecord, getTotalModelSize } from '../models/model-management-types';

export type FirstRunHardwareClass = 'constrained' | 'standard' | 'unknown';

export interface FirstRunHardwareProfile {
  hardwareClass: FirstRunHardwareClass;
  logicalProcessorCount: number | null;
  memoryGb: number | null;
}

export type StartingModelReason = 'automatic' | 'liveEnglish' | 'multilingual' | 'finalOnly';

export interface StartingModelRecommendation {
  hardwareClass: FirstRunHardwareClass;
  liveChoiceIsOnly: boolean;
  mode: 'final' | 'live';
  model: CatalogModelRecord;
  reason: StartingModelReason;
  resourceClass: 'demanding' | 'standard';
  supportedLanguages: string[];
  totalSizeBytes: number;
}

interface NavigatorHardwareHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
}

export function readFirstRunHardwareProfile(
  navigator: NavigatorHardwareHints | undefined = window.navigator,
): FirstRunHardwareProfile {
  const logicalProcessorCount = positiveIntegerOrNull(navigator?.hardwareConcurrency);
  const memoryGb = positiveNumberOrNull(navigator?.deviceMemory);
  const constrained =
    (logicalProcessorCount !== null && logicalProcessorCount <= 4) ||
    (memoryGb !== null && memoryGb <= 4);
  const processorKnown = logicalProcessorCount !== null;
  const memoryKnown = memoryGb !== null;

  return {
    hardwareClass: constrained
      ? 'constrained'
      : !processorKnown && !memoryKnown
        ? 'unknown'
        : 'standard',
    logicalProcessorCount,
    memoryGb,
  };
}

export function resolveStartingModelRecommendation(
  state: Pick<ModelManagerState, 'catalog' | 'compiledAdapters'>,
  language: DictationLanguage,
  hardware: FirstRunHardwareProfile,
): StartingModelRecommendation | null {
  const candidates = state.catalog.models.flatMap((model) => {
    if (model.task !== 'stt' || !catalogModelSupportsLanguage(model, language)) {
      return [];
    }
    const adapter = state.compiledAdapters.find(
      (candidate) =>
        candidate.runtimeId === model.runtimeId && candidate.familyId === model.familyId,
    );
    return adapter === undefined ? [] : [{ adapter, model }];
  });
  if (candidates.length === 0) return null;

  const liveCandidates = candidates.filter(
    ({ adapter }) => adapter.familyCapabilities.supportsStreaming,
  );
  const mode: 'final' | 'live' = liveCandidates.length > 0 ? 'live' : 'final';
  const modeCandidates = mode === 'live' ? liveCandidates : candidates;
  const preferredFamily = language === 'en' ? 'moonshine' : null;
  const preferredCandidates = preferredFamily
    ? modeCandidates.filter(({ model }) => model.familyId === preferredFamily)
    : modeCandidates;
  const candidatePool = preferredCandidates.length > 0 ? preferredCandidates : modeCandidates;
  const model =
    hardware.hardwareClass === 'constrained'
      ? smallestModel(candidatePool)
      : balancedOrSmallestModel(candidatePool);

  return {
    hardwareClass: hardware.hardwareClass,
    liveChoiceIsOnly: mode === 'live' && liveCandidates.length === 1,
    mode,
    model,
    reason:
      mode === 'final'
        ? 'finalOnly'
        : language === 'auto'
          ? 'automatic'
          : language === 'en'
            ? 'liveEnglish'
            : 'multilingual',
    resourceClass:
      hardware.hardwareClass === 'constrained' && !model.uxTags.includes('lightweight')
        ? 'demanding'
        : 'standard',
    supportedLanguages: [...model.languageTags],
    totalSizeBytes: getTotalModelSize(model),
  };
}

function balancedOrSmallestModel(
  candidates: readonly { model: CatalogModelRecord }[],
): CatalogModelRecord {
  const balanced = candidates.find(({ model }) => model.uxTags.includes('balanced'));
  return balanced?.model ?? smallestModel(candidates);
}

function smallestModel(candidates: readonly { model: CatalogModelRecord }[]): CatalogModelRecord {
  const smallest = candidates.reduce((current, candidate) =>
    getTotalModelSize(candidate.model) < getTotalModelSize(current.model) ? candidate : current,
  );
  return smallest.model;
}

function positiveIntegerOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveNumberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
