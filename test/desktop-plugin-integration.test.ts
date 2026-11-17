import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';

vi.mock('virtual:build-mode', () => ({ IS_PRODUCTION_BUILD: false }));
vi.mock('virtual:pcm-recorder-worklet-source', () => ({ PCM_RECORDER_WORKLET_SOURCE: '' }));
vi.mock('virtual:bergamot-worker-source', () => ({ BERGAMOT_WORKER_SOURCE: '' }));
vi.mock('electron', () => ({ shell: {} }));
vi.mock('obsidian', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Plugin: class {
    constructor(
      public app: unknown,
      public manifest: unknown,
    ) {}
  },
}));

import LocalSttPlugin from '../src/main';

interface PluginHarness {
  settings: typeof DEFAULT_PLUGIN_SETTINGS;
  desktopDisposed: boolean;
  handleDesktopProcessStop(unexpected: boolean): void;
  desktopRecoveryAttempted: boolean;
  desktopActionRevision: number;
  configureDesktop(): Promise<void>;
  desktopConfiguration: string;
  desktopGeneration: string;
  sidecarConnection: {
    configureDesktop: ReturnType<typeof vi.fn>;
    updateDesktopStatus: ReturnType<typeof vi.fn>;
  };
  desktopControls: { setGeneration: ReturnType<typeof vi.fn> };
  desktopConfigureQueue: Promise<void>;
}
function harness(): PluginHarness {
  return Object.assign(Object.create(LocalSttPlugin.prototype), {
    settings: { ...DEFAULT_PLUGIN_SETTINGS, desktopControlsEnabled: true },
    desktopDisposed: false,
    desktopConfiguration: '',
    desktopGeneration: '',
    desktopConfigureQueue: Promise.resolve(),
    desktopControls: { setGeneration: vi.fn() },
    sidecarConnection: { configureDesktop: vi.fn(async () => {}), updateDesktopStatus: vi.fn() },
    app: { vault: { getName: () => 'Private vault' } },
    publishDesktopStatus: vi.fn(),
    notifyDesktop: vi.fn(),
  });
}

afterEach(() => vi.unstubAllGlobals());
describe('installed plugin desktop orchestration', () => {
  it('does not report failure when a second desktop toggle cancels startup', async () => {
    const plugin = new LocalSttPlugin(
      {} as import('obsidian').App,
      { id: 'local-dictation' } as import('obsidian').PluginManifest,
    );
    let active = false;
    let finish!: () => void;
    const notify = vi.fn();
    const target = { file: { path: 'note.md' }, kind: 'active', view: {} };
    Object.assign(plugin, {
      settings: { ...DEFAULT_PLUGIN_SETTINGS, selectedModel: {} },
      desktopTarget: target,
      isDesktopTargetOpen: () => true,
      notifyDesktop: notify,
      dictationController: {
        isCaptureActive: () => active,
        startDictation: () => {
          active = true;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        stopDictation: async () => {
          active = false;
          finish();
        },
      },
    });
    const controls = (
      plugin as unknown as {
        desktopControls: import('../src/desktop/desktop-controls').DesktopControls;
      }
    ).desktopControls;
    controls.setGeneration('current');
    const starting = controls.handleAction({
      generation: 'current',
      actionId: 1,
      action: 'toggle',
    });
    await controls.handleAction({ generation: 'current', actionId: 2, action: 'toggle' });
    await starting;
    expect(notify).not.toHaveBeenCalled();
  });
  it('does not start the sidecar or request permission with defaults', async () => {
    const plugin = harness();
    const permission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: permission });
    await plugin.configureDesktop();
    expect(permission).not.toHaveBeenCalled();
    expect(plugin.sidecarConnection.configureDesktop).not.toHaveBeenCalled();
  });
  it('keeps saved OS preferences inert when desktop integration is disabled', async () => {
    const plugin = harness();
    Object.assign(plugin.settings, {
      desktopControlsEnabled: false,
      showDesktopStatusIcon: true,
      globalDictationShortcut: 'Control+Shift+D',
      playRecordingSounds: true,
    });
    const permission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: permission });
    await plugin.configureDesktop();
    expect(permission).not.toHaveBeenCalled();
    expect(plugin.sidecarConnection.configureDesktop).not.toHaveBeenCalled();
  });
  it('sends disable without deleting saved shortcut and icon choices', async () => {
    const plugin = harness();
    plugin.settings.showDesktopStatusIcon = true;
    plugin.settings.globalDictationShortcut = 'Control+Shift+D';
    vi.stubGlobal('Notification', { permission: 'denied' });
    await plugin.configureDesktop();
    Object.assign(plugin.settings, { desktopControlsEnabled: false });
    await plugin.configureDesktop();
    expect(plugin.sidecarConnection.configureDesktop).toHaveBeenLastCalledWith(
      expect.objectContaining({ showIcon: false, shortcut: null }),
    );
    expect(plugin.settings.globalDictationShortcut).toBe('Control+Shift+D');
    expect(plugin.settings.showDesktopStatusIcon).toBe(true);
  });
  it('invalidates actions immediately and performs one recovery after repeated exits', async () => {
    const plugin = harness();
    plugin.settings.showDesktopStatusIcon = true;
    vi.stubGlobal('Notification', { permission: 'denied' });
    plugin.handleDesktopProcessStop(true);
    expect(plugin.desktopControls.setGeneration).toHaveBeenCalledWith('disconnected');
    plugin.handleDesktopProcessStop(true);
    await plugin.desktopConfigureQueue;
    expect(plugin.sidecarConnection.configureDesktop).toHaveBeenCalledTimes(1);
    expect(plugin.desktopRecoveryAttempted).toBe(true);
  });
  it('never recovers an intentional stop or an exit after unload', async () => {
    const plugin = harness();
    plugin.settings.showDesktopStatusIcon = true;
    plugin.handleDesktopProcessStop(false);
    plugin.desktopDisposed = true;
    plugin.handleDesktopProcessStop(true);
    await plugin.desktopConfigureQueue;
    expect(plugin.sidecarConnection.configureDesktop).not.toHaveBeenCalled();
  });
  it('registers once for the same settings, and sends disable after opt-out', async () => {
    const plugin = harness();
    vi.stubGlobal('Notification', { permission: 'denied' });
    plugin.settings.showDesktopStatusIcon = true;
    await plugin.configureDesktop();
    await plugin.configureDesktop();
    expect(plugin.sidecarConnection.configureDesktop).toHaveBeenCalledTimes(1);
    plugin.settings.showDesktopStatusIcon = false;
    await plugin.configureDesktop();
    expect(plugin.sidecarConnection.configureDesktop).toHaveBeenLastCalledWith(
      expect.objectContaining({ showIcon: false, shortcut: null }),
    );
  });
  it('never registers after unloading during permission approval', async () => {
    const plugin = harness();
    plugin.settings.showDesktopStatusIcon = true;
    let approve!: () => void;
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    });
    const configuring = plugin.configureDesktop();
    await vi.waitFor(() => expect(approve).toBeDefined());
    plugin.desktopDisposed = true;
    approve();
    await configuring;
    expect(plugin.sidecarConnection.configureDesktop).not.toHaveBeenCalled();
  });
  it('drops an obsolete config if disabled while permission approval is pending', async () => {
    const plugin = harness();
    plugin.settings.showDesktopStatusIcon = true;
    let approve!: () => void;
    vi.stubGlobal('Notification', {
      permission: 'default',
      requestPermission: () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    });
    const configuring = plugin.configureDesktop();
    await vi.waitFor(() => expect(approve).toBeDefined());
    plugin.settings.showDesktopStatusIcon = false;
    const disabled = plugin.configureDesktop();
    approve();
    await configuring;
    await disabled;
    expect(plugin.sidecarConnection.configureDesktop).toHaveBeenCalledTimes(1);
    expect(plugin.sidecarConnection.configureDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ showIcon: false }),
    );
  });
});

it('does not open a different file when the original destination editor is reused', async () => {
  const sharedEditor = {};
  const originalFile = { path: 'A.md' };
  const replacementFile = { path: 'B.md' };
  const leaf = { view: { file: replacementFile, editor: { cm: sharedEditor } } };
  const revealLeaf = vi.fn();
  const focus = vi.fn();
  vi.stubGlobal('window', { focus });
  const plugin = new LocalSttPlugin(
    {
      workspace: { getLeavesOfType: () => [leaf], revealLeaf },
    } as unknown as import('obsidian').App,
    { id: 'local-dictation' } as import('obsidian').PluginManifest,
  );
  Object.assign(plugin, {
    desktopSessionTarget: { file: originalFile, view: sharedEditor },
    desktopTarget: { file: replacementFile, view: sharedEditor },
  });
  const controls = (
    plugin as unknown as {
      desktopControls: import('../src/desktop/desktop-controls').DesktopControls;
    }
  ).desktopControls;
  controls.setGeneration('current');
  await controls.handleAction({ generation: 'current', actionId: 1, action: 'open_target' });
  expect(revealLeaf).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
});

it('does not cache native registrations across an intentional process replacement', async () => {
  const plugin = harness();
  plugin.settings.showDesktopStatusIcon = true;
  vi.stubGlobal('Notification', { permission: 'denied' });
  await plugin.configureDesktop();
  const generation = plugin.desktopGeneration;
  plugin.handleDesktopProcessStop(false);
  expect(plugin.desktopControls.setGeneration).toHaveBeenCalledWith('disconnected');
  // A replacement-install cancellation stops then refreshes the sidecar outside
  // main's restartSidecarConnection wrapper. The new process has no OS resources.
  await plugin.configureDesktop();
  expect(plugin.sidecarConnection.configureDesktop).toHaveBeenCalledTimes(2);
  expect(plugin.desktopGeneration).not.toBe(generation);
});
