import { describe, expect, it } from 'vitest';

import { needsPluginSettingsMigration } from '../src/settings/schema-migration';

describe('YouTube settings migration', () => {
  it('detects missing YouTube fields on an otherwise current schema', () => {
    expect(
      needsPluginSettingsMigration({
        mediaLlmProcessing: true,
        schemaVersion: 10,
      }),
    ).toBe(true);
  });

  it('does not request migration when all YouTube fields are present', () => {
    expect(
      needsPluginSettingsMigration({
        mediaLlmProcessing: true,
        schemaVersion: 10,
        youtubeHelperPath: '',
        youtubeMediaSourceEnabled: false,
        youtubePolicyVersion: null,
      }),
    ).toBe(false);
  });
});
