import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('virtual:bergamot-worker-source', () => ({
  BERGAMOT_WORKER_SOURCE: '',
}));

import type { CatalogModelRecord } from '../src/models/model-management-types';
import type { PluginSettings } from '../src/settings/plugin-settings';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import type { SidecarEvent } from '../src/sidecar/protocol';
import { TranslationController } from '../src/translation/translation-controller';
import { Modal, Setting, type TestElement } from './__mocks__/obsidian';

describe('TranslationController', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('explains why an empty note cannot be translated', () => {
    const show = vi.fn();
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show },
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      logger: { error: vi.fn() } as never,
      modelManager: {} as never,
      onReadAloud: vi.fn(),
      saveSettings: vi.fn(async () => {}),
    });
    const editor = {
      getValue: () => ' \n ',
    };

    controller.translateNote(editor as never);

    expect(show).toHaveBeenCalledExactlyOnceWith({
      intent: 'warning',
      key: 'translation-no-text',
      message: 'There is no text to translate in this note.',
    });
  });

  it('stays inert when no translation model is installed', async () => {
    Modal.instances.length = 0;
    Setting.reset();
    const worker = vi.fn();
    vi.stubGlobal('Worker', worker);
    const replaceRange = vi.fn();
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show: vi.fn() },
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      logger: { error: vi.fn() } as never,
      modelManager: {
        subscribe: () => () => {},
        getState: () => ({
          activeInstall: null,
          installRequestPending: false,
          catalog: { models: [] },
          installedModels: [],
        }),
      } as never,
      onReadAloud: vi.fn(),
      saveSettings: vi.fn(async () => {}),
    });
    const editor = {
      getValue: () => 'Translate this note.',
      replaceRange,
    };

    controller.translateNote(editor as never);

    await vi.waitFor(() => {
      expect(Modal.instances).toHaveLength(1);
      expect(Setting.buttonNamed('Dismiss')).toBeDefined();
    });
    expect(worker).not.toHaveBeenCalled();
    expect(replaceRange).not.toHaveBeenCalled();
  });

  it('detaches a long translation job, reopens it without duplicate inference, and keeps progress current', async () => {
    Modal.instances.length = 0;
    Setting.reset();
    const listeners: ((event: SidecarEvent) => void)[] = [];
    let translationId = '';
    const startTranslation = vi.fn(async (payload: { translationId: string }) => {
      translationId = payload.translationId;
    });
    const cancelTranslation = vi.fn();
    const setDetachedStatus = vi.fn();
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      translationStyle: 'formal' as const,
      translationStyleInstruction: 'formal, use usted',
      selectedTranslationModel: {
        familyId: 'tencent_hy_mt' as const,
        kind: 'catalog_model' as const,
        modelId: 'hy-mt',
        runtimeId: 'llama_cpp' as const,
      },
    };
    const model = {
      familyId: 'tencent_hy_mt',
      modelId: 'hy-mt',
      runtimeId: 'llama_cpp',
      task: 'translation',
      translationSupport: { kind: 'all_to_all', languages: ['en', 'es'] },
    };
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show: vi.fn() },
      getSettings: () => settings,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      modelManager: {
        subscribe: () => () => {},
        getState: () => ({
          activeInstall: null,
          installRequestPending: false,
          catalog: { models: [model] },
          selectedTranslationModel: settings.selectedTranslationModel,
          installedModels: [
            { familyId: 'tencent_hy_mt', modelId: 'hy-mt', runtimeId: 'llama_cpp' },
          ],
        }),
      } as never,
      onReadAloud: vi.fn(),
      saveSettings: vi.fn(async () => {}),
      setDetachedStatus,
      sidecarConnection: {
        cancelTranslation,
        startTranslation,
        subscribe: (next: (event: SidecarEvent) => void) => {
          listeners.push(next);
          return () => {};
        },
      } as never,
    });
    const editor = { getValue: () => 'Translate this note.', replaceRange: vi.fn() };

    controller.translateNote(editor as never);
    await vi.waitFor(() => expect(startTranslation).toHaveBeenCalledTimes(1));
    expect(startTranslation.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        styleInstruction: 'Use a formal register appropriate to the target language.',
      }),
    );
    Modal.instances.at(-1)?.close();
    expect(cancelTranslation).not.toHaveBeenCalled();
    expect(setDetachedStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'loading' }),
      expect.any(Function),
    );

    controller.translateNote(editor as never);
    expect(startTranslation).toHaveBeenCalledTimes(1);
    expect(Modal.instances).toHaveLength(2);
    listeners[0]?.({ type: 'translation_progress', translationId, completed: 1, total: 1 });
    listeners[0]?.({
      type: 'translation_complete',
      translationId,
      translations: ['Traduzca esta nota.'],
    });
    await vi.waitFor(() => expect(Setting.buttonNamed('Replace')).toBeDefined());
  });

  it('starts a fresh translation from the current note after it changed', async () => {
    Modal.instances.length = 0;
    Setting.reset();
    const listeners: ((event: SidecarEvent) => void)[] = [];
    const startTranslation = vi.fn(
      async (_payload: { texts: string[]; translationId: string }) => {},
    );
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      selectedTranslationModel: {
        familyId: 'tencent_hy_mt' as const,
        kind: 'catalog_model' as const,
        modelId: 'hy-mt',
        runtimeId: 'llama_cpp' as const,
      },
    };
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show: vi.fn() },
      getSettings: () => settings,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      modelManager: {
        subscribe: () => () => {},
        getState: () => ({
          activeInstall: null,
          installRequestPending: false,
          catalog: {
            models: [
              {
                familyId: 'tencent_hy_mt',
                modelId: 'hy-mt',
                runtimeId: 'llama_cpp',
                task: 'translation',
                translationSupport: { kind: 'all_to_all', languages: ['en', 'es'] },
              },
            ],
          },
          selectedTranslationModel: settings.selectedTranslationModel,
          installedModels: [
            { familyId: 'tencent_hy_mt', modelId: 'hy-mt', runtimeId: 'llama_cpp' },
          ],
        }),
      } as never,
      onReadAloud: vi.fn(),
      saveSettings: vi.fn(async () => {}),
      sidecarConnection: {
        cancelTranslation: vi.fn(),
        startTranslation,
        subscribe: (next: (event: SidecarEvent) => void) => {
          listeners.push(next);
          return () => {};
        },
      } as never,
    });
    let note = 'First version.';
    const editor = { getValue: () => note, replaceRange: vi.fn() };

    controller.translateNote(editor as never);
    await vi.waitFor(() => expect(startTranslation).toHaveBeenCalledTimes(1));
    const firstTranslationId = startTranslation.mock.calls[0]?.[0].translationId;
    if (firstTranslationId === undefined)
      throw new Error('Expected the first translation to start.');
    note = 'Updated version.';
    listeners[0]?.({
      type: 'translation_complete',
      translationId: firstTranslationId,
      translations: ['Versión inicial.'],
    });
    await vi.waitFor(() => expect(Setting.buttonNamed('Translate again')).toBeDefined());

    await Setting.buttonNamed('Translate again').click();

    await vi.waitFor(() => expect(startTranslation).toHaveBeenCalledTimes(2));
    expect(startTranslation.mock.calls[1]?.[0].texts).toEqual(['Updated version.']);
  });

  it('persists a swap and restores keyboard focus after synchronous controller notification', async () => {
    Modal.instances.length = 0;
    Setting.reset();
    const listeners: ((event: SidecarEvent) => void)[] = [];
    let translationId = '';
    const startTranslation = vi.fn(async (payload: { translationId: string }) => {
      translationId = payload.translationId;
    });
    const model = translationModel('hy-mt-1.8b', 'HY-MT 2 1.8B');
    const settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      selectedTranslationModel: selectionFor(model),
    };
    const saveSettings = vi.fn(async () => {});
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show: vi.fn() },
      getSettings: () => settings,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      modelManager: {
        subscribe: () => () => {},
        getState: () => ({
          activeInstall: null,
          installRequestPending: false,
          catalog: { models: [model] },
          installedModels: [installedRecord(model)],
          selectedTranslationModel: settings.selectedTranslationModel,
        }),
      } as never,
      onReadAloud: vi.fn(),
      saveSettings,
      sidecarConnection: {
        cancelTranslation: vi.fn(),
        startTranslation,
        subscribe: (next: (event: SidecarEvent) => void) => {
          listeners.push(next);
          return () => {};
        },
      } as never,
    });

    controller.translateNote({
      getValue: () => 'Translate this note.',
      replaceRange: vi.fn(),
    } as never);
    await vi.waitFor(() => expect(startTranslation).toHaveBeenCalledOnce());
    listeners[0]?.({
      type: 'translation_complete',
      translationId,
      translations: ['Traduzca esta nota.'],
    });
    await vi.waitFor(() => expect(Setting.buttonNamed('Replace')).toBeDefined());

    const modal = Modal.instances.at(-1);
    if (modal === undefined) throw new Error('Expected the translation preview modal.');
    const swap = (modal.contentEl as unknown as TestElement).querySelector(
      '.local-stt-translation-modal__swap',
    );
    swap?.focus();
    swap?.dispatchEvent({ key: ' ', type: 'keydown' });

    await vi.waitFor(() => {
      expect(saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          translationSourceLanguage: 'es',
          translationTargetLanguage: 'en',
        }),
      );
    });
    const renderedSwap = (modal.contentEl as unknown as TestElement).querySelector(
      '.local-stt-translation-modal__swap',
    );
    expect(renderedSwap).not.toBe(swap);
    expect(renderedSwap?.ownerDocument.activeElement).toBe(renderedSwap);
    expect(startTranslation).toHaveBeenCalledOnce();
  });

  it('keeps a failed B selection from rolling back a newer C selection', async () => {
    const race = createControllerSelectionRace();
    await race.openCompletedPreview();
    race.selectModel(race.modelB);
    race.selectModel(race.modelC);
    race.resolveC(true);
    await race.waitForModelC();

    await race.latestAction('Translate again').click();
    expect(race.startTranslation).toHaveBeenCalledTimes(2);
    expect(race.startTranslation.mock.calls[1]?.[0].modelSelection).toEqual(
      selectionFor(race.modelC),
    );

    race.rejectB(new Error('stale B probe failed'));
    await Promise.resolve();
    expect(race.settings.selectedTranslationModel).toEqual(selectionFor(race.modelC));
    expect(race.startTranslation).toHaveBeenCalledTimes(2);
  });

  it('reconciles an external C selection when the local B request fails', async () => {
    const race = createControllerSelectionRace();
    await race.openCompletedPreview();
    race.selectModel(race.modelB);
    race.selectExternalC();
    race.resolveExternalC(true);
    await vi.waitFor(() =>
      expect(race.settings.selectedTranslationModel).toEqual(selectionFor(race.modelC)),
    );

    race.rejectB(new Error('local B probe failed'));
    await race.waitForModel(race.modelC);
    await race.waitForFreshRetry();
    expect(race.startTranslation).toHaveBeenCalledOnce();

    await race.latestAction('Translate again').click();
    expect(race.startTranslation).toHaveBeenCalledTimes(2);
    expect(race.startTranslation.mock.calls[1]?.[0].modelSelection).toEqual(
      selectionFor(race.modelC),
    );
  });

  it('reconciles an external B selection when the modal-owned B request returns false', async () => {
    const race = createControllerSelectionRace();
    await race.openCompletedPreview();
    race.selectModel(race.modelB);
    race.selectExternalB();
    race.resolveExternalB(true);
    await vi.waitFor(() =>
      expect(race.settings.selectedTranslationModel).toEqual(selectionFor(race.modelB)),
    );

    race.resolveB(false);
    await race.waitForModel(race.modelB);
    await race.waitForFreshRetry();
    expect(race.startTranslation).toHaveBeenCalledOnce();

    await race.latestAction('Translate again').click();
    expect(race.startTranslation).toHaveBeenCalledTimes(2);
    expect(race.startTranslation.mock.calls[1]?.[0].modelSelection).toEqual(
      selectionFor(race.modelB),
    );
  });

  it('reopens a completed selection without starting duplicate inference', async () => {
    const race = createControllerSelectionRace();
    await race.openCompletedPreview();
    Modal.instances.at(-1)?.close();
    race.reopen();

    expect(race.startTranslation).toHaveBeenCalledOnce();
    expect(race.modelDropdownDisabled()).toBe(false);
    expect(race.latestAction('Replace').disabled).toBe(false);
  });

  it('reconciles a closed modal with a selection committed after reopen', async () => {
    const race = createControllerSelectionRace();
    await race.openCompletedPreview();
    race.selectModel(race.modelB);
    Modal.instances.at(-1)?.close();

    race.reopen();
    expect(race.startTranslation).toHaveBeenCalledOnce();
    expect(race.modelDropdownDisabled()).toBe(true);
    expect(race.swapDisabled()).toBe(true);

    race.resolveB(true);
    await race.waitForModel(race.modelB);
    expect(race.modelDropdownDisabled()).toBe(false);
    expect(race.swapDisabled()).toBe(false);
    expect(race.settings.selectedTranslationModel).toEqual(selectionFor(race.modelB));

    await race.latestAction('Translate again').click();
    expect(race.startTranslation).toHaveBeenCalledTimes(2);
    expect(race.startTranslation.mock.calls[1]?.[0].modelSelection).toEqual(
      selectionFor(race.modelB),
    );
  });

  it('reconciles a newer C selection instead of committing a stale pack probe', async () => {
    Modal.instances.length = 0;
    Setting.reset();
    const modelA = translationModel('model-a', 'Model A');
    const modelC = translationModel('model-c', 'Model C');
    const modelB = {
      ...translationModel('firefox-pack', 'Firefox Pack'),
      artifacts: [
        {
          artifactId: 'en-es-pack',
          downloadUrl: 'https://example.com/en-es-pack',
          filename: 'en-es-pack',
          required: false,
          role: 'translation_model' as const,
          sha256: '1'.repeat(64),
          sizeBytes: 10,
        },
      ],
      familyId: 'firefox_translations' as const,
      runtimeId: 'bergamot_wasm' as const,
      translationPacks: [
        { artifactIds: ['en-es-pack'], source: 'en' as const, target: 'es' as const },
      ],
      translationSupport: {
        kind: 'pairs' as const,
        pairs: [
          { source: 'en' as const, target: 'es' as const },
          { source: 'es' as const, target: 'en' as const },
        ],
      },
    } as CatalogModelRecord;
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      selectedTranslationModel: selectionFor(modelB),
    };
    let installedB = false;
    const install = deferred<void>();
    const packProbe = deferred<{ committed: boolean }>();
    const cProbe = deferred<{ committed: boolean }>();
    const listeners: ((event: SidecarEvent) => void)[] = [];
    const modelManagerListeners: (() => void)[] = [];
    const startTranslation = vi.fn(
      async (_payload: { modelSelection: unknown; translationId: string }) => {},
    );
    const modelManager = {
      getState: () => ({
        activeInstall: null,
        catalog: { models: [modelA, modelB, modelC] },
        installedModels: [modelA, modelC, ...(installedB ? [modelB] : [])],
        installRequestPending: false,
        selectedTranslationModel: settings.selectedTranslationModel,
      }),
      installAndWait: vi.fn(() => install.promise),
      select: vi.fn((selection: ReturnType<typeof selectionFor>) => {
        if (selection.modelId === modelB.modelId)
          return packProbe.promise.then((result) => {
            if (result.committed)
              settings = { ...settings, selectedTranslationModel: selectionFor(modelB) };
            return result;
          });
        return cProbe.promise.then((result) => {
          if (result.committed) {
            settings = { ...settings, selectedTranslationModel: selectionFor(modelC) };
            for (const listener of modelManagerListeners) listener();
          }
          return result;
        });
      }),
      subscribe: (listener: () => void) => {
        modelManagerListeners.push(listener);
        return () => {
          modelManagerListeners.splice(modelManagerListeners.indexOf(listener), 1);
        };
      },
    };
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show: vi.fn() },
      getSettings: () => settings,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      modelManager: modelManager as never,
      onReadAloud: vi.fn(),
      saveSettings: vi.fn(async () => {}),
      sidecarConnection: {
        cancelTranslation: vi.fn(),
        startTranslation,
        subscribe: (next: (event: SidecarEvent) => void) => {
          listeners.push(next);
          return () => {};
        },
      } as never,
    });
    const editor = { getValue: () => 'Translate this note.', replaceRange: vi.fn() };

    controller.translateNote(editor as never);
    await vi.waitFor(() =>
      expect(Setting.buttonNamed('Download language pack · 10 B')).toBeDefined(),
    );
    await Setting.buttonNamed('Download language pack · 10 B').click();
    expect(modelManager.installAndWait).toHaveBeenCalledOnce();
    expect(modelManager.select).not.toHaveBeenCalled();

    Modal.instances.at(-1)?.close();
    controller.translateNote(editor as never);
    expect(startTranslation).not.toHaveBeenCalled();
    expect(
      Setting.instances.filter((setting) => setting.name === 'Translation model').at(-1)
        ?.dropdownComponents[0]?.selectEl.disabled,
    ).toBe(true);

    installedB = true;
    install.resolve();
    await vi.waitFor(() => expect(modelManager.select).toHaveBeenCalledWith(selectionFor(modelB)));
    expect(
      Setting.instances.filter((setting) => setting.name === 'Translation model').at(-1)
        ?.dropdownComponents[0]?.selectEl.disabled,
    ).toBe(true);
    void modelManager.select(selectionFor(modelC));
    cProbe.resolve({ committed: true });
    await vi.waitFor(() => {
      const dropdown = Setting.instances
        .filter((setting) => setting.name === 'Translation model')
        .at(-1)?.dropdownComponents[0];
      expect(dropdown?.selectEl.value).toBe(translationModelKey(modelC));
      expect(dropdown?.selectEl.disabled).toBe(true);
    });
    expect(settings.selectedTranslationModel).toEqual(selectionFor(modelC));

    packProbe.resolve({ committed: false });
    await vi.waitFor(() => {
      const action = Setting.instances
        .filter((setting) => setting.buttonComponents.length > 0)
        .at(-1)
        ?.buttonComponents.find((button) => button.text === 'Translate again');
      expect(action?.disabled).toBe(false);
    });
    await Setting.instances
      .filter((setting) => setting.buttonComponents.length > 0)
      .at(-1)
      ?.buttonComponents.find((button) => button.text === 'Translate again')
      ?.click();
    expect(startTranslation).toHaveBeenCalledOnce();
    expect(startTranslation.mock.calls[0]?.[0].modelSelection).toEqual(selectionFor(modelC));
    expect(settings.selectedTranslationModel).toEqual(selectionFor(modelC));
  });

  it('ignores a stale successful B selection after C has already won', async () => {
    const race = createControllerSelectionRace();
    await race.openCompletedPreview();
    race.selectModel(race.modelB);
    race.selectModel(race.modelC);
    race.resolveC(true);
    await race.waitForModelC();
    race.resolveB(false);

    await race.latestAction('Translate again').click();
    expect(race.startTranslation).toHaveBeenCalledTimes(2);
    expect(race.startTranslation.mock.calls[1]?.[0].modelSelection).toEqual(
      selectionFor(race.modelC),
    );
    expect(race.settings.selectedTranslationModel).toEqual(selectionFor(race.modelC));
  });

  it('lists only installed translation models without a model-management action', async () => {
    Modal.instances.length = 0;
    Setting.reset();
    const listeners: ((event: SidecarEvent) => void)[] = [];
    let translationId = '';
    const startTranslation = vi.fn(async (payload: { translationId: string }) => {
      translationId = payload.translationId;
    });
    const firstModel = translationModel('hy-mt-1.8b', 'HY-MT 2 1.8B');
    const secondModel = translationModel('hy-mt-7b', 'HY-MT 2 7B');
    const settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      selectedTranslationModel: selectionFor(firstModel),
    };
    const controller = new TranslationController({
      app: {} as never,
      canReadAloud: () => false,
      feedback: { show: vi.fn() },
      getSettings: () => settings,
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      modelManager: {
        subscribe: () => () => {},
        getState: () => ({
          activeInstall: null,
          installRequestPending: false,
          catalog: { models: [firstModel, secondModel] },
          installedModels: [installedRecord(firstModel)],
          selectedTranslationModel: settings.selectedTranslationModel,
        }),
      } as never,
      onReadAloud: vi.fn(),
      saveSettings: vi.fn(async () => {}),
      sidecarConnection: {
        cancelTranslation: vi.fn(),
        startTranslation,
        subscribe: (next: (event: SidecarEvent) => void) => {
          listeners.push(next);
          return () => {};
        },
      } as never,
    });
    const editor = { getValue: () => 'Translate this note.', replaceRange: vi.fn() };

    controller.translateNote(editor as never);
    await vi.waitFor(() => expect(startTranslation).toHaveBeenCalledOnce());
    listeners[0]?.({
      type: 'translation_complete',
      translationId,
      translations: ['Traduzca esta nota.'],
    });
    await vi.waitFor(() => expect(Setting.buttonNamed('Replace')).toBeDefined());

    const modelSetting = Setting.instances
      .filter((setting) => setting.name === 'Translation model')
      .at(-1);
    expect(
      modelSetting?.dropdownComponents[0]?.selectEl.options.map((option) => option.label),
    ).toEqual(['HY-MT 2 1.8B', 'Choose a translation model']);
    expect(modelSetting?.buttonComponents).toHaveLength(0);
  });
});

function createControllerSelectionRace() {
  Modal.instances.length = 0;
  Setting.reset();
  const modelA = translationModel('model-a', 'Model A');
  const modelB = translationModel('model-b', 'Model B');
  const modelC = translationModel('model-c', 'Model C');
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    selectedTranslationModel: selectionFor(modelA),
  };
  const secondProbe = deferred<{ committed: boolean }>();
  const thirdProbe = deferred<{ committed: boolean }>();
  const externalBProbe = deferred<{ committed: boolean }>();
  const externalCProbe = deferred<{ committed: boolean }>();
  const listeners: ((event: SidecarEvent) => void)[] = [];
  const modelManagerListeners: (() => void)[] = [];
  let translationId = '';
  const startTranslation = vi.fn(
    async (payload: { modelSelection: unknown; translationId: string }) => {
      translationId = payload.translationId;
    },
  );
  const saveSettings = vi.fn(async (next: PluginSettings) => {
    settings = next;
  });
  const modelManager = {
    getState: () => ({
      activeInstall: null,
      catalog: { models: [modelA, modelB, modelC] },
      installedModels: [installedRecord(modelA), installedRecord(modelB), installedRecord(modelC)],
      installRequestPending: false,
      selectedTranslationModel: settings.selectedTranslationModel,
    }),
    select: vi.fn(
      (selection: ReturnType<typeof selectionFor>, source: 'local' | 'external' = 'local') => {
        const probe =
          selection.modelId === modelB.modelId
            ? source === 'external'
              ? externalBProbe
              : secondProbe
            : source === 'external'
              ? externalCProbe
              : thirdProbe;
        return probe.promise.then((result) => {
          if (result.committed) {
            settings = {
              ...settings,
              selectedTranslationModel: selectionFor(
                selection.modelId === modelB.modelId ? modelB : modelC,
              ),
            };
            for (const listener of modelManagerListeners) listener();
          }
          return result;
        });
      },
    ),
    subscribe: (listener: () => void) => {
      modelManagerListeners.push(listener);
      return () => {
        modelManagerListeners.splice(modelManagerListeners.indexOf(listener), 1);
      };
    },
  };
  const controller = new TranslationController({
    app: {} as never,
    canReadAloud: () => false,
    feedback: { show: vi.fn() },
    getSettings: () => settings,
    logger: { error: vi.fn(), warn: vi.fn() } as never,
    modelManager: modelManager as never,
    onReadAloud: vi.fn(),
    saveSettings,
    sidecarConnection: {
      cancelTranslation: vi.fn(),
      startTranslation,
      subscribe: (next: (event: SidecarEvent) => void) => {
        listeners.push(next);
        return () => {};
      },
    } as never,
  });

  return {
    modelB,
    modelC,
    get settings() {
      return settings;
    },
    startTranslation,
    async openCompletedPreview() {
      controller.translateNote({
        getValue: () => 'Translate this note.',
        replaceRange: vi.fn(),
      } as never);
      await vi.waitFor(() => expect(startTranslation).toHaveBeenCalledOnce());
      listeners[0]?.({
        type: 'translation_complete',
        translationId,
        translations: ['Translated with Model A.'],
      });
      await vi.waitFor(() => expect(Setting.buttonNamed('Replace')).toBeDefined());
    },
    reopen() {
      controller.translateNote({
        getValue: () => 'Translate this note.',
        replaceRange: vi.fn(),
      } as never);
    },
    modelDropdownDisabled() {
      return (
        Setting.instances.filter((setting) => setting.name === 'Translation model').at(-1)
          ?.dropdownComponents[0]?.selectEl.disabled ?? false
      );
    },
    swapDisabled() {
      const modal = Modal.instances.at(-1);
      if (modal === undefined) throw new Error('Expected the translation preview modal.');
      return (
        (modal.contentEl as unknown as TestElement).querySelector(
          '.local-stt-translation-modal__swap',
        )?.disabled ?? false
      );
    },
    resolveB(committed: boolean) {
      secondProbe.resolve({ committed });
    },
    rejectB(error: Error) {
      secondProbe.reject(error);
    },
    resolveC(committed: boolean) {
      thirdProbe.resolve({ committed });
    },
    selectExternalB() {
      void modelManager.select(selectionFor(modelB), 'external');
    },
    resolveExternalB(committed: boolean) {
      externalBProbe.resolve({ committed });
    },
    selectExternalC() {
      void modelManager.select(selectionFor(modelC), 'external');
    },
    resolveExternalC(committed: boolean) {
      externalCProbe.resolve({ committed });
    },
    async waitForFreshRetry() {
      await vi.waitFor(() => {
        const action = Setting.instances
          .filter((setting) => setting.buttonComponents.length > 0)
          .at(-1)
          ?.buttonComponents.find((button) => button.text === 'Translate again');
        expect(action?.disabled).toBe(false);
      });
    },
    selectModel(model: ReturnType<typeof translationModel>) {
      const modal = Modal.instances.at(-1);
      if (modal === undefined) throw new Error('Expected the translation preview modal.');
      const dropdown = Setting.instances
        .filter((setting) => setting.name === 'Translation model')
        .at(-1)?.dropdownComponents[0];
      const option = dropdown?.selectEl.options.find(
        (candidate) => candidate.value === translationModelKey(model),
      );
      if (dropdown === undefined || option === undefined) {
        throw new Error(`Model option not found: ${model.displayName}`);
      }
      dropdown.change(option.value);
    },
    async waitForModel(model: ReturnType<typeof translationModel>) {
      await vi.waitFor(() => {
        const dropdown = Setting.instances
          .filter((setting) => setting.name === 'Translation model')
          .at(-1)?.dropdownComponents[0];
        expect(dropdown?.selectEl.value).toBe(translationModelKey(model));
      });
    },
    async waitForModelC() {
      await this.waitForModel(modelC);
      await vi.waitFor(() => {
        const action = Setting.instances
          .filter((setting) => setting.buttonComponents.length > 0)
          .at(-1)
          ?.buttonComponents.find((button) => button.text === 'Translate again');
        expect(action?.disabled).toBe(false);
      });
    },
    latestAction(label: string) {
      const action = Setting.instances
        .filter((setting) => setting.buttonComponents.length > 0)
        .at(-1)
        ?.buttonComponents.find((button) => button.text === label);
      if (action === undefined) throw new Error(`Action not found: ${label}`);
      return action;
    },
  };
}

function translationModelKey(model: CatalogModelRecord): string {
  return JSON.stringify([model.runtimeId, model.familyId, model.modelId]);
}

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
} {
  let rejectPromise = (_error: unknown) => {};
  let resolvePromise = (_value: T) => {};
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function translationModel(modelId: string, displayName: string) {
  return {
    artifacts: [],
    collectionId: 'translation',
    displayName,
    familyId: 'tencent_hy_mt' as const,
    languageTags: ['en', 'es'],
    licenseLabel: 'Apache-2.0',
    licenseUrl: 'https://example.com/license',
    modelCardUrl: null,
    modelId,
    notes: [],
    runtimeId: 'llama_cpp' as const,
    sourceUrl: 'https://example.com/model',
    summary: 'Local translation',
    supportsAutomaticLanguageDetection: false,
    task: 'translation' as const,
    translationSupport: { kind: 'all_to_all' as const, languages: ['en', 'es'] },
    uxTags: [],
  };
}

function selectionFor(model: CatalogModelRecord) {
  return {
    familyId: model.familyId,
    kind: 'catalog_model' as const,
    modelId: model.modelId,
    runtimeId: model.runtimeId,
  };
}

function installedRecord(model: CatalogModelRecord) {
  return {
    familyId: model.familyId,
    modelId: model.modelId,
    runtimeId: model.runtimeId,
  };
}
