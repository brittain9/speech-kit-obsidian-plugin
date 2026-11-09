import { describe, expect, it, vi } from 'vitest';

import type { ModelInstallManager, ModelManagerState } from '../src/models/model-install-manager';
import { renderModelSection } from '../src/settings/model-settings-section';
import { Setting, TestElement } from './__mocks__/obsidian';

vi.mock('../src/shared/i18n', () => ({
  t: (key: string) =>
    ({
      'models.current.externalFile': '外部ファイル',
      'models.current.unavailable': '利用不可能',
      'settings.model.noModel': 'モデルなし',
      'settings.model.unavailable': '利用不可能',
    })[key] ?? key,
}));

describe('model settings section ownership', () => {
  it('opens the speech picker from a compact summary row', async () => {
    const container = new TestElement();
    const onManageModels = vi.fn();
    const manager = {
      getState: () => ({
        activeInstall: null,
        catalog: { catalogVersion: 1, collections: [], families: [], models: [] },
        compiledAdapters: [],
        compiledRuntimes: [],
        failedInstall: null,
        installedModels: [],
        installRequestPending: false,
        loadError: null,
        loadStatus: 'ready',
        modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
        selectedModel: null,
        selectedModelCapabilities: { status: 'none' },
        selectedTtsModel: null,
        selectedTtsModelCapabilities: { status: 'none' },
      }),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const original = globalThis.createFragment;
    globalThis.createFragment = () => new TestElement() as unknown as DocumentFragment;
    try {
      const dispose = renderModelSection(container as unknown as HTMLDivElement, manager, {
        onManageModels,
        onExternalFile: vi.fn(),
        onModelInfo: null,
      });
      const open = container.findByClass('local-stt-model-summary-open');
      expect(open).toBeDefined();
      await open?.click();
      expect(onManageModels).toHaveBeenCalledOnce();
      dispose();
    } finally {
      globalThis.createFragment = original;
    }
  });
  it('does not erase sibling language controls when manager state changes', () => {
    const section = new TestElement();
    const modelSummary = section.createDiv();
    const languageSetting = new Setting(section).setName('Dictation language');
    let notify = () => {};
    const state: ModelManagerState = {
      activeInstall: null,
      catalog: { catalogVersion: 1, collections: [], families: [], models: [] },
      compiledAdapters: [],
      compiledRuntimes: [],
      failedInstall: null,
      installedModels: [],
      installRequestPending: false,
      loadError: null,
      loadStatus: 'ready',
      modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
      selectedModel: null,
      selectedModelCapabilities: { status: 'none' },
      selectedTtsModel: null,
      selectedTtsModelCapabilities: { status: 'none' },
    };
    const manager = {
      getState: () => state,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const originalCreateFragment = globalThis.createFragment;
    globalThis.createFragment = () => new TestElement() as unknown as DocumentFragment;

    try {
      renderModelSection(modelSummary as unknown as HTMLDivElement, manager, {
        onExternalFile: () => {},
        onManageModels: () => {},
        onModelInfo: null,
      });
      notify();

      expect(section.children).toContain(languageSetting.settingEl);
      expect(modelSummary.children).not.toContain(languageSetting.settingEl);
      const status = () =>
        modelSummary.findByClass('local-stt-model-summary-dot')?.getAttribute('title');
      expect(status()).toBe('settings.model.noModelSelected');
      state.selectedModel = {
        kind: 'catalog_model',
        familyId: 'moonshine',
        runtimeId: 'onnx_runtime',
        modelId: 'test-model',
      };
      state.loadStatus = 'loading';
      notify();
      expect(status()).toBe('settings.model.checking');
      state.loadStatus = 'ready';
      notify();
      expect(status()).toBe('settings.model.notInstalled');
      expect(modelSummary.findByClass('local-stt-model-summary-detail')).toBeUndefined();
      state.installedModels = [
        {
          catalogVersion: 1,
          familyId: 'moonshine',
          runtimeId: 'onnx_runtime',
          modelId: 'test-model',
          installPath: '/models/test',
          installedArtifactIds: [],
          installedAtUnixMs: 1,
          installedVoiceIds: [],
          runtimePath: null,
          totalSizeBytes: 1,
        },
      ];
      notify();
      expect(status()).toBe('models.current.installed');
      const external = {
        kind: 'external_file' as const,
        familyId: 'moonshine' as const,
        runtimeId: 'onnx_runtime' as const,
        filePath: '/models/external.ort',
      };
      state.selectedModel = external;
      state.selectedModelCapabilities = {
        status: 'unavailable',
        reason: 'missing',
        selection: external,
      };
      notify();
      expect(status()).toBe('settings.model.externalMissing');
      expect(modelSummary.findByClass('local-stt-model-summary-dot--missing')).toBeDefined();
      state.selectedModelCapabilities = {
        status: 'unavailable',
        reason: 'probe_failed',
        selection: external,
      };
      notify();
      expect(status()).toBe('利用不可能');
      expect(modelSummary.findByClass('local-stt-model-summary-dot--neutral')).toBeDefined();
    } finally {
      globalThis.createFragment = originalCreateFragment;
    }
  });
});
