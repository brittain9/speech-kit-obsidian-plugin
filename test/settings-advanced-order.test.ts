import type { App, Plugin } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelInstallManager } from '../src/models/model-install-manager';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { LocalSttSettingTab } from '../src/settings/settings-tab';
import { Setting, type TestElement } from './__mocks__/obsidian';

const sidecar = vi.hoisted(() => ({ refresh: () => {}, dispose: vi.fn() }));
vi.mock('../src/settings/settings-sidecar-surfaces', () => ({
  mountSettingsSidecarSurfaces: (_attention: unknown, parent: TestElement) => {
    sidecar.refresh = () => {
      parent.empty();
      new Setting(parent).setName('Installed sidecars');
    };
    return sidecar.dispose;
  },
}));
vi.mock('../src/settings/model-settings-section', () => ({ renderModelSection: () => () => {} }));
vi.mock('../src/settings/microphone-picker', () => ({ renderMicrophonePicker: () => () => {} }));
vi.mock('../src/audio/media-tool-installer', () => ({ isMediaToolInstalled: async () => false }));

afterEach(() => Setting.reset());

it('puts tool discovery before setup/repair and leaves technical overrides last after an async refresh', async () => {
  const settings = {
    ...DEFAULT_PLUGIN_SETTINGS,
    llmFeaturesEnabled: false,
    translationEnabled: false,
    readAloudEnabled: false,
  };
  const openSetupWizard = vi.fn(async () => {});
  const openSpeechKit = vi.fn(async () => {});
  const tab = new LocalSttSettingTab({} as App, {} as Plugin, {
    feedback: { show: vi.fn() },
    getSettings: () => settings,
    getSecret: () => '',
    mutateLlmSettings: vi.fn(async () => {}),
    mutatePresetState: vi.fn(async () => {}),
    synchronizePresets: vi.fn(async () => {}),
    isDictationBusy: () => false,
    modelInstallManager: {
      getState: () => ({
        selectedModelCapabilities: { status: 'none' },
        catalog: { models: [], families: [], collections: [] },
      }),
      subscribe: () => () => {},
    } as unknown as ModelInstallManager,
    openModelPicker: vi.fn(async () => {}),
    openSetupWizard,
    openSpeechKit,
    sidecarVersion: '2026.11.1',
    resolvePluginDirectory: async () => '/test-plugin',
    resetLlmTransformation: vi.fn(async () => {}),
    restartSidecar: vi.fn(async () => {}),
    sidecarConnection: {} as never,
    sidecarInstallManager: {} as never,
    sidecarLifecycleGate: {} as never,
  });
  tab.display();
  // The real sidecar surface owns an independently refreshed child container.
  // Deliver its result after every static Advanced row has already mounted.
  await Promise.resolve();
  sidecar.refresh();
  const heading = Setting.named('Advanced');
  const items = heading.settingEl.parentElement?.children.find((child) =>
    child.className.includes('setting-items'),
  );
  const names = items?.querySelectorAll('.setting-item-name').map((row) => row.textContent);
  expect(names).toEqual([
    'Customize tools',
    'Speech Kit controls',
    'Run setup',
    'Installed sidecars',
    'Media decoder',
    'Keep recovery text in memory',
    'Developer mode',
    'Model store folder override',
  ]);
  sidecar.refresh();
  expect(items?.querySelectorAll('.setting-item-name').map((row) => row.textContent)).toEqual(
    names,
  );
  await Setting.buttonNamed('Run setup').click();
  await Setting.buttonNamed('Open Speech Kit').click();
  expect(openSetupWizard).toHaveBeenCalledOnce();
  expect(openSpeechKit).toHaveBeenCalledOnce();
  tab.hide();
  expect(sidecar.dispose).toHaveBeenCalledOnce();
});
