import type { PluginSettings } from '../settings/plugin-settings';

export function llmSettingsFingerprint(settings: PluginSettings): string {
  return JSON.stringify({
    activePresetRef: settings.llmPostprocessActivePresetRef,
    featuresEnabled: settings.llmFeaturesEnabled,
    mediaProcessing: settings.mediaLlmProcessing,
    noteContextChars: settings.llmPostprocessNoteContextChars,
    postprocessMode: settings.llmPostprocessMode,
    priorUtterancesN: settings.llmPostprocessPriorUtterancesN,
    providerConfigurations: settings.llmProviderConfigurations,
    routingPolicy: settings.llmRoutingPolicy,
    showRawBelow: settings.llmPostprocessShowRawBelow,
    skipMinWords: settings.llmPostprocessSkipMinWords,
    temperature: settings.llmPostprocessTemperature,
    totalContextCap: settings.llmPostprocessTotalContextCap,
    userPresets: settings.llmPostprocessUserPresets,
    useNoteContext: settings.useLlmNoteContext,
  });
}
