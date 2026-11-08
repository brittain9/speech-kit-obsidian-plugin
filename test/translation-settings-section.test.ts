import { describe, expect, it, vi } from 'vitest';

import type { ModelInstallManager, ModelManagerState } from '../src/models/model-install-manager';
import type { CatalogModelRecord } from '../src/models/model-management-types';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import {
  renderTranslationModelSetting,
  renderTranslationSettings,
} from '../src/settings/translation-settings-section';
import { Setting, TestElement } from './__mocks__/obsidian';

function state(installed: boolean): ModelManagerState {
  const model: CatalogModelRecord = {
    artifacts: [
      {
        artifactId: 'runtime',
        downloadUrl: 'https://example.com/runtime',
        filename: 'bergamot-translator.wasm',
        required: true,
        role: 'supporting_file',
        sha256: 'a'.repeat(64),
        sizeBytes: 551_598_146,
      },
    ],
    collectionId: 'translation',
    displayName: 'Firefox Translations',
    familyId: 'firefox_translations',
    languageTags: ['en', 'es', 'de', 'fr', 'pt', 'it', 'nl', 'ja'],
    licenseLabel: 'MPL-2.0',
    licenseUrl: 'https://www.mozilla.org/MPL/2.0/',
    modelCardUrl: null,
    modelId: 'firefox_translations_release_2026_07',
    notes: [],
    runtimeId: 'bergamot_wasm',
    sourceUrl: 'https://github.com/mozilla/firefox-translations-models',
    summary: 'Fast local translation',
    supportsAutomaticLanguageDetection: false,
    task: 'translation',
    translationSupport: { kind: 'pairs', pairs: [{ source: 'en', target: 'es' }] },
    uxTags: [],
  };
  return {
    activeInstall: null,
    catalog: {
      catalogVersion: 6,
      collections: [],
      families: [],
      models: [model],
    },
    compiledAdapters: [],
    compiledRuntimes: [],
    failedInstall: null,
    installedModels: installed
      ? [
          {
            catalogVersion: 6,
            familyId: model.familyId,
            installPath: '/models/firefox',
            installedArtifactIds: [],
            installedAtUnixMs: 1,
            installedVoiceIds: [],
            modelId: model.modelId,
            runtimeId: model.runtimeId,
            runtimePath: '/models/firefox/bergamot-translator.wasm',
            totalSizeBytes: 551_598_146,
          },
        ]
      : [],
    installRequestPending: false,
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: null,
    selectedModelCapabilities: { status: 'none' },
    selectedTranslationModel: installed
      ? {
          familyId: model.familyId,
          kind: 'catalog_model',
          modelId: model.modelId,
          runtimeId: model.runtimeId,
        }
      : null,
    selectedTtsModel: null,
    selectedTtsModelCapabilities: { status: 'none' },
  };
}

function hyMtState(installed: boolean): ModelManagerState {
  const base = state(installed);
  const baseModel = base.catalog.models[0];
  if (baseModel === undefined) throw new Error('Expected a translation model.');
  const model = {
    ...baseModel,
    displayName: 'Tencent HY-MT 2',
    familyId: 'tencent_hy_mt' as const,
    runtimeId: 'llama_cpp' as const,
  };
  return {
    ...base,
    catalog: { ...base.catalog, models: [model] },
    installedModels: installed
      ? base.installedModels.map((candidate) => ({
          ...candidate,
          familyId: 'tencent_hy_mt',
          modelId: model.modelId,
          runtimeId: 'llama_cpp',
        }))
      : [],
    selectedTranslationModel: installed
      ? {
          familyId: model.familyId,
          kind: 'catalog_model' as const,
          modelId: model.modelId,
          runtimeId: model.runtimeId,
        }
      : null,
  };
}

describe('Translation settings', () => {
  it('shows the installed model and deep-links model management to Translation', async () => {
    Setting.reset();
    const openModelPicker = vi.fn(async () => {});
    const container = new TestElement();
    const manager = {
      getState: () => state(true),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;

    renderTranslationModelSetting(container as unknown as HTMLDivElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      manager,
      openModelPicker,
      persistLanguages: vi.fn(async () => {}),
    });

    const modelSetting = Setting.named('Translation model');
    expect(modelSetting.descEl.textContent).toContain('Firefox Translations');
    expect(modelSetting.descEl.textContent).toContain('Installed');
    expect(modelSetting.buttonComponents[0]?.text).toBe('Manage models');
    await modelSetting.buttonComponents[0]?.click();
    expect(openModelPicker).toHaveBeenCalledExactlyOnceWith({
      initialTask: 'translation',
    });
  });

  it('shows the effective language pair and keeps it valid when source changes', async () => {
    Setting.reset();
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      dictationLanguage: 'en' as const,
    };
    const persistLanguages = vi.fn(async (sourceLanguage, targetLanguage) => {
      settings = {
        ...settings,
        translationSourceLanguage: sourceLanguage,
        translationTargetLanguage: targetLanguage,
      };
    });
    const container = new TestElement();
    const manager = {
      getState: () => state(false),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;

    renderTranslationSettings(container as unknown as HTMLDivElement, {
      getSettings: () => settings,
      manager,
      openModelPicker: vi.fn(async () => {}),
      persistLanguages,
    });

    expect(Setting.named('Default source language').dropdownComponents[0]?.selectEl.value).toBe(
      'en',
    );
    expect(Setting.named('Default target language').dropdownComponents[0]?.selectEl.value).toBe(
      'es',
    );

    Setting.named('Default source language').dropdownComponents[0]?.change('fr');
    await vi.waitFor(() => {
      expect(persistLanguages).toHaveBeenCalledExactlyOnceWith('fr', 'es');
    });
  });

  it('shows an actionable Manage Models state when no translation model is selected', async () => {
    Setting.reset();
    const openModelPicker = vi.fn(async () => {});
    const container = new TestElement();
    const manager = {
      getState: () => state(false),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;

    renderTranslationModelSetting(container as unknown as HTMLDivElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      manager,
      openModelPicker,
      persistLanguages: vi.fn(async () => {}),
    });

    expect(Setting.named('Translation model').descEl.textContent).toContain(
      'No translation model is available.',
    );
    await Setting.named('Translation model').buttonComponents[0]?.click();
    expect(openModelPicker).toHaveBeenCalledWith({ initialTask: 'translation' });
  });

  it('offers HY-MT2 style presets and preserves a custom instruction', async () => {
    Setting.reset();
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      translationStyle: 'custom' as const,
      translationStyleInstruction: 'formal',
    };
    const persistStyle = vi.fn(async (translationStyle, translationStyleInstruction) => {
      settings = { ...settings, translationStyle, translationStyleInstruction };
    });
    const container = new TestElement();
    const manager = {
      getState: () => hyMtState(true),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;

    renderTranslationSettings(container as unknown as HTMLDivElement, {
      getSettings: () => settings,
      manager,
      openModelPicker: vi.fn(async () => {}),
      persistLanguages: vi.fn(async () => {}),
      persistStyle,
    });

    const style = Setting.named('Translation style');
    expect(style.dropdownComponents[0]?.selectEl.options.map((option) => option.label)).toEqual([
      'Standard',
      'Formal',
      'Casual',
      'Custom',
    ]);
    expect(style.dropdownComponents[0]?.selectEl.value).toBe('custom');
    const setting = Setting.named('Advanced style instruction');
    expect(setting.textAreaComponents[0]?.inputEl.value).toBe('formal');
    setting.textAreaComponents[0]?.change('  casual\nuse tú  ');
    await vi.waitFor(() => expect(persistStyle).toHaveBeenCalledWith('custom', 'casual\nuse tú'));

    style.dropdownComponents[0]?.change('formal');
    await vi.waitFor(() => expect(persistStyle).toHaveBeenCalledWith('formal', 'casual\nuse tú'));

    Setting.reset();
    renderTranslationSettings(container as unknown as HTMLDivElement, {
      getSettings: () => settings,
      manager: { ...manager, getState: () => state(true) } as unknown as ModelInstallManager,
      openModelPicker: vi.fn(async () => {}),
      persistLanguages: vi.fn(async () => {}),
      persistStyle,
    });
    expect(Setting.instances.some((candidate) => candidate.name === 'Translation style')).toBe(
      false,
    );
  });
});
