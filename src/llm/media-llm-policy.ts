import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import { formatLlmProviderName, getProviderModel, type LlmProviderId } from './provider';
import type { LlmRouter } from './router';
import { activeLlmProviderIds } from './routing-policy';
import { resolveLlmTransformSnapshot } from './transform-policy';

export type MediaLlmDataEgress = 'local' | 'network' | 'unknown';
export type MediaLlmPayload = 'transcript_only' | 'transcript_and_bounded_note_context';

export interface MediaLlmDisclosure {
  readonly dataEgress: MediaLlmDataEgress;
  readonly model: string;
  readonly payload: MediaLlmPayload;
  readonly providerId: LlmProviderId;
}

export function resolveMediaLlmConfigurationDisclosures(
  settings: PluginSettings,
): MediaLlmDisclosure[] {
  const useNoteContext = resolveLlmTransformSnapshot(settings).useNoteContext;
  return activeLlmProviderIds(settings.llmRoutingPolicy).map((providerId) =>
    createDisclosure(settings, providerId, useNoteContext),
  );
}

export function describeMediaLlmConfiguration(settings: PluginSettings): string {
  const disclosures = resolveMediaLlmConfigurationDisclosures(settings);
  return disclosures.length === 0
    ? t('llm.mediaDisclosure.none')
    : disclosures.map((disclosure) => formatMediaLlmDisclosure(disclosure)).join(' ');
}

export function resolveMediaLlmDisclosure(
  settings: PluginSettings,
  router: LlmRouter,
  transcriptChars: number,
  useNoteContext: boolean,
): MediaLlmDisclosure {
  return createDisclosure(settings, router.selectProviderId(transcriptChars), useNoteContext);
}

export function formatMediaLlmDisclosure(disclosure: MediaLlmDisclosure): string {
  const provider = formatLlmProviderName(disclosure.providerId);
  if (disclosure.dataEgress === 'local') {
    return t('llm.mediaDisclosure.local', {
      model: disclosure.model,
      payload: formatMediaLlmPayload(disclosure.payload),
      provider,
    });
  }
  if (disclosure.dataEgress === 'network') {
    return t('llm.mediaDisclosure.network', {
      model: disclosure.model,
      payload: formatMediaLlmPayload(disclosure.payload),
      provider,
    });
  }
  return t('llm.mediaDisclosure.unknown', {
    model: disclosure.model,
    payload: formatMediaLlmPayload(disclosure.payload),
    provider,
  });
}

export function formatMediaLlmPayload(payload: MediaLlmPayload): string {
  return t(
    payload === 'transcript_only'
      ? 'llm.mediaPayload.transcriptOnly'
      : 'llm.mediaPayload.transcriptAndBoundedNoteContext',
  );
}

function createDisclosure(
  settings: PluginSettings,
  providerId: LlmProviderId,
  useNoteContext: boolean,
): MediaLlmDisclosure {
  return {
    dataEgress: resolveDataEgress(settings, providerId),
    model: getProviderModel(settings.llmProviderConfigurations, providerId),
    payload: useNoteContext ? 'transcript_and_bounded_note_context' : 'transcript_only',
    providerId,
  };
}

function resolveDataEgress(
  settings: PluginSettings,
  providerId: LlmProviderId,
): MediaLlmDataEgress {
  if (providerId === 'ollama') return 'local';
  if (providerId === 'openrouter') return 'network';

  try {
    const hostname = new URL(settings.llmProviderConfigurations.openai_compatible.baseUrl).hostname
      .toLowerCase()
      .replace(/^\[|\]$/gu, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
      ? 'local'
      : 'network';
  } catch {
    return 'unknown';
  }
}
