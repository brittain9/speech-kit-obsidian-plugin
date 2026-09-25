import type { DictationLanguage } from '../language/dictation-language';
import { languageSupportIncludes } from '../language/dictation-language';
import { resolveEngineCapabilities } from '../models/capability-view';
import type { ModelManagerState } from '../models/model-install-manager';
import type { EngineCapabilitiesRecord, SelectedModel } from '../models/model-management-types';
import { selectedModelEquals } from '../models/model-management-types';
import type { TimestampDensity, TranscriptFormattingMode } from '../settings/plugin-settings';

export interface MediaTranscriptionModelOption {
  readonly capabilities: EngineCapabilitiesRecord;
  readonly label: string;
  readonly selection: SelectedModel;
}

export interface MediaTranscriptionJobOptions {
  readonly diarizationEnabled: boolean;
  readonly language: DictationLanguage;
  readonly modelSelection: SelectedModel;
  readonly timestampDensity: TimestampDensity;
  readonly timestampsEnabled: boolean;
  readonly transcriptFormatting: TranscriptFormattingMode;
}

export type MediaTranscriptionModelOptions = (
  language: DictationLanguage,
) => readonly MediaTranscriptionModelOption[];

export function getMediaTranscriptionModelOptions(
  state: ModelManagerState,
  language: DictationLanguage,
): MediaTranscriptionModelOption[] {
  const options: MediaTranscriptionModelOption[] = [];
  for (const installed of state.installedModels) {
    const capabilities = resolveEngineCapabilities(
      state.compiledRuntimes,
      state.compiledAdapters,
      installed.runtimeId,
      installed.familyId,
    );
    if (!isCompatibleBatchModel(capabilities, language)) continue;
    const selection: SelectedModel = {
      familyId: installed.familyId,
      kind: 'catalog_model',
      modelId: installed.modelId,
      runtimeId: installed.runtimeId,
    };
    const model = state.catalog.models.find((candidate) =>
      selectedModelEquals(selection, {
        familyId: candidate.familyId,
        kind: 'catalog_model',
        modelId: candidate.modelId,
        runtimeId: candidate.runtimeId,
      }),
    );
    options.push({
      capabilities,
      label: model?.displayName ?? installed.modelId,
      selection,
    });
  }

  const selected = state.selectedModelCapabilities;
  if (
    selected.status === 'ready' &&
    selected.selection.kind === 'external_file' &&
    isCompatibleBatchModel(selected.capabilities, language) &&
    !options.some((option) => selectedModelEquals(option.selection, selected.selection))
  ) {
    options.push({
      capabilities: selected.capabilities,
      label: selected.selection.filePath.split(/[\\/]/u).at(-1) ?? 'External model',
      selection: selected.selection,
    });
  }

  return options;
}

export function chooseDefaultMediaTranscriptionModel(
  options: readonly MediaTranscriptionModelOption[],
  selectedModel: SelectedModel | null,
): MediaTranscriptionModelOption | null {
  if (selectedModel !== null) {
    const selected = options.find((option) => selectedModelEquals(option.selection, selectedModel));
    if (selected !== undefined) return selected;
  }
  return options.find((option) => option.selection.familyId === 'whisper') ?? options[0] ?? null;
}

function isCompatibleBatchModel(
  capabilities: EngineCapabilitiesRecord | null,
  language: DictationLanguage,
): capabilities is EngineCapabilitiesRecord {
  return (
    capabilities !== null &&
    capabilities.family.task === 'stt' &&
    !capabilities.family.supportsStreaming &&
    languageSupportIncludes(
      capabilities.family.supportedLanguages,
      language,
      capabilities.family.supportsAutomaticLanguageDetection,
    )
  );
}
