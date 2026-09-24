import { isRecord } from '../shared/type-guards';

export function needsPluginSettingsMigration(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (!isRecord(data) || data.schemaVersion !== 10) return true;
  return (
    !Object.hasOwn(data, 'mediaLlmProcessing') ||
    !Object.hasOwn(data, 'youtubeHelperPath') ||
    !Object.hasOwn(data, 'youtubeMediaSourceEnabled') ||
    !Object.hasOwn(data, 'youtubePolicyVersion')
  );
}
