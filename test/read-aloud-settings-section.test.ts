import { describe, expect, it, vi } from 'vitest';
import type { ModelInstallManager, ModelManagerState } from '../src/models/model-install-manager';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import {
  configureReadAloudSpeedSlider,
  readAloudControlsFingerprint,
  renderTextToSpeechSettings,
} from '../src/settings/read-aloud-settings-section';
import { Menu, Setting, SliderComponent, TestElement } from './__mocks__/obsidian';

function state(
  voices: string[],
  downloadedBytes: number | null = null,
  modelId = 'pocket_tts_english_2026_04_int8',
  includeCatalogModel = false,
): ModelManagerState {
  return {
    activeInstall:
      downloadedBytes === null
        ? null
        : {
            installUpdate: {
              details: null,
              downloadedBytes,
              familyId: 'pocket_tts',
              installId: 'voice-install',
              message: null,
              modelId,
              runtimeId: 'onnx_runtime',
              state: 'downloading',
              totalBytes: 100,
            },
            lastError: null,
            phase: 'installing',
          },
    catalog: {
      catalogVersion: 5,
      collections: [],
      families: [],
      models: includeCatalogModel
        ? [
            {
              artifacts: [],
              collectionId: 'read-aloud',
              defaultVoice: 'alba',
              displayName: `Pocket TTS ${modelId}`,
              familyId: 'pocket_tts',
              languageTags: ['en'],
              supportsAutomaticLanguageDetection: false,
              licenseLabel: 'MIT',
              licenseUrl: 'https://example.com/license',
              modelCardUrl: null,
              modelId,
              notes: [],
              runtimeId: 'onnx_runtime',
              sourceUrl: 'https://example.com/source',
              summary: 'Local synthesis',
              task: 'tts',
              uxTags: [],
            },
          ]
        : [],
    },
    compiledAdapters: [],
    compiledRuntimes: [],
    failedInstall: null,
    installedModels: [
      {
        catalogVersion: 5,
        familyId: 'pocket_tts',
        installPath: '/models/pocket',
        installedArtifactIds: [],
        installedAtUnixMs: 1,
        installedVoiceIds: voices,
        modelId,
        runtimeId: 'onnx_runtime',
        runtimePath: '/models/pocket/flow_lm_main_int8.onnx',
        totalSizeBytes: 1,
      },
    ],
    installRequestPending: false,
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: null,
    selectedModelCapabilities: { status: 'none' },
    selectedTtsModel: {
      familyId: 'pocket_tts',
      kind: 'catalog_model',
      modelId,
      runtimeId: 'onnx_runtime',
    },
    selectedTtsModelCapabilities: { status: 'none' },
  };
}

describe('Read Aloud settings incremental refresh', () => {
  it('opens the text-to-speech picker from its summary row', async () => {
    const currentState = state(['alba'], null, 'pocket_tts_english_2026_04_int8', true);
    const modelControls = new TestElement();
    const readAloudControls = new TestElement();
    const picker = vi.fn(async () => {});
    renderTextToSpeechSettings(
      modelControls as unknown as HTMLDivElement,
      readAloudControls as unknown as HTMLDivElement,
      readAloudControls.createDiv() as unknown as HTMLElement,
      {
        getSettings: () => ({
          ...DEFAULT_PLUGIN_SETTINGS,
          selectedTtsModel: currentState.selectedTtsModel,
        }),
        manager: {
          getState: () => currentState,
          subscribe: () => () => {},
        } as unknown as ModelInstallManager,
        openSelectedModelDetails: vi.fn(),
        openModelPicker: picker,
        persistLanguage: vi.fn(async () => {}),
        persistVoice: vi.fn(async () => {}),
      },
    );
    const row = modelControls.findByClass('local-stt-model-summary-open');
    expect(row).not.toBeNull();
    await row?.click();
    expect(picker).toHaveBeenCalledWith({ initialTask: 'tts' });
  });
  it('shows missing status only after discovery and refreshes when an empty-voice model is installed or removed', () => {
    Setting.reset();
    let currentState: ModelManagerState = {
      ...state([], null, 'pocket_tts_english_2026_04_int8', true),
      installedModels: [],
      loadStatus: 'loading' as ModelManagerState['loadStatus'],
    };
    let notify = () => {};
    const manager = {
      getState: () => currentState,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const parent = new TestElement();
    const modelControls = parent.createDiv();
    const readAloudControls = parent.createDiv();
    const before = readAloudControls.createDiv();
    renderTextToSpeechSettings(
      modelControls as unknown as HTMLDivElement,
      readAloudControls as unknown as HTMLDivElement,
      before as unknown as HTMLElement,
      {
        getSettings: () => ({
          ...DEFAULT_PLUGIN_SETTINGS,
          selectedTtsModel: currentState.selectedTtsModel,
        }),
        manager,
        openSelectedModelDetails: vi.fn(),
        openModelPicker: vi.fn(async () => {}),
        persistLanguage: vi.fn(async () => {}),
        persistVoice: vi.fn(async () => {}),
      },
    );
    const status = () =>
      modelControls.findByClass('local-stt-model-summary-dot')?.getAttribute('title');
    expect(status()).toBe('Checking…');
    currentState = { ...currentState, loadStatus: 'error', loadError: 'unavailable' };
    notify();
    expect(status()).toBe('Unavailable');
    currentState = { ...currentState, loadStatus: 'ready', loadError: null };
    notify();
    expect(status()).toBe('Not installed');
    currentState = { ...currentState, installedModels: state([]).installedModels };
    notify();
    expect(status()).toBe('Installed');
    currentState = { ...currentState, installedModels: [] };
    notify();
    expect(status()).toBe('Not installed');
    expect(currentState.selectedTtsModel?.kind).toBe('catalog_model');
  });
  it('shows the speed value dynamically and persists changes', () => {
    const slider = new SliderComponent();
    const persistSpeed = vi.fn(async () => {});

    configureReadAloudSpeedSlider(
      slider as unknown as import('obsidian').SliderComponent,
      1.25,
      persistSpeed,
    );

    expect(slider.dynamicTooltip).toBe(true);
    expect(slider.value).toBe(1.25);
    expect(slider.sliderEl).toMatchObject({ max: '2', min: '0.75', step: '0.05' });
    slider.change(1.5);
    expect(persistSpeed).toHaveBeenCalledWith(1.5);
  });

  it('ignores progress ticks but changes when same-model voice metadata refreshes', () => {
    const before = readAloudControlsFingerprint(state(['alba'], 10));
    expect(readAloudControlsFingerprint(state(['alba'], 90))).toBe(before);
    expect(readAloudControlsFingerprint(state(['alba', 'cosette'], null))).not.toBe(before);
  });

  it('changes when an unchanged selection becomes resolvable in the current catalog', () => {
    const unresolved = state(['alba']);
    const resolved = state(['alba'], null, 'pocket_tts_english_2026_04_int8', true);

    expect(resolved.catalog.catalogVersion).toBe(unresolved.catalog.catalogVersion);
    expect(resolved.selectedTtsModel).toEqual(unresolved.selectedTtsModel);
    expect(readAloudControlsFingerprint(resolved)).not.toBe(
      readAloudControlsFingerprint(unresolved),
    );
  });

  it('re-renders only its controls after voice metadata refreshes', () => {
    Setting.reset();
    let currentState = state(['alba'], 10);
    let notify = () => {};
    const manager = {
      getState: () => currentState,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const parent = new TestElement();
    const modelControls = parent.createDiv();
    const readAloudControls = parent.createDiv();
    const readAloudBefore = readAloudControls.createDiv();
    const focusedSibling = parent.createDiv({ attr: { 'data-focused': 'true' } });
    const dispose = renderTextToSpeechSettings(
      modelControls as unknown as HTMLDivElement,
      readAloudControls as unknown as HTMLDivElement,
      readAloudBefore as unknown as HTMLElement,
      {
        getSettings: () => ({
          ...DEFAULT_PLUGIN_SETTINGS,
          selectedTtsModel: currentState.selectedTtsModel,
        }),
        manager,
        openSelectedModelDetails: vi.fn(),
        openModelPicker: vi.fn(async () => {}),
        persistLanguage: vi.fn(async () => {}),
        persistVoice: vi.fn(async () => {}),
      },
    );
    const originalFirstControl = modelControls.children[0];
    expect(modelControls.children).toEqual([originalFirstControl]);
    expect(readAloudControls.children[2]).toBe(readAloudBefore);
    expect(modelControls.findByClass('local-stt-model-summary-open')).toBeDefined();
    expect(Setting.named('Reading language')).toBeDefined();
    expect(Setting.named('Voice')).toBeDefined();

    currentState = state(['alba'], 90);
    notify();
    expect(modelControls.children[0]).toBe(originalFirstControl);

    currentState = state(['alba', 'cosette']);
    notify();
    expect(modelControls.children[0]).not.toBe(originalFirstControl);
    expect(parent.children).toContain(focusedSibling);
    dispose();
  });

  it('shows a localized details button only for resolvable selections and delegates clicks to current state', async () => {
    Setting.reset();
    let currentState = state(['alba'], null, 'pocket_tts_english_2026_04_int8', true);
    let notify = () => {};
    let openedModelId: string | null = null;
    const manager = {
      getState: () => currentState,
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as unknown as ModelInstallManager;
    const parent = new TestElement();
    const modelControls = parent.createDiv();
    const readAloudControls = parent.createDiv();
    const readAloudBefore = readAloudControls.createDiv();
    const details = vi.fn(() => {
      openedModelId =
        currentState.selectedTtsModel?.kind === 'catalog_model'
          ? currentState.selectedTtsModel.modelId
          : null;
    });

    renderTextToSpeechSettings(
      modelControls as unknown as HTMLDivElement,
      readAloudControls as unknown as HTMLDivElement,
      readAloudBefore as unknown as HTMLElement,
      {
        getSettings: () => ({
          ...DEFAULT_PLUGIN_SETTINGS,
          selectedTtsModel: currentState.selectedTtsModel,
        }),
        manager,
        openSelectedModelDetails: details,
        openModelPicker: vi.fn(async () => {}),
        persistLanguage: vi.fn(async () => {}),
        persistVoice: vi.fn(async () => {}),
      },
    );

    expect(modelControls.findByClass('local-stt-model-summary-more')).toBeDefined();
    currentState = state(['alba'], null, 'pocket_tts_english_new', true);
    notify();
    await modelControls.findByClass('local-stt-model-summary-more')?.click();
    expect(Menu.lastItems.map((item) => item.title)).toEqual(['Model details']);
    Menu.lastItems[0]?.click();
    expect(openedModelId).toBe('pocket_tts_english_new');

    currentState = { ...state([]), catalog: { ...state([]).catalog, models: [] } };
    notify();
    expect(modelControls.findByClass('local-stt-model-summary-more')).toBeUndefined();
  });
});
