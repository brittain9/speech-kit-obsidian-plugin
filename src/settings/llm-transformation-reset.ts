import {
  DEFAULT_LLM_ACTIVE_PRESET_REF,
  type PluginSettings,
  resetLlmPostprocessDefaults,
} from './plugin-settings';
import type { SettingsMutation } from './settings-mutation';

interface LlmTransformationResetDependencies {
  mutateSettings: (mutation: SettingsMutation) => Promise<void>;
}

export async function restoreLlmTransformationDefaults(
  dependencies: LlmTransformationResetDependencies,
): Promise<void> {
  await dependencies.mutateSettings((settings: Readonly<PluginSettings>) => ({
    ...resetLlmPostprocessDefaults(settings),
    llmPostprocessActivePresetRef: DEFAULT_LLM_ACTIVE_PRESET_REF,
  }));
}
