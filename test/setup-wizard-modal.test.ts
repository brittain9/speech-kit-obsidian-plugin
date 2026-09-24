import { afterEach, describe, expect, it, vi } from 'vitest';

import { de } from '../src/locales/de';
import type { ModelInstallManager, ModelManagerState } from '../src/models/model-install-manager';
import type { CatalogModelRecord } from '../src/models/model-management-types';
import { SetupWizardModal } from '../src/setup/setup-wizard-modal';
import type { SidecarInstallManager } from '../src/sidecar/sidecar-install-manager';
import type { TestElement } from './__mocks__/obsidian';

function model(
  modelId: string,
  displayName: string,
  sizeMiB: number,
  uxTags: string[],
): CatalogModelRecord {
  return {
    artifacts: [
      {
        artifactId: 'model',
        downloadUrl: `https://example.com/${modelId}`,
        filename: `${modelId}.ort`,
        required: true,
        role: 'transcription_model',
        sha256: '0'.repeat(64),
        sizeBytes: sizeMiB * 1024 * 1024,
      },
    ],
    collectionId: 'moonshine_streaming',
    displayName,
    familyId: 'moonshine',
    languageTags: ['en'],
    supportsAutomaticLanguageDetection: false,
    licenseLabel: 'MIT',
    licenseUrl: 'https://example.com/license',
    modelCardUrl: null,
    modelId,
    notes: [],
    runtimeId: 'onnx_runtime',
    sourceUrl: 'https://example.com/source',
    summary: 'Test model',
    task: 'stt',
    uxTags,
  };
}

function modelManagerState(overrides: Partial<ModelManagerState> = {}): ModelManagerState {
  const catalogModel = model('moonshine-tiny', 'Moonshine Tiny', 50, ['fast', 'lightweight']);
  return {
    activeInstall: null,
    catalog: {
      catalogVersion: 1,
      collections: [],
      families: [
        {
          displayName: 'Moonshine',
          familyId: 'moonshine',
          runtimeId: 'onnx_runtime',
          summary: '',
          task: 'stt',
        },
      ],
      models: [catalogModel, model('moonshine-small', 'Moonshine Small', 160, ['balanced'])],
    },
    compiledAdapters: [
      {
        displayName: 'Moonshine',
        familyCapabilities: {
          availableVoices: [],
          maxAudioDurationSecs: null,
          outputSampleRate: null,
          producesPunctuation: true,
          supportsHardwareAcceleration: false,
          supportedLanguages: { kind: 'list', tags: ['en'] },
          supportsAutomaticLanguageDetection: false,
          supportsInitialPrompt: false,
          supportsLanguageSelection: true,
          supportsSegmentTimestamps: false,
          supportsSpeedControl: false,
          supportsStreaming: true,
          supportsWordTimestamps: false,
          task: 'stt',
        },
        familyId: 'moonshine',
        runtimeId: 'onnx_runtime',
      },
    ],
    compiledRuntimes: [],
    failedInstall: null,
    installedModels: [],
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: null,
    selectedModelCapabilities: { status: 'none' },
    selectedTtsModel: null,
    selectedTtsModelCapabilities: { status: 'none' },
    ...overrides,
  };
}

function finalOnlyModelManagerState(): ModelManagerState {
  const base = modelManagerState();
  const finalModel = {
    ...model('whisper-tiny-sr', 'Whisper Tiny', 50, ['fast', 'cpu']),
    familyId: 'whisper' as const,
    languageTags: ['sr'],
    runtimeId: 'whisper_cpp' as const,
  };
  const baseAdapter = base.compiledAdapters[0];
  if (baseAdapter === undefined) throw new Error('Expected a test model adapter');
  return modelManagerState({
    catalog: {
      ...base.catalog,
      families: [
        {
          displayName: 'Whisper',
          familyId: 'whisper',
          runtimeId: 'whisper_cpp',
          summary: '',
          task: 'stt',
        },
      ],
      models: [finalModel],
    },
    compiledAdapters: [
      {
        ...baseAdapter,
        familyCapabilities: {
          ...baseAdapter.familyCapabilities,
          supportedLanguages: { kind: 'list', tags: ['sr'] },
          supportsStreaming: false,
        },
        familyId: 'whisper',
        runtimeId: 'whisper_cpp',
      },
    ],
  });
}

function textContent(element: TestElement): string {
  return [element.textContent, ...element.children.map(textContent)].filter(Boolean).join(' ');
}

function button(modal: SetupWizardModal, label: string): TestElement {
  const match = (modal.contentEl as unknown as TestElement)
    .querySelectorAll('button')
    .find((candidate) => candidate.textContent === label);
  if (match === undefined) throw new Error(`Button not found: ${label}`);
  return match;
}

function modalDependencies(
  manager: ModelInstallManager,
  overrides: Partial<ConstructorParameters<typeof SetupWizardModal>[0]> = {},
): ConstructorParameters<typeof SetupWizardModal>[0] {
  return {
    app: {} as never,
    feedback: { show: vi.fn() },
    hasDictationTarget: () => true,
    hasSelectedModel: () => false,
    isDictationBusy: () => false,
    isSidecarInstalled: async () => true,
    modelInstallManager: manager,
    onCompleted: vi.fn(async () => {}),
    pluginDirectory: '/plugin',
    postSidecarInstalled: vi.fn(async () => {}),
    prepareDictationTarget: vi.fn(async () => true),
    sidecarVersion: '2026.8.2',
    sidecarConnection: {
      restart: vi.fn(async () => ({
        sidecarVersion: '2026.8.2',
        status: 'ready' as const,
        type: 'health_ok' as const,
      })),
    },
    sidecarInstallManager: {} as SidecarInstallManager,
    sidecarStartupTimeoutMs: 4_000,
    startDictation: vi.fn(async () => {}),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SetupWizardModal lifecycle', () => {
  it('does not subscribe or render when the modal closes during its prerequisite check', async () => {
    let resolveInstalled: ((installed: boolean) => void) | undefined;
    const isSidecarInstalled = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveInstalled = resolve;
        }),
    );
    const hasSelectedModel = vi.fn(() => true);
    const subscribe = vi.fn(() => vi.fn());
    const modal = new SetupWizardModal({
      app: {} as never,
      feedback: { show: vi.fn() },
      hasDictationTarget: () => true,
      hasSelectedModel,
      isDictationBusy: () => false,
      isSidecarInstalled,
      modelInstallManager: { subscribe } as unknown as ModelInstallManager,
      onCompleted: vi.fn(async () => {}),
      pluginDirectory: '/plugin',
      prepareDictationTarget: vi.fn(async () => true),
      sidecarVersion: '2026.8.2',
      postSidecarInstalled: vi.fn(async () => {}),
      sidecarConnection: {
        restart: vi.fn(async () => ({
          sidecarVersion: '2026.8.2',
          status: 'ready' as const,
          type: 'health_ok' as const,
        })),
      },
      sidecarInstallManager: {} as SidecarInstallManager,
      sidecarStartupTimeoutMs: 4_000,
      startDictation: vi.fn(async () => {}),
    });

    modal.open();
    expect(isSidecarInstalled).toHaveBeenCalledOnce();
    modal.close();

    resolveInstalled?.(true);
    await Promise.resolve();

    expect(hasSelectedModel).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(modal.contentEl.children).toHaveLength(0);
  });
});

describe('SetupWizardModal first-run guidance', () => {
  it('offers a low-resource live starting model with explicit language and cost', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 4, hardwareConcurrency: 4 });
    const state = modelManagerState();
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();

    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).toContain('Recommended for your setup');
      expect(text).toContain('Moonshine Tiny');
      expect(text).toContain('Live words appear while you speak');
      expect(text).toContain('English');
      expect(text).toContain('50.0 MiB download');
      expect(text).toContain('lower-power computer');
      expect(text).toContain('CUDA is optional');
    });
    expect(button(modal, 'Install and use').textContent).toBe('Install and use');
  });

  it('states final-only semantics when no live model supports the language', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
    const manager = {
      getDictationLanguage: () => 'sr',
      getState: () => finalOnlyModelManagerState(),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();

    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).toContain('Whisper Tiny');
      expect(text).toContain('smallest compatible model');
      expect(text).toContain('Final words appear after a pause');
      expect(text).toContain('There are no live partial words');
      expect(text).toContain('Српски');
    });
  });

  it('requests microphone access once and lets permission recovery be retried safely', async () => {
    const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
    const stop = vi.fn();
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(denied)
      .mockResolvedValue({ getTracks: () => [{ stop }] });
    let permissionState: PermissionState = 'prompt';
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia },
      permissions: {
        query: vi.fn(async () => ({ state: permissionState })),
      },
    });
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => modelManagerState(),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, { hasSelectedModel: () => true }),
    );

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Check microphone')).toBeDefined());
    expect(getUserMedia).not.toHaveBeenCalled();

    await button(modal, 'Check microphone').click();

    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).toContain('Microphone permission denied');
      expect(text).toContain('After changing access, choose Check again');
      expect(button(modal, 'Check again')).toBeDefined();
    });
    expect(getUserMedia).toHaveBeenCalledOnce();

    await button(modal, 'Check again').click();
    await vi.waitFor(() => expect(button(modal, 'Check again')).toBeDefined());
    expect(getUserMedia).toHaveBeenCalledOnce();

    permissionState = 'granted';
    await button(modal, 'Check again').click();
    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).toContain('Microphone ready');
      expect(button(modal, 'Continue')).toBeDefined();
    });
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('localizes the model guidance and microphone recovery', () => {
    expect(de['setup.wizard.recommendation.title']).toBe('Empfehlung für Ihre Einrichtung');
    expect(de['setup.wizard.recommendation.installAndUse']).toBe('Installieren und verwenden');
    expect(de['setup.microphone.checkAgain']).toBe('Erneut prüfen');
    expect(de['setup.microphone.recovery']).toContain('Erneut prüfen');
  });

  it('starts the recommended download only after the explicit install action', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
    const state = modelManagerState();
    let hasSelectedModel = false;
    const installAndWait = vi.fn(async () => {
      hasSelectedModel = true;
      state.selectedModel = {
        familyId: 'moonshine',
        kind: 'catalog_model',
        modelId: 'moonshine-small',
        runtimeId: 'onnx_runtime',
      };
    });
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      installAndWait,
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, { hasSelectedModel: () => hasSelectedModel }),
    );

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Install and use')).toBeDefined());
    expect(installAndWait).not.toHaveBeenCalled();

    await button(modal, 'Install and use').click();

    await vi.waitFor(() => {
      expect(installAndWait).toHaveBeenCalledExactlyOnceWith({
        familyId: 'moonshine',
        kind: 'catalog_model',
        modelId: 'moonshine-small',
        runtimeId: 'onnx_runtime',
      });
      expect(textContent(modal.contentEl as unknown as TestElement)).toContain('Model selected');
    });
  });

  it('keeps an existing model selection authoritative and does not offer a replacement', async () => {
    const selection = {
      familyId: 'moonshine' as const,
      kind: 'catalog_model' as const,
      modelId: 'moonshine-small',
      runtimeId: 'onnx_runtime' as const,
    };
    const state = modelManagerState({ selectedModel: selection });
    const installAndWait = vi.fn(async () => {});
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      installAndWait,
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, { hasSelectedModel: () => true }),
    );

    modal.open();

    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).not.toContain('Recommended for your setup');
      expect(text).not.toContain('Install and use');
    });
    expect(installAndWait).not.toHaveBeenCalled();
  });

  it('explains an unsupported language and leaves model choice in Customize models', async () => {
    const manager = {
      getDictationLanguage: () => 'tl',
      getState: () => modelManagerState(),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();

    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).toContain('No starting model for this language');
      expect(text).toContain('Change Dictation language');
      expect(text).toContain('Customize models');
      expect(text).not.toContain('Install and use');
    });
  });
});
