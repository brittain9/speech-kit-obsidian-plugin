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
  it('reports installed, missing, unavailable and unselected translation models', () => {
    let current = state(true);
    let notify = () => {};
    const container = new TestElement();
    renderTranslationModelSetting(container as unknown as HTMLDivElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      manager: {
        getState: () => current,
        subscribe: (listener: () => void) => {
          notify = listener;
          return () => {};
        },
      } as unknown as ModelInstallManager,
      openModelPicker: vi.fn(async () => {}),
      persistLanguages: vi.fn(async () => {}),
    });
    const status = () =>
      container.findByClass('local-stt-model-summary-dot')?.getAttribute('title');
    expect(status()).toBe('Installed');
    current = { ...current, installedModels: [] };
    notify();
    expect(status()).toBe('Not installed');
    current = { ...current, loadStatus: 'error' };
    notify();
    expect(status()).toBe('Unavailable');
    current = { ...current, selectedTranslationModel: null };
    notify();
    expect(status()).toBe('No model selected');
  });
  it.each([
    ['tencent_hy_mt_2_1_8b_q4_k_m', 'Tencent HY-MT 2 1.8B (Q4_K_M)', 'HY-MT 2 · 1.8B'],
    ['tencent_hy_mt_2_7b_q4_k_m', 'Tencent HY-MT 2 7B (Q4_K_M)', 'HY-MT 2 · 7B'],
    ['other_variant', 'A different translation model', 'A different translation model'],
  ])('shows the appropriate summary for %s', (modelId, displayName, expected) => {
    const base = hyMtState(true);
    const baseModel = base.catalog.models[0];
    if (baseModel === undefined) throw new Error('Expected a translation model.');
    const model = {
      ...baseModel,
      modelId,
      displayName,
    };
    const current = {
      ...base,
      catalog: { ...base.catalog, models: [model] },
      selectedTranslationModel: {
        kind: 'catalog_model' as const,
        familyId: model.familyId,
        runtimeId: model.runtimeId,
        modelId: model.modelId,
      },
    };
    const container = new TestElement();
    renderTranslationModelSetting(container as unknown as HTMLDivElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      manager: {
        getState: () => current,
        subscribe: () => () => {},
      } as unknown as ModelInstallManager,
      openModelPicker: vi.fn(async () => {}),
      persistLanguages: vi.fn(async () => {}),
    });
    const value = container.findByClass('local-stt-model-summary-value');
    expect(value?.children[0]?.textContent).toBe(expected);
  });
  it('opens the translation picker from its summary row', async () => {
    const container = new TestElement();
    const picker = vi.fn(async () => {});
    renderTranslationModelSetting(container as unknown as HTMLDivElement, {
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      manager: {
        getState: () => state(true),
        subscribe: () => () => {},
      } as unknown as ModelInstallManager,
      openModelPicker: picker,
      persistLanguages: vi.fn(async () => {}),
    });
    const row = container.findByClass('local-stt-model-summary-open');
    expect(row).not.toBeNull();
    await row?.click();
    expect(picker).toHaveBeenCalledWith({ initialTask: 'translation' });
  });
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

    expect(container.findByClass('local-stt-model-summary-open')).toBeDefined();
    await container.findByClass('local-stt-model-summary-open')?.click();
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

    expect(container.findByClass('local-stt-model-summary-value')?.children[0]?.textContent).toBe(
      'No model selected',
    );
    expect(container.findByClass('local-stt-model-summary-open')).toBeDefined();
    await container.findByClass('local-stt-model-summary-open')?.click();
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
