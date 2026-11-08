import { isRecord } from '../shared/type-guards';

export function needsPluginSettingsMigration(data: unknown): boolean {
  if (data === null || data === undefined) return false;
  if (!isRecord(data) || data.schemaVersion !== 11) return true;
  return !Object.hasOwn(data, 'mediaLlmProcessing');
}
