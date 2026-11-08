import { afterEach, describe, expect, it, vi } from 'vitest';

import { ManageModelsModal } from '../src/models/manage-models-modal';
import { ModelInstallManager } from '../src/models/model-install-manager';
import type { EngineCapabilitiesRecord } from '../src/models/model-management-types';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type { SidecarEvent } from '../src/sidecar/protocol';
import { SidecarLifecycleGate } from '../src/sidecar/sidecar-lifecycle-gate';
import { Setting, TestElement } from './__mocks__/obsidian';
import { sampleCatalog } from './fixtures/catalog';
import {
  sampleModelStore,
  sampleMoonshineInstalledModel,
  sampleMoonshineInstallUpdate,
  sampleMoonshineSelection,
} from './fixtures/models';

afterEach(() => vi.unstubAllGlobals());

async function openSingleModelPicker() {
  Setting.reset();
  vi.stubGlobal('createDiv', () => new TestElement());
  vi.stubGlobal('createSpan', () => new TestElement());
  vi.stubGlobal('createFragment', () => new TestElement());
  const selection = sampleMoonshineSelection();
  const catalog = sampleCatalog();
  catalog.models = catalog.models.filter((model) => model.familyId === 'moonshine');
  const capabilities: EngineCapabilitiesRecord = {
    family: {
      availableVoices: [],
      maxAudioDurationSecs: null,
      outputSampleRate: null,
      producesPunctuation: true,
      supportedLanguages: { kind: 'english_only' },
      supportsAutomaticLanguageDetection: false,
      supportsHardwareAcceleration: false,
      supportsInitialPrompt: false,
      supportsLanguageSelection: false,
      supportsSegmentTimestamps: false,
      supportsSpeedControl: false,
      supportsStreaming: true,
      supportsWordTimestamps: false,
      task: 'stt',
    },
    familyId: 'moonshine',
    runtime: {
      acceleratorDetails: { cpu: { available: true, unavailableReason: null } },
      availableAccelerators: ['cpu'],
      supportedModelFormats: ['onnx'],
    },
    runtimeId: 'onnx_runtime',
  };
  let settings: PluginSettings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    selectedModel: selection,
    selectedModelCapabilitiesSnapshot: { capabilities, selection },
  };
  const listeners = new Set<(event: SidecarEvent) => void>();
  const sidecar = {
    cancelModelInstall: vi.fn(),
    getModelStore: vi.fn().mockResolvedValue(sampleModelStore()),
    getSystemInfo: vi.fn().mockResolvedValue({
      compiledAdapters: [
        {
          displayName: 'Moonshine',
          familyCapabilities: capabilities.family,
          familyId: 'moonshine',
          runtimeId: 'onnx_runtime',
        },
      ],
      compiledRuntimes: [
        {
          displayName: 'ONNX Runtime',
          runtimeCapabilities: capabilities.runtime,
          runtimeId: 'onnx_runtime',
        },
      ],
    }),
    installModel: vi.fn(async (request: { installId: string }) => ({
      ...sampleMoonshineInstallUpdate({ installId: request.installId, state: 'queued' }),
      type: 'model_install_update' as const,
    })),
    listInstalledModels: vi.fn().mockResolvedValue({ models: [sampleMoonshineInstalledModel()] }),
    listModelCatalog: vi.fn().mockResolvedValue(catalog),
    probeModelSelection: vi.fn(),
    removeModel: vi.fn(),
    shutdown: vi.fn(async () => {}),
    subscribe: (listener: (event: SidecarEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeProcessStop: () => () => {},
  };
  const gate = new SidecarLifecycleGate();
  const manager = new ModelInstallManager({
    commitSettingsIf: async (condition, next) => {
      if (!condition(settings)) return false;
      settings = next(settings);
      return true;
    },
    getSettings: () => settings,
    sidecarConnection: sidecar,
    sidecarLifecycleGate: gate,
  });
  await manager.init();
  const feedback = { show: vi.fn() };
  const modal = new ManageModelsModal({} as never, {
    feedback,
    manager,
    onChanged: vi.fn(),
  });
  modal.open();
  return {
    emit: (event: SidecarEvent) => {
      for (const listener of listeners) listener(event);
    },
    feedback,
    gate,
    manager,
    modal,
    selection,
    sidecar,
  };
}

describe('model reinstall UI', () => {
  it.each(['speech', 'use'] as const)(
    'explains active %s work without starting or removing a model',
    async (activeKind) => {
      const picker = await openSingleModelPicker();
      const lease =
        activeKind === 'speech' ? picker.gate.acquireSpeech() : picker.gate.acquireUse();
      try {
        await Setting.buttonNamed('Reinstall').click();
        await vi.waitFor(() =>
          expect(picker.feedback.show).toHaveBeenCalledWith({
            intent: 'warning',
            message:
              'Stop dictation, transcription, translation, or Read aloud first. A model is in use.',
          }),
        );
        expect(picker.sidecar.installModel).not.toHaveBeenCalled();
        expect(picker.sidecar.removeModel).not.toHaveBeenCalled();
        expect(picker.manager.getState().selectedModel).toEqual(picker.selection);
      } finally {
        lease.release();
        picker.modal.close();
        picker.manager.dispose();
      }
    },
  );

  it('reinstalls the only installed selected model without removing it and keeps Cancel usable', async () => {
    const picker = await openSingleModelPicker();
    try {
      await Setting.buttonNamed('Reinstall').click();
      await vi.waitFor(() => expect(picker.sidecar.installModel).toHaveBeenCalledOnce());
      const request = picker.sidecar.installModel.mock.calls[0]?.[0];
      if (request === undefined) throw new Error('Expected a reinstall request');
      picker.emit({
        ...sampleMoonshineInstallUpdate({ installId: request.installId }),
        type: 'model_install_update',
      });
      const cancel = () =>
        Setting.instances
          .flatMap((setting) => setting.buttonComponents)
          .reverse()
          .find((button) => button.text === 'Cancel');
      await vi.waitFor(() => expect(cancel()?.disabled).toBe(false));
      await cancel()?.click();
      expect(picker.sidecar.cancelModelInstall).toHaveBeenCalledWith(request.installId);
      expect(picker.sidecar.removeModel).not.toHaveBeenCalled();
      expect(picker.manager.getState().installedModels).toHaveLength(1);
      expect(picker.manager.getState().selectedModel).toEqual(picker.selection);
      picker.emit({
        ...sampleMoonshineInstallUpdate({ installId: request.installId, state: 'cancelled' }),
        type: 'model_install_update',
      });
      expect(picker.manager.getState().installedModels).toHaveLength(1);
      expect(picker.manager.getState().selectedModel).toEqual(picker.selection);
    } finally {
      picker.modal.close();
      picker.manager.dispose();
    }
  });
});
