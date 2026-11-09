import type { App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createProviderMock } = vi.hoisted(() => ({ createProviderMock: vi.fn() }));

vi.mock('../src/llm/provider-factory', () => {
  return { createProvider: createProviderMock };
});

import { MIN_OUTPUT_TOKENS } from '../src/llm/output-budget';
import { ProviderError } from '../src/llm/provider';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import { LlmRoutingControls } from '../src/ui/llm-routing-controls';
import { Setting as MockSetting, SecretComponent, TestElement } from './__mocks__/obsidian';
import { createFakeLlmProvider } from './fixtures/llm';

function createControls(overrides: Partial<PluginSettings> = {}, secret = '') {
  const show = vi.fn();
  const persist = vi.fn(async (_settings: PluginSettings, _options?: { rerender?: boolean }) => {});
  const controls = new LlmRoutingControls({
    app: {} as App,
    feedback: { show },
    getSecret: () => secret,
    getSettings: () => ({ ...DEFAULT_PLUGIN_SETTINGS, ...overrides }),
    persist: async (mutation, options) =>
      persist(mutation({ ...DEFAULT_PLUGIN_SETTINGS, ...overrides }), options),
  });
  return { controls, persist, show };
}

beforeEach(() => {
  MockSetting.reset();
  SecretComponent.reset();
  createProviderMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LlmRoutingControls.render', () => {
  it('does not contact a provider merely by showing configuration while transformation is off', () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmFeaturesEnabled: true,
      llmPostprocessMode: 'off' as const,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'ollama' as const },
    };
    const listModels = vi.fn(async () => []);
    createProviderMock.mockReturnValue(createFakeLlmProvider({ listModels }));
    const { controls } = createControls(settings);
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('applies a model edit to the latest settings when another setting changes before save', async () => {
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openai_compatible' as const },
    };
    let commit!: () => void;
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: async (mutation) => {
        await new Promise<void>((resolve) => {
          commit = resolve;
        });
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    MockSetting.named('Model').onlyText().change('new-model');
    settings = { ...settings, llmNetworkTimeoutSec: 42 };
    commit();
    await vi.waitFor(() =>
      expect(settings.llmProviderConfigurations.openai_compatible.model).toBe('new-model'),
    );
    expect(settings.llmNetworkTimeoutSec).toBe(42);
  });

  it('preserves a newer routing threshold when changing the default provider', async () => {
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: {
        kind: 'transcript_size',
        defaultProviderId: 'ollama',
        largeTranscriptProviderId: 'openrouter',
        thresholdChars: 6000,
      },
    };
    let commit!: () => void;
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: async (mutation) => {
        await new Promise<void>((resolve) => {
          commit = resolve;
        });
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    MockSetting.named('Default provider').onlyDropdown().change('openai_compatible');
    settings = {
      ...settings,
      llmRoutingPolicy: {
        kind: 'transcript_size',
        defaultProviderId: 'ollama',
        largeTranscriptProviderId: 'openrouter',
        thresholdChars: 7000,
      },
    };
    commit();
    await vi.waitFor(() =>
      expect(settings.llmRoutingPolicy).toMatchObject({
        defaultProviderId: 'openai_compatible',
        thresholdChars: 7000,
      }),
    );
  });

  it('does not prewarm a model if the host closes while its selection saves', async () => {
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmFeaturesEnabled: true,
      llmPostprocessMode: 'per_utterance',
      llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
    };
    let finish!: () => void;
    const prewarmModel = vi.fn(async () => {});
    createProviderMock.mockReturnValue(createFakeLlmProvider({ prewarmModel }));
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: async (mutation) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    MockSetting.named('Ollama model').onlyDropdown().change('model');
    controls.dispose();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(prewarmModel).not.toHaveBeenCalled();
  });

  it('starts with one empty provider picker for an unconfigured installation', () => {
    const { controls } = createControls();

    controls.render(new TestElement() as unknown as HTMLElement, DEFAULT_PLUGIN_SETTINGS);

    const provider = MockSetting.named('Provider').onlyDropdown();
    expect(provider.selectEl.value).toBe('');
    expect(MockSetting.named('Provider').descEl.textContent).toContain('Audio is never sent.');
    expect(provider.selectEl.options.map((option) => option.label)).toEqual([
      'Choose a provider',
      'Ollama',
      'OpenRouter',
      'OpenAI-compatible',
    ]);
    expect(MockSetting.instances.map((setting) => setting.name)).not.toContain(
      'Use a different provider for large transcripts',
    );
  });

  it('reveals custom endpoint fields only when that provider is selected', () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openai_compatible' as const },
    };
    const { controls } = createControls(settings);

    controls.render(new TestElement() as unknown as HTMLElement, settings);

    expect(MockSetting.instances.map((setting) => setting.name)).toEqual(
      expect.arrayContaining(['Provider', 'Base URL', 'API key', 'Model']),
    );
    expect(MockSetting.instances.map((setting) => setting.name)).not.toContain('Ollama model');
  });

  it('excludes the default provider from the large-transcript picker', () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: {
        defaultProviderId: 'ollama' as const,
        kind: 'transcript_size' as const,
        largeTranscriptProviderId: 'openrouter' as const,
        thresholdChars: 6_000,
      },
    };
    const { controls } = createControls(settings);

    controls.render(new TestElement() as unknown as HTMLElement, settings);

    expect(
      MockSetting.named('Large-transcript provider')
        .onlyDropdown()
        .selectEl.options.map((option) => option.value),
    ).toEqual(['openrouter', 'openai_compatible']);
  });

  it('keeps the large-transcript threshold beside the routing controls', async () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: {
        defaultProviderId: 'ollama' as const,
        kind: 'transcript_size' as const,
        largeTranscriptProviderId: 'openrouter' as const,
        thresholdChars: 6_000,
      },
    };
    const { controls, persist } = createControls(settings);

    controls.render(new TestElement() as unknown as HTMLElement, settings);
    MockSetting.named('Large transcript threshold').onlyText().change('7000');

    await vi.waitFor(() => {
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({
          llmRoutingPolicy: expect.objectContaining({ thresholdChars: 7_000 }),
        }),
        { rerender: false },
      );
    });
  });

  it('renders discovered OpenAI-compatible models as visible input options', async () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://127.0.0.1:1234/v1',
        },
      },
      llmRoutingPolicy: {
        kind: 'fixed' as const,
        providerId: 'openai_compatible' as const,
      },
    };
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({
        id: 'openai_compatible',
        listModels: vi.fn(async () => [{ displayName: 'Bonsai 27B', id: 'prism-ml/bonsai-27b' }]),
      }),
    );
    const { controls } = createControls(settings);

    await controls.refreshActiveProviders();
    controls.render(new TestElement() as unknown as HTMLElement, settings);

    const model = MockSetting.named('Model');
    expect(model.settingEl.classList.contains('local-dictation-model-setting')).toBe(true);
    const listId = model.onlyText().inputEl.attributes.get('list');
    expect(listId).toMatch(/^local-dictation-openai-compatible-models-/);
    const datalist = model.controlEl.querySelector('datalist');
    expect(datalist?.attributes.get('id')).toBe(listId);
    expect(datalist?.children.map((option) => option.attributes.get('value'))).toEqual([
      'prism-ml/bonsai-27b',
    ]);
  });

  it('keeps model suggestions separate when two configuration hosts are open', () => {
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openai_compatible' as const },
    };
    const first = createControls(settings).controls;
    const second = createControls(settings).controls;
    first.render(new TestElement() as unknown as HTMLElement, settings);
    const firstId = MockSetting.named('Model').onlyText().inputEl.attributes.get('list');
    MockSetting.reset();
    second.render(new TestElement() as unknown as HTMLElement, settings);
    const secondId = MockSetting.named('Model').onlyText().inputEl.attributes.get('list');
    expect(firstId).toBeTruthy();
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  it('offers an explicit working refresh action for OpenAI-compatible models', async () => {
    const listModels = vi.fn(async () => [{ displayName: 'Gemma', id: 'gemma' }]);
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({ id: 'openai_compatible', listModels }),
    );
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://127.0.0.1:1234/v1',
        },
      },
      llmRoutingPolicy: {
        kind: 'fixed' as const,
        providerId: 'openai_compatible' as const,
      },
    };
    const { controls } = createControls(settings);

    await controls.refreshActiveProviders();
    controls.render(new TestElement() as unknown as HTMLElement, settings);

    const buttons = MockSetting.named('Model').extraButtonComponents;
    expect(buttons.map((button) => button.icon)).toEqual(['refresh-cw', 'plug-zap']);

    await buttons[0]?.click();
    await vi.waitFor(() => {
      expect(listModels).toHaveBeenCalledTimes(2);
    });
  });
});

describe('LlmRoutingControls.refreshActiveProviders', () => {
  it('does not update closed controls after a delayed model request completes', async () => {
    let finish!: (models: Array<{ id: string; displayName: string }>) => void;
    const listModels = vi.fn(
      () =>
        new Promise<Array<{ id: string; displayName: string }>>((resolve) => {
          finish = resolve;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ listModels }));
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'ollama' as const },
    };
    const { controls } = createControls(settings);
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const dropdown = MockSetting.named('Ollama model').onlyDropdown();
    const pending = controls.refreshActiveProviders();
    controls.dispose();
    finish([{ id: 'old-model', displayName: 'Old model' }]);
    await pending;
    expect(dropdown.selectEl.options.map((option) => option.value)).toEqual(['']);
  });

  it('updates a model list in place when discovery completes', async () => {
    let finish!: (models: Array<{ id: string; displayName: string }>) => void;
    const listModels = vi.fn(
      () =>
        new Promise<Array<{ id: string; displayName: string }>>((resolve) => {
          finish = resolve;
        }),
    );
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({ listModels, id: 'openai_compatible' }),
    );
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1234/v1',
        },
      },
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openai_compatible' as const },
    };
    const { controls } = createControls(settings);
    const parent = new TestElement();
    controls.render(parent as unknown as HTMLElement, settings);
    const row = MockSetting.named('Model').settingEl;
    const datalist = MockSetting.named('Model').controlEl.querySelector('datalist');
    const pending = controls.refreshActiveProviders();
    finish([{ id: 'new-model', displayName: 'New model' }]);
    await pending;
    expect(parent.contains(row)).toBe(true);
    expect(datalist?.children.map((option) => option.attributes.get('value'))).toEqual([
      'new-model',
    ]);
  });

  it('refreshes only providers used by the active policy', async () => {
    createProviderMock.mockImplementation((providerId) =>
      createFakeLlmProvider({ id: providerId }),
    );
    const { controls } = createControls({
      llmRoutingPolicy: {
        defaultProviderId: 'ollama',
        kind: 'transcript_size',
        largeTranscriptProviderId: 'openai_compatible',
        thresholdChars: 1_000,
      },
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1234/v1',
        },
      },
    });

    await controls.refreshActiveProviders();

    expect(createProviderMock).toHaveBeenCalledTimes(2);
    expect(createProviderMock.mock.calls.map(([providerId]) => providerId)).toEqual([
      'ollama',
      'openai_compatible',
    ]);
  });

  it('retries a provider whose previous model load failed', async () => {
    const listModels = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([{ displayName: 'llama3', id: 'llama3' }]);
    createProviderMock.mockReturnValue(createFakeLlmProvider({ listModels }));
    const { controls } = createControls({
      llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
    });

    await controls.refreshActiveProviders();
    await controls.refreshActiveProviders();

    expect(listModels).toHaveBeenCalledTimes(2);
  });

  it('refreshes a cached loopback OpenAI-compatible catalog after app focus returns', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([{ displayName: 'Bonsai 27B', id: 'prism-ml/bonsai-27b' }])
      .mockResolvedValueOnce([{ displayName: 'Gemma 4 E2B', id: 'google/gemma-4-e2b' }]);
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({ id: 'openai_compatible', listModels }),
    );
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://127.0.0.1:1234/v1',
        },
      },
      llmRoutingPolicy: {
        kind: 'fixed' as const,
        providerId: 'openai_compatible' as const,
      },
    };
    const { controls } = createControls(settings);

    await controls.refreshActiveProviders();
    await controls.refreshActiveProviders({ forceLocal: true });
    controls.render(new TestElement() as unknown as HTMLElement, settings);

    expect(listModels).toHaveBeenCalledTimes(2);
    const datalist = MockSetting.named('Model').controlEl.querySelector('datalist');
    expect(datalist?.children.map((option) => option.attributes.get('value'))).toEqual([
      'google/gemma-4-e2b',
    ]);
  });

  it('keeps a cached remote OpenAI-compatible catalog after app focus returns', async () => {
    const listModels = vi.fn(async () => [{ displayName: 'Remote model', id: 'remote-model' }]);
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({ id: 'openai_compatible', listModels }),
    );
    const { controls } = createControls({
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'https://models.example.com/v1',
        },
      },
      llmRoutingPolicy: {
        kind: 'fixed',
        providerId: 'openai_compatible',
      },
    });

    await controls.refreshActiveProviders();
    await controls.refreshActiveProviders({ forceLocal: true });

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent forced loopback OpenAI-compatible refreshes', async () => {
    let resolveModels: ((models: ModelOption[]) => void) | undefined;
    type ModelOption = { displayName: string; id: string };
    const listModels = vi.fn(
      () =>
        new Promise<ModelOption[]>((resolve) => {
          resolveModels = resolve;
        }),
    );
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({ id: 'openai_compatible', listModels }),
    );
    const { controls } = createControls({
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1234/v1',
        },
      },
      llmRoutingPolicy: {
        kind: 'fixed',
        providerId: 'openai_compatible',
      },
    });

    const first = controls.refreshActiveProviders({ forceLocal: true });
    const second = controls.refreshActiveProviders({ forceLocal: true });
    await Promise.resolve();
    expect(listModels).toHaveBeenCalledTimes(1);

    resolveModels?.([{ displayName: 'Gemma', id: 'gemma' }]);
    await Promise.all([first, second]);
  });

  it('deduplicates concurrent forced Ollama refreshes', async () => {
    let resolveModels: ((models: ModelOption[]) => void) | undefined;
    type ModelOption = { displayName: string; id: string };
    const listModels = vi.fn(
      () =>
        new Promise<ModelOption[]>((resolve) => {
          resolveModels = resolve;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ listModels }));
    const { controls } = createControls({
      llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
    });

    const first = controls.refreshActiveProviders({ forceLocal: true });
    const second = controls.refreshActiveProviders({ forceLocal: true });
    await Promise.resolve();
    expect(listModels).toHaveBeenCalledTimes(1);

    resolveModels?.([{ displayName: 'llama3', id: 'llama3' }]);
    await Promise.all([first, second]);
  });

  it.each(['closed', 'disabled', 'switched'] as const)(
    'does not start a health probe after the host is %s during model discovery',
    async (outcome) => {
      vi.useFakeTimers();
      let finish!: (models: []) => void;
      const listModels = vi.fn(
        () =>
          new Promise<[]>((resolve) => {
            finish = resolve;
          }),
      );
      const probe = vi.fn(async () => ({ kind: 'ready' as const, modelCount: 1 }));
      createProviderMock.mockReturnValue(
        createFakeLlmProvider({ id: 'openrouter', listModels, probe }),
      );
      let settings: PluginSettings = {
        ...DEFAULT_PLUGIN_SETTINGS,
        llmFeaturesEnabled: true,
        llmPostprocessMode: 'per_utterance',
        llmProviderConfigurations: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
          openrouter: { model: 'model', secretId: 'key' },
        },
        llmRoutingPolicy: { kind: 'fixed', providerId: 'openrouter' },
      };
      const controls = new LlmRoutingControls({
        app: {} as App,
        feedback: { show: vi.fn() },
        getSecret: () => 'stored',
        getSettings: () => settings,
        persist: async (mutation) => {
          settings = mutation(settings);
        },
      });
      controls.render(new TestElement() as unknown as HTMLElement, settings);
      await SecretComponent.instances[0]?.change('new-key');
      await vi.advanceTimersByTimeAsync(500);
      expect(listModels).toHaveBeenCalledOnce();
      if (outcome === 'closed') controls.dispose();
      else if (outcome === 'disabled') settings = { ...settings, llmFeaturesEnabled: false };
      else settings = { ...settings, llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' } };
      finish([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each(['disabled', 'failed'] as const)(
    'does not start automatic refresh after a pending configuration save is %s',
    async (outcome) => {
      vi.useFakeTimers();
      let finish!: () => void;
      let fail!: (error: Error) => void;
      let saves = 0;
      let settings: PluginSettings = {
        ...DEFAULT_PLUGIN_SETTINGS,
        llmFeaturesEnabled: true,
        llmPostprocessMode: 'per_utterance',
        llmProviderConfigurations: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
          openrouter: { model: 'model', secretId: 'key' },
        },
        llmRoutingPolicy: { kind: 'fixed', providerId: 'openrouter' },
      };
      const listModels = vi.fn(async () => []);
      const probe = vi.fn(async () => ({ kind: 'ready' as const, modelCount: 1 }));
      createProviderMock.mockReturnValue(
        createFakeLlmProvider({ id: 'openrouter', listModels, probe }),
      );
      const controls = new LlmRoutingControls({
        app: {} as App,
        feedback: { show: vi.fn() },
        getSecret: () => 'stored',
        getSettings: () => settings,
        persist: async (mutation) => {
          saves++;
          if (saves === 2)
            await new Promise<void>((resolve, reject) => {
              finish = resolve;
              fail = reject;
            });
          settings = mutation(settings);
        },
      });
      controls.render(new TestElement() as unknown as HTMLElement, settings);
      await SecretComponent.instances[0]?.change('first');
      const pending = SecretComponent.instances[0]?.change('second');
      pending?.catch(() => {});
      await vi.advanceTimersByTimeAsync(500);
      if (outcome === 'disabled') {
        settings = { ...settings, llmFeaturesEnabled: false };
        finish();
      } else fail(new Error('save failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(listModels).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it('waits for an endpoint edit to save before refreshing models', async () => {
    let finishSave!: () => void;
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1001/v1',
        },
      },
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const listModels = vi.fn(async () => []);
    createProviderMock.mockReturnValue(createFakeLlmProvider({ listModels }));
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: async (mutation) => {
        await new Promise<void>((resolve) => {
          finishSave = resolve;
        });
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    MockSetting.named('Base URL').onlyText().change('http://localhost:1002/v1');
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'refresh-cw',
    );
    if (!button) throw new Error('Refresh button missing');
    await button.click();
    expect(listModels).not.toHaveBeenCalled();
    finishSave();
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledOnce());
    expect(createProviderMock).toHaveBeenLastCalledWith(
      'openai_compatible',
      expect.objectContaining({
        configurations: expect.objectContaining({
          openai_compatible: expect.objectContaining({ baseUrl: 'http://localhost:1002/v1' }),
        }),
      }),
    );
  });

  it('clears cached models if a stored secret changes under the same reference', async () => {
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({
        listModels: vi.fn(async () => [{ id: 'old-model', displayName: 'Old model' }]),
      }),
    );
    let secret = 'synthetic-one';
    const settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1001/v1',
          secretId: 'test-secret',
        },
      },
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => secret,
      getSettings: () => settings,
      persist: vi.fn(async () => {}),
    });
    await controls.refreshActiveProviders();
    secret = 'synthetic-two';
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    expect(MockSetting.named('Model').controlEl.querySelector('datalist')?.children).toHaveLength(
      0,
    );
  });

  it('clears a cached model list when another settings host changes the endpoint', async () => {
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({
        listModels: vi.fn(async () => [{ id: 'old-model', displayName: 'Old model' }]),
      }),
    );
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1001/v1',
        },
      },
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: vi.fn(async () => {}),
    });
    await controls.refreshActiveProviders();
    settings = {
      ...settings,
      llmProviderConfigurations: {
        ...settings.llmProviderConfigurations,
        openai_compatible: {
          ...settings.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1002/v1',
        },
      },
    };
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    expect(MockSetting.named('Model').controlEl.querySelector('datalist')?.children).toHaveLength(
      0,
    );
  });

  it('does not show models from an endpoint changed by another settings host', async () => {
    let finish!: (models: Array<{ id: string; displayName: string }>) => void;
    const listModels = vi.fn(
      () =>
        new Promise<Array<{ id: string; displayName: string }>>((resolve) => {
          finish = resolve;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ listModels }));
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1001/v1',
        },
      },
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: vi.fn(async () => {}),
    });
    const request = controls.refreshActiveProviders();
    settings = {
      ...settings,
      llmProviderConfigurations: {
        ...settings.llmProviderConfigurations,
        openai_compatible: {
          ...settings.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1002/v1',
        },
      },
    };
    finish([{ id: 'old-model', displayName: 'Old model' }]);
    await request;
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    expect(MockSetting.named('Model').controlEl.querySelector('datalist')?.children).toHaveLength(
      0,
    );
  });

  it('refreshes the new endpoint while an old endpoint request is pending', async () => {
    let finishOld!: (models: Array<{ id: string; displayName: string }>) => void;
    const oldList = vi.fn(
      () =>
        new Promise<Array<{ id: string; displayName: string }>>((resolve) => {
          finishOld = resolve;
        }),
    );
    const newList = vi.fn(async () => [{ id: 'new-model', displayName: 'New model' }]);
    createProviderMock
      .mockReturnValueOnce(createFakeLlmProvider({ listModels: oldList }))
      .mockReturnValue(createFakeLlmProvider({ listModels: newList }));
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openai_compatible: {
          ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:1001/v1',
        },
      },
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: async (mutation) => {
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const old = controls.refreshActiveProviders();
    MockSetting.named('Base URL').onlyText().change('http://localhost:1002/v1');
    await Promise.resolve();
    const fresh = controls.refreshActiveProviders();
    await fresh;
    expect(newList).toHaveBeenCalledOnce();
    finishOld([{ id: 'old-model', displayName: 'Old model' }]);
    await old;
    MockSetting.reset();
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    expect(
      MockSetting.named('Model')
        .controlEl.querySelector('datalist')
        ?.children.map((option) => option.attributes.get('value')),
    ).toEqual(['new-model']);
  });

  it('does not log a provider response body when model discovery fails', async () => {
    const warn = vi.fn();
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({
        listModels: vi.fn(async () => {
          throw new ProviderError('HTTP failure', 'http_error', {
            responseText: 'synthetic-secret',
          });
        }),
      }),
    );
    const settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
    };
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => '',
      getSettings: () => settings,
      persist: vi.fn(async () => {}),
      logger: { warn, debug: vi.fn(), error: vi.fn() },
    });
    await controls.refreshActiveProviders();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret');
  });

  it('rechecks OpenRouter key health after the selected secret changes', async () => {
    vi.useFakeTimers();
    let resolveModels: ((models: Array<{ displayName: string; id: string }>) => void) | undefined;
    const listModels = vi.fn(
      () =>
        new Promise<Array<{ displayName: string; id: string }>>((resolve) => {
          resolveModels = resolve;
        }),
    );
    const probe = vi.fn(async () => ({ kind: 'auth_invalid' as const }));
    createProviderMock.mockReturnValue(
      createFakeLlmProvider({
        id: 'openrouter',
        listModels,
        probe,
      }),
    );
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmFeaturesEnabled: true,
      llmPostprocessMode: 'per_utterance' as const,
      llmProviderConfigurations: {
        ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
        openrouter: { model: 'model', secretId: 'openrouter-secret' },
      },
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openrouter' as const },
    };
    const { controls } = createControls(settings, 'stored-key');

    controls.render(new TestElement() as unknown as HTMLElement, settings);
    await SecretComponent.instances[0]?.change('replacement-secret');
    await vi.advanceTimersByTimeAsync(500);

    expect(probe).not.toHaveBeenCalled();
    resolveModels?.([{ displayName: 'Model', id: 'model' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
  });
});

describe('LlmRoutingControls.testProvider', () => {
  const configurations = {
    ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
    openrouter: {
      model: 'anthropic/claude-sonnet-4.5',
      secretId: 'openrouter-secret',
    },
    openai_compatible: {
      baseUrl: 'http://localhost:1234/v1',
      model: 'local-model',
      secretId: 'custom-secret',
    },
  };

  it.each(['openrouter', 'openai_compatible'] as const)(
    'runs a minimal real completion for %s',
    async (providerId) => {
      const cleanup = vi.fn(async () => 'OK');
      createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: providerId }));
      const { controls } = createControls({ llmProviderConfigurations: configurations }, 'secret');

      await expect(controls.testProvider(providerId)).resolves.toBeNull();
      expect(cleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: MIN_OUTPUT_TOKENS,
          model: configurations[providerId].model,
        }),
      );
      expect(createProviderMock).toHaveBeenCalledWith(
        providerId,
        expect.objectContaining({
          configurations,
          networkTimeoutMs: DEFAULT_PLUGIN_SETTINGS.llmNetworkTimeoutSec * 1000,
        }),
      );
    },
  );

  it('reports an unconfigured model without calling the provider', async () => {
    const cleanup = vi.fn(async () => 'OK');
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup }));
    const { controls } = createControls({
      llmProviderConfigurations: {
        ...configurations,
        openrouter: { ...configurations.openrouter, model: '' },
      },
    });

    await expect(controls.testProvider('openrouter')).resolves.toContain('model is not configured');
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('suppresses a connection result after another host changes the endpoint', async () => {
    let fail!: (error: Error) => void;
    const cleanup = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openai_compatible' }));
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const show = vi.fn();
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show },
      getSecret: () => 'key',
      getSettings: () => settings,
      persist: vi.fn(async () => {}),
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (!button) throw new Error('Connection test button missing');
    await button.click();
    settings = {
      ...settings,
      llmProviderConfigurations: {
        ...settings.llmProviderConfigurations,
        openai_compatible: {
          ...settings.llmProviderConfigurations.openai_compatible,
          baseUrl: 'http://localhost:9999/v1',
        },
      },
    };
    fail(new Error('old endpoint failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it('suppresses an old connection result after its model changes without a rerender', async () => {
    let fail!: (error: Error) => void;
    const cleanup = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openai_compatible' }));
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const show = vi.fn();
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show },
      getSecret: () => 'key',
      getSettings: () => settings,
      persist: async (mutation) => {
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (!button) throw new Error('Connection test button missing');
    await button.click();
    MockSetting.named('Model').onlyText().change('new-model');
    await Promise.resolve();
    fail(new Error('old model failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it('reports a failed credential save without testing the previous configuration', async () => {
    let fail!: (error: Error) => void;
    const cleanup = vi.fn(async () => 'OK');
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openrouter' }));
    const settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openrouter' },
    };
    const show = vi.fn();
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show },
      getSecret: () => 'key',
      getSettings: () => settings,
      persist: async () => {
        await new Promise<void>((_resolve, reject) => {
          fail = reject;
        });
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const saving = SecretComponent.instances[0]?.change('new-key');
    saving?.catch(() => {});
    const button = MockSetting.named('OpenRouter model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (!button) throw new Error('Connection test button missing');
    await button.click();
    fail(new Error('synthetic secret must not appear'));
    await vi.waitFor(() => expect(show).toHaveBeenCalled());
    expect(cleanup).not.toHaveBeenCalled();
    expect(JSON.stringify(show.mock.calls)).not.toContain('synthetic secret');
  });

  it('waits for an endpoint save before testing its connection', async () => {
    let finish!: () => void;
    let settings: PluginSettings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: { kind: 'fixed', providerId: 'openai_compatible' },
    };
    const cleanup = vi.fn(async () => 'OK');
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openai_compatible' }));
    const controls = new LlmRoutingControls({
      app: {} as App,
      feedback: { show: vi.fn() },
      getSecret: () => 'key',
      getSettings: () => settings,
      persist: async (mutation) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        settings = mutation(settings);
      },
    });
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    MockSetting.named('Base URL').onlyText().change('http://localhost:5678/v1');
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (!button) throw new Error('Connection test button missing');
    await button.click();
    expect(cleanup).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
    expect(createProviderMock).toHaveBeenLastCalledWith(
      'openai_compatible',
      expect.objectContaining({
        configurations: expect.objectContaining({
          openai_compatible: expect.objectContaining({ baseUrl: 'http://localhost:5678/v1' }),
        }),
      }),
    );
  });

  it('does not report a connection test after the settings controls are replaced', async () => {
    let fail!: (error: Error) => void;
    const cleanup = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openai_compatible' }));
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openai_compatible' as const },
    };
    const { controls, show } = createControls(settings, 'secret');
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (!button) throw new Error('Connection test button missing');
    await button.click();
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    fail(new Error('old endpoint failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    expect(button.icon).toBe('loader-circle');
  });

  it('does not show a late connection failure after its host closes', async () => {
    let fail!: (error: Error) => void;
    const cleanup = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openai_compatible' }));
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'openai_compatible' as const },
    };
    const { controls, show } = createControls(settings, 'secret');
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (!button) throw new Error('Connection test button missing');
    await button.click();
    controls.dispose();
    fail(new Error('failed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    expect(button.icon).toBe('loader-circle');
  });

  it('shows that a connection test is running while the provider is pending', async () => {
    let resolveCleanup: ((value: string) => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    createProviderMock.mockReturnValue(createFakeLlmProvider({ cleanup, id: 'openai_compatible' }));
    const settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmProviderConfigurations: configurations,
      llmRoutingPolicy: {
        kind: 'fixed' as const,
        providerId: 'openai_compatible' as const,
      },
    };
    const { controls } = createControls(settings, 'secret');
    controls.render(new TestElement() as unknown as HTMLElement, settings);
    const button = MockSetting.named('Model').extraButtonComponents.find(
      (candidate) => candidate.icon === 'plug-zap',
    );
    if (button === undefined) throw new Error('Connection test button missing');

    await button.click();

    expect(button.disabled).toBe(true);
    expect(button.icon).toBe('loader-circle');
    expect(button.tooltip).toBe('Testing connection…');
    expect(
      button.extraSettingsEl.classList.contains('local-dictation-connection-test--loading'),
    ).toBe(true);

    resolveCleanup?.('OK');
    await vi.waitFor(() => {
      expect(button.disabled).toBe(false);
    });
    expect(button.icon).toBe('check');
  });
});
