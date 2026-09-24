import type { PluginSettings } from '../settings/plugin-settings';
import { formatLlmProviderName, getProviderModel, type LlmProviderId } from './provider';
import type { LlmRouter } from './router';
import { activeLlmProviderIds } from './routing-policy';

export interface MediaLlmDisclosure {
  readonly dataEgress: 'local_only' | 'network';
  readonly model: string;
  readonly providerId: LlmProviderId;
  readonly providerLabel: string;
  readonly text: string;
}

export function describeMediaLlmConfiguration(settings: PluginSettings): string {
  const providers = activeLlmProviderIds(settings.llmRoutingPolicy).map((providerId) => {
    const model = getProviderModel(settings.llmProviderConfigurations, providerId);
    const label = formatLlmProviderName(providerId);
    return providerId === 'ollama'
      ? `${label} (${model}) — local device only`
      : `${label} (${model}) — transcript text leaves this device`;
  });
  return providers.length === 0
    ? 'No AI provider is selected. Configure a provider before enabling media AI.'
    : `Configured media AI provider: ${providers.join('; ')}.`;
}

export function resolveMediaLlmDisclosure(
  settings: PluginSettings,
  router: LlmRouter,
  transcriptChars: number,
): MediaLlmDisclosure {
  const providerId = router.selectProviderId(transcriptChars);
  const model = getProviderModel(settings.llmProviderConfigurations, providerId);
  const providerLabel = formatLlmProviderName(providerId);
  const dataEgress = providerId === 'ollama' ? 'local_only' : 'network';
  const text =
    dataEgress === 'local_only'
      ? `Media AI runs locally with ${providerLabel} (${model}). Transcript text stays on this device.`
      : `Media AI sends transcript text and bounded note context to ${providerLabel} (${model}) over the network.`;
  return { dataEgress, model, providerId, providerLabel, text };
}
