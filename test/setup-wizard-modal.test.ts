import { afterEach, describe, expect, it, vi } from 'vitest';

import { de } from '../src/locales/de';
import type { ModelInstallManager, ModelManagerState } from '../src/models/model-install-manager';
import type { CatalogModelRecord } from '../src/models/model-management-types';
import { prepareFirstRunDictationTarget } from '../src/setup/first-run-dictation-target';
import { recommendationStateSignature, SetupWizardModal } from '../src/setup/setup-wizard-modal';
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

function readySelection() {
  return {
    familyId: 'moonshine' as const,
    kind: 'catalog_model' as const,
    modelId: 'moonshine-small',
    runtimeId: 'onnx_runtime' as const,
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

function createFirstRunBoundary(
  options: {
    existingFiles?: Array<{ extension: string; path: string }>;
    failCreate?: boolean;
    failOpen?: boolean;
    openLeavesTarget?: boolean;
  } = {},
) {
  const files = [...(options.existingFiles ?? [])];
  let hasTarget = false;
  const vault = {
    create: vi.fn(async (path: string) => {
      if (options.failCreate === true) throw new Error('create failed');
      const created = { extension: 'md', path };
      files.push(created);
      return created;
    }),
    getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
    getAllLoadedFiles: () => files,
    getMarkdownFiles: () => files.filter((file) => file.extension === 'md'),
  };
  const openLinkText = vi.fn(async () => {
    if (options.failOpen === true) throw new Error('open failed');
    hasTarget = options.openLeavesTarget ?? true;
  });
  return {
    dependencies: {
      hasTarget: () => hasTarget,
      vault,
      workspace: { openLinkText },
    },
    openLinkText,
    vault,
  };
}

async function openReadyWizard(modal: SetupWizardModal): Promise<void> {
  vi.stubGlobal('navigator', {
    deviceMemory: 8,
    hardwareConcurrency: 8,
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
    },
    permissions: { query: vi.fn(async () => ({ state: 'granted' })) },
  });
  modal.open();
  await vi.waitFor(() => expect(button(modal, 'Check microphone')).toBeDefined());
  await button(modal, 'Check microphone').click();
  await vi.waitFor(() => expect(button(modal, 'Continue')).toBeDefined());
  await button(modal, 'Continue').click();
  await vi.waitFor(() => expect(button(modal, 'Try dictation now')).toBeDefined());
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
      expect(text).toContain('smallest compatible live choice');
      expect(text).toContain('CUDA is optional');
    });
    expect(button(modal, 'Install and use').textContent).toBe('Install and use');
  });

  it('refreshes a recommendation when catalog loading finishes without a selection change', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 4, hardwareConcurrency: 4 });
    let state = modelManagerState({ loadStatus: 'loading' });
    let notify: (() => void) | undefined;
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();
    await vi.waitFor(() =>
      expect(textContent(modal.contentEl as unknown as TestElement)).toContain(
        'Loading the model catalog',
      ),
    );

    state = { ...state, loadStatus: 'ready' };
    notify?.();

    await vi.waitFor(() =>
      expect(textContent(modal.contentEl as unknown as TestElement)).toContain('Moonshine Tiny'),
    );
  });

  it('does not treat download progress bytes as a recommendation state change', () => {
    const state = modelManagerState();
    const installUpdate = {
      details: null,
      downloadedBytes: 10,
      familyId: 'moonshine' as const,
      installId: 'install-1',
      message: null,
      modelId: 'moonshine-small',
      runtimeId: 'onnx_runtime' as const,
      state: 'downloading' as const,
      totalBytes: 200,
    };
    const first = {
      ...state,
      activeInstall: { installUpdate, lastError: null, phase: 'installing' as const },
    };
    const second = {
      ...first,
      activeInstall: {
        ...first.activeInstall,
        installUpdate: { ...installUpdate, downloadedBytes: 150 },
      },
    };

    expect(recommendationStateSignature(first)).toBe(recommendationStateSignature(second));
  });

  it('distinguishes capability discovery failure from an unavailable language model', async () => {
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => modelManagerState({ capabilityLoadError: 'system info unavailable' }),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();

    await vi.waitFor(() => {
      const text = textContent(modal.contentEl as unknown as TestElement);
      expect(text).toContain('Model capabilities unavailable');
      expect(text).toContain('Retry capabilities');
      expect(text).not.toContain('No starting model for this language');
    });
  });

  it('updates an external recommendation install from start to completion', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
    let state = modelManagerState();
    let notify: (() => void) | undefined;
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Install and use')).toBeDefined());
    state = {
      ...state,
      activeInstall: {
        installUpdate: {
          details: null,
          downloadedBytes: 10,
          familyId: 'moonshine',
          installId: 'external-install',
          message: null,
          modelId: 'moonshine-small',
          runtimeId: 'onnx_runtime',
          state: 'downloading',
          totalBytes: 200,
        },
        lastError: null,
        phase: 'installing',
      },
    };
    notify?.();

    await vi.waitFor(() => expect(button(modal, 'Installing…')).toBeDefined());
    state = {
      ...state,
      activeInstall: null,
      installedModels: [
        {
          catalogVersion: 1,
          familyId: 'moonshine',
          installPath: '/models/moonshine-small',
          installedArtifactIds: ['model'],
          installedAtUnixMs: 1,
          installedVoiceIds: [],
          modelId: 'moonshine-small',
          runtimeId: 'onnx_runtime',
          runtimePath: null,
          totalSizeBytes: 160,
        },
      ],
    };
    notify?.();

    await vi.waitFor(() => expect(button(modal, 'Use this model')).toBeDefined());
    expect(recommendationStateSignature(state)).toContain('moonshine-small');
  });

  it('surfaces an external recommendation failure as a retry action', async () => {
    const installAndWait = vi.fn(async () => {});
    const state = modelManagerState({
      failedInstall: {
        artifactIds: ['model'],
        failureId: 'failed-install',
        message: 'network reset',
        selection: {
          familyId: 'moonshine',
          kind: 'catalog_model',
          modelId: 'moonshine-small',
          runtimeId: 'onnx_runtime',
        },
      },
    });
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      installAndWait,
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(modalDependencies(manager));

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Retry install')).toBeDefined());
    await button(modal, 'Retry install').click();

    expect(installAndWait).toHaveBeenCalledOnce();
  });

  it('keeps an existing selection authoritative when recommendation state changes', async () => {
    const selection = {
      familyId: 'moonshine' as const,
      kind: 'catalog_model' as const,
      modelId: 'moonshine-small',
      runtimeId: 'onnx_runtime' as const,
    };
    let state = modelManagerState({ selectedModel: selection });
    let notify: (() => void) | undefined;
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, { hasSelectedModel: () => true }),
    );

    modal.open();
    await vi.waitFor(() =>
      expect(textContent(modal.contentEl as unknown as TestElement)).not.toContain(
        'Recommended for your setup',
      ),
    );
    state = { ...state, loadStatus: 'loading' };
    notify?.();

    expect(textContent(modal.contentEl as unknown as TestElement)).not.toContain('Install and use');
  });

  it('returns to the model prerequisite when a previously ready selection is cleared', async () => {
    vi.stubGlobal('navigator', {
      deviceMemory: 8,
      hardwareConcurrency: 8,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })),
      },
      permissions: { query: vi.fn(async () => ({ state: 'granted' })) },
    });
    const selection = {
      familyId: 'moonshine' as const,
      kind: 'catalog_model' as const,
      modelId: 'moonshine-small',
      runtimeId: 'onnx_runtime' as const,
    };
    let hasSelectedModel = true;
    let state = modelManagerState({ selectedModel: selection });
    let notify: (() => void) | undefined;
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, { hasSelectedModel: () => hasSelectedModel }),
    );

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Check microphone')).toBeDefined());
    await button(modal, 'Check microphone').click();
    await vi.waitFor(() => expect(button(modal, 'Continue')).toBeDefined());
    await button(modal, 'Continue').click();
    await vi.waitFor(() => expect(button(modal, 'Try dictation now')).toBeDefined());

    hasSelectedModel = false;
    state = { ...state, selectedModel: null };
    notify?.();

    await vi.waitFor(() => expect(button(modal, 'Install and use')).toBeDefined());
  });
  it('offers Use for an already installed recommendation without downloading', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
    let hasSelectedModel = false;
    const state = modelManagerState({
      installedModels: [
        {
          catalogVersion: 1,
          familyId: 'moonshine',
          installPath: '/models/moonshine-small',
          installedArtifactIds: ['model'],
          installedAtUnixMs: 1,
          installedVoiceIds: [],
          modelId: 'moonshine-small',
          runtimeId: 'onnx_runtime',
          runtimePath: null,
          totalSizeBytes: 160,
        },
      ],
    });
    const select = vi.fn(async (selection: typeof state.selectedModel) => {
      state.selectedModel = selection;
      hasSelectedModel = true;
    });
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      select,
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, { hasSelectedModel: () => hasSelectedModel }),
    );

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Use this model')).toBeDefined());
    await button(modal, 'Use this model').click();

    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
    expect(select).toHaveBeenCalledWith({
      familyId: 'moonshine',
      kind: 'catalog_model',
      modelId: 'moonshine-small',
      runtimeId: 'onnx_runtime',
    });
  });

  it('keeps install failure recovery available and retries the same recommendation', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 8, hardwareConcurrency: 8 });
    const state = modelManagerState();
    let hasSelectedModel = false;
    const feedback = { show: vi.fn() };
    const installAndWait = vi
      .fn()
      .mockRejectedValueOnce(new Error('network reset'))
      .mockImplementationOnce(async () => {
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
      modalDependencies(manager, {
        feedback,
        hasSelectedModel: () => hasSelectedModel,
      }),
    );

    modal.open();
    await vi.waitFor(() => expect(button(modal, 'Install and use')).toBeDefined());
    await button(modal, 'Install and use').click();
    await vi.waitFor(() =>
      expect(feedback.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Could not install and use the recommended model. Try again.',
        }),
      ),
    );

    expect(button(modal, 'Install and use')).toBeDefined();
    await button(modal, 'Install and use').click();
    await vi.waitFor(() =>
      expect(textContent(modal.contentEl as unknown as TestElement)).toContain('Model selected'),
    );
    expect(installAndWait).toHaveBeenCalledTimes(2);
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
    expect(de['setup.microphone.recheck']).toContain('Erneut prüfen');
    expect(de['setup.microphone.reopenSetup']).toContain('Setup');
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

  it('prepares and opens one scratch note through Try dictation for an empty vault', async () => {
    const boundary = createFirstRunBoundary();
    const state = modelManagerState({ selectedModel: readySelection() });
    const startDictation = vi.fn(async () => {});
    const onCompleted = vi.fn(async () => {});
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => state,
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, {
        hasDictationTarget: () => boundary.dependencies.hasTarget(),
        hasSelectedModel: () => true,
        onCompleted,
        prepareDictationTarget: () =>
          prepareFirstRunDictationTarget(boundary.dependencies as never, '# Scratch'),
        startDictation,
      }),
    );

    await openReadyWizard(modal);
    await button(modal, 'Try dictation now').click();

    await vi.waitFor(() => expect(startDictation).toHaveBeenCalledOnce());
    expect(boundary.vault.create).toHaveBeenCalledOnce();
    expect(boundary.openLinkText).toHaveBeenCalledWith('Speech Kit scratch note.md', '', true, {
      active: true,
      state: { mode: 'source' },
    });
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it('shows localized open-note guidance when a non-empty vault has no target', async () => {
    const boundary = createFirstRunBoundary({
      existingFiles: [{ extension: 'md', path: 'Notes/existing.md' }],
    });
    const feedback = { show: vi.fn() };
    const startDictation = vi.fn(async () => {});
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => modelManagerState({ selectedModel: readySelection() }),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, {
        feedback,
        hasDictationTarget: () => boundary.dependencies.hasTarget(),
        hasSelectedModel: () => true,
        prepareDictationTarget: () =>
          prepareFirstRunDictationTarget(boundary.dependencies as never, '# Scratch'),
        startDictation,
      }),
    );

    await openReadyWizard(modal);
    await button(modal, 'Try dictation now').click();

    await vi.waitFor(() =>
      expect(feedback.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Open a Markdown note in editing mode, then try dictation again.',
        }),
      ),
    );
    expect(boundary.vault.create).not.toHaveBeenCalled();
    expect(startDictation).not.toHaveBeenCalled();
  });

  it('keeps setup open when openLinkText resolves without a target', async () => {
    const boundary = createFirstRunBoundary({ openLeavesTarget: false });
    const feedback = { show: vi.fn() };
    const manager = {
      getDictationLanguage: () => 'en',
      getState: () => modelManagerState({ selectedModel: readySelection() }),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager;
    const modal = new SetupWizardModal(
      modalDependencies(manager, {
        feedback,
        hasDictationTarget: () => boundary.dependencies.hasTarget(),
        hasSelectedModel: () => true,
        prepareDictationTarget: () =>
          prepareFirstRunDictationTarget(boundary.dependencies as never, '# Scratch'),
      }),
    );

    await openReadyWizard(modal);
    await button(modal, 'Try dictation now').click();

    await vi.waitFor(() =>
      expect(feedback.show).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Open a Markdown note in editing mode, then try dictation again.',
        }),
      ),
    );
    expect(button(modal, 'Try dictation now')).toBeDefined();
  });

  it.each(['create', 'open'] as const)(
    'keeps setup open with localized recovery when scratch %s fails',
    async (operation) => {
      const boundary = createFirstRunBoundary({
        failCreate: operation === 'create',
        failOpen: operation === 'open',
      });
      const feedback = { show: vi.fn() };
      const manager = {
        getDictationLanguage: () => 'en',
        getState: () => modelManagerState({ selectedModel: readySelection() }),
        subscribe: () => () => {},
      } as unknown as ModelInstallManager;
      const modal = new SetupWizardModal(
        modalDependencies(manager, {
          feedback,
          hasDictationTarget: () => boundary.dependencies.hasTarget(),
          hasSelectedModel: () => true,
          prepareDictationTarget: () =>
            prepareFirstRunDictationTarget(boundary.dependencies as never, '# Scratch'),
        }),
      );

      await openReadyWizard(modal);
      await button(modal, 'Try dictation now').click();

      await vi.waitFor(() =>
        expect(feedback.show).toHaveBeenCalledWith(
          expect.objectContaining({
            message: "Couldn't open a safe dictation note. Try again.",
          }),
        ),
      );
      expect(button(modal, 'Try dictation now')).toBeDefined();
    },
  );

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
