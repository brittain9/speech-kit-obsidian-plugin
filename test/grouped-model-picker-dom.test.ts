// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
  const base = await import('./__mocks__/obsidian');
  class Modal {
    readonly modalEl = document.createElement('div');
    readonly contentEl = document.createElement('div');
    constructor(readonly app: unknown) {
      this.modalEl.append(this.contentEl);
      document.body.append(this.modalEl);
    }
    setTitle(): this {
      return this;
    }
    open(): void {
      this.onOpen();
    }
    close(): void {
      this.onClose();
      this.modalEl.remove();
    }
    onOpen(): void {}
    onClose(): void {}
  }
  class Setting {
    readonly settingEl = document.createElement('div');
    readonly nameEl = document.createElement('div');
    readonly descEl = document.createElement('div');
    readonly controlEl = document.createElement('div');
    constructor(parent: HTMLElement) {
      this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
      parent.append(this.settingEl);
    }
    setClass(value: string): this {
      this.settingEl.classList.add(value);
      return this;
    }
    setName(value: string): this {
      this.nameEl.textContent = value;
      return this;
    }
    setDesc(value: string | Node): this {
      this.descEl.replaceChildren(
        ...(typeof value === 'string' ? [document.createTextNode(value)] : [value]),
      );
      return this;
    }
    addDropdown(callback: (dropdown: Dropdown) => void): this {
      const dropdown = new Dropdown();
      this.controlEl.append(dropdown.selectEl);
      callback(dropdown);
      return this;
    }
    addButton(callback: (button: Button) => void): this {
      const button = new Button();
      this.controlEl.append(button.buttonEl);
      callback(button);
      return this;
    }
    addExtraButton(callback: (button: Button) => void): this {
      return this.addButton(callback);
    }
  }
  class Dropdown {
    readonly selectEl = document.createElement('select');
    addOption(value: string, label: string): this {
      this.selectEl.add(new Option(label, value));
      return this;
    }
    setValue(value: string): this {
      this.selectEl.value = value;
      return this;
    }
    setDisabled(value: boolean): this {
      this.selectEl.disabled = value;
      return this;
    }
    onChange(callback: (value: string) => void): this {
      this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
      return this;
    }
  }
  class Button {
    readonly buttonEl = document.createElement('button');
    readonly extraSettingsEl = this.buttonEl;
    setCta(): this {
      return this;
    }
    setButtonText(text: string): this {
      this.buttonEl.textContent = text;
      return this;
    }
    setDisabled(value: boolean): this {
      this.buttonEl.disabled = value;
      return this;
    }
    setIcon(): this {
      return this;
    }
    setTooltip(): this {
      return this;
    }
    onClick(callback: () => void): this {
      this.buttonEl.addEventListener('click', callback);
      return this;
    }
  }
  class SearchComponent {
    readonly inputEl = document.createElement('input');
    constructor(parent: HTMLElement) {
      parent.append(this.inputEl);
    }
    setPlaceholder(value: string): this {
      this.inputEl.placeholder = value;
      return this;
    }
    setValue(value: string): this {
      this.inputEl.value = value;
      return this;
    }
    onChange(callback: (value: string) => void): this {
      this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
      return this;
    }
  }
  return { ...base, Modal, Setting, SearchComponent };
});

import { ManageModelsModal } from '../src/models/manage-models-modal';

interface ElementOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}
function createChild(this: Node, tag: string, options: ElementOptions = {}): HTMLElement {
  const child = document.createElement(tag);
  if (options.cls) child.className = options.cls;
  if (options.text) child.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
  this.appendChild(child);
  return child;
}
for (const prototype of [HTMLElement.prototype, DocumentFragment.prototype]) {
  Object.defineProperty(prototype, 'createEl', { configurable: true, value: createChild });
  Object.defineProperty(prototype, 'createDiv', {
    configurable: true,
    value(this: Node, options: ElementOptions) {
      return createChild.call(this, 'div', options);
    },
  });
  Object.defineProperty(prototype, 'createSpan', {
    configurable: true,
    value(this: Node, options: ElementOptions) {
      return createChild.call(this, 'span', options);
    },
  });
}
Object.defineProperty(HTMLElement.prototype, 'empty', {
  configurable: true,
  value(this: HTMLElement) {
    this.replaceChildren();
  },
});
Object.defineProperty(HTMLElement.prototype, 'addClass', {
  configurable: true,
  value(this: HTMLElement, name: string) {
    this.classList.add(name);
  },
});
Object.defineProperty(HTMLElement.prototype, 'toggleClass', {
  configurable: true,
  value(this: HTMLElement, name: string, active: boolean) {
    this.classList.toggle(name, active);
  },
});
Object.assign(globalThis, {
  createFragment: () => document.createDocumentFragment(),
  createDiv: () => document.createElement('div'),
  createSpan: () => document.createElement('span'),
});

it('searches all task families and restores disclosure choices', async () => {
  const model = (modelId: string, familyId: string, tags: string[], task = 'stt') => ({
    artifacts: [],
    collectionId: familyId,
    displayName: modelId,
    familyId,
    languageTags: tags,
    supportsAutomaticLanguageDetection: false,
    licenseLabel: 'MIT',
    licenseUrl: 'https://example.com',
    modelCardUrl: null,
    modelId,
    notes: [],
    runtimeId: 'onnx_runtime',
    sourceUrl: 'https://example.com',
    summary: '',
    task,
    uxTags: [],
  });
  const models = [
    model('English', 'moonshine', ['en']),
    model('French', 'nemotron_asr', ['fr']),
    model('Parakeet', 'parakeet_unified', ['en']),
    model('German', 'pocket_tts', ['de'], 'tts'),
  ];
  const families = [
    { familyId: 'moonshine', displayName: 'Moonshine', task: 'stt' },
    { familyId: 'nemotron_asr', displayName: 'Nemotron', task: 'stt' },
    {
      familyId: 'parakeet_unified',
      displayName: 'NVIDIA Parakeet Unified with a very long label',
      task: 'stt',
    },
    { familyId: 'pocket_tts', displayName: 'Pocket TTS', task: 'tts' },
  ].map((entry) => ({ ...entry, runtimeId: 'onnx_runtime', summary: '' }));
  const state = {
    activeInstall: null,
    failedInstall: null,
    installRequestPending: false,
    catalog: { catalogVersion: 1, collections: [], families, models },
    compiledAdapters: families.map(({ familyId, displayName, runtimeId }) => ({
      familyId,
      displayName,
      runtimeId,
    })),
    compiledRuntimes: [],
    installedModels: [],
    loadError: null,
    loadStatus: 'ready',
    modelStore: { overridePath: null, path: '/models', usingDefaultPath: true },
    selectedModel: {
      kind: 'catalog_model',
      runtimeId: 'onnx_runtime',
      familyId: 'parakeet_unified',
      modelId: 'Parakeet',
    },
    selectedModelCapabilities: { status: 'none' },
    selectedTtsModel: null,
    selectedTtsModelCapabilities: { status: 'none' },
    selectedTranslationModel: null,
  };
  let notify = (): void => {};
  const modal = new ManageModelsModal({} as never, {
    feedback: { show: vi.fn() },
    manager: {
      getState: () => state,
      getDictationLanguage: () => 'en',
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    } as never,
    onChanged: vi.fn(),
  });
  modal.open();
  const content = modal.contentEl;
  const groups = () => [
    ...content.querySelectorAll<HTMLDetailsElement>('details.local-stt-model-family'),
  ];
  const group = (name: string) =>
    groups().find((item) => item.querySelector('summary')?.textContent?.includes(name));
  expect(groups()).toHaveLength(3);
  expect(group('NVIDIA Parakeet Unified')?.open).toBe(true);
  expect(group('Moonshine')?.open).toBe(false);
  group('Moonshine')?.querySelector('summary')?.click();
  await vi.waitFor(() => expect(group('Moonshine')?.open).toBe(true));
  group('Moonshine')?.querySelector('summary')?.focus();
  notify();
  expect(document.activeElement).toBe(group('Moonshine')?.querySelector('summary'));
  const install = [
    ...(group('Moonshine')?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((button) => button.textContent === 'Install');
  if (!install) throw new Error('Missing install action');
  install.focus();
  notify();
  expect(document.activeElement?.textContent).toBe('Install');
  expect(group('Moonshine')?.contains(document.activeElement)).toBe(true);
  Object.assign(state, {
    failedInstall: {
      artifactIds: [],
      failureId: 'failure-1',
      message: 'Download failed',
      selection: {
        kind: 'catalog_model',
        runtimeId: 'onnx_runtime',
        familyId: 'moonshine',
        modelId: 'English',
      },
    },
  });
  notify();
  expect(group('Moonshine')?.open).toBe(true);
  expect(group('Moonshine')?.textContent).toContain('Retry');
  expect(document.activeElement).toBe(group('Moonshine')?.querySelector('summary'));
  Object.assign(state, { failedInstall: null });
  notify();
  const search = content.querySelector<HTMLInputElement>(
    'input[aria-label="Search Speech to text models"]',
  );
  if (!search) throw new Error('Missing task-wide search');
  search.focus();
  search.value = 'French';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.activeElement).toBe(search);
  expect(groups()).toHaveLength(1);
  expect(group('Nemotron')?.open).toBe(true);
  expect(content.textContent).toContain('French');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(group('Moonshine')?.open).toBe(true);
  expect(group('NVIDIA Parakeet Unified')?.open).toBe(true);
  expect(group('Nemotron')?.open).toBe(false);
  search.value = 'NVIDIA';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(groups()).toHaveLength(1);
  expect(group('NVIDIA Parakeet Unified')?.open).toBe(true);
  search.value = 'no matching model';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(groups()).toHaveLength(0);
  expect(content.textContent).toContain('Clear or change the search');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  const language = content.querySelector<HTMLSelectElement>('select[aria-label="Languages"]');
  if (!language) throw new Error('Missing language filter');
  language.focus();
  language.value = 'fr';
  language.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.activeElement).toBe(language);
  expect(groups()).toHaveLength(1);
  expect(group('Nemotron')).toBeDefined();
  state.catalog.catalogVersion += 1;
  notify();
  const refreshedLanguage = content.querySelector<HTMLSelectElement>(
    'select[aria-label="Languages"]',
  );
  expect(refreshedLanguage?.value).toBe('fr');
  expect(document.activeElement).toBe(refreshedLanguage);
  const taskTabs = [...content.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const stt = taskTabs.find((tab) => tab.textContent === 'Speech to text');
  const tts = taskTabs.find((tab) => tab.textContent === 'Text to speech');
  if (!stt || !tts) throw new Error('Missing task controls');
  stt.focus();
  stt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.activeElement).toBe(tts);
  expect(content.querySelector<HTMLSelectElement>('select[aria-label="Languages"]')?.value).toBe(
    '',
  );
  expect(group('Pocket TTS')?.open).toBe(true);
  group('Pocket TTS')?.querySelector('summary')?.click();
  expect(group('Pocket TTS')?.open).toBe(false);
  tts.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(document.activeElement).toBe(stt);
  expect(content.querySelector<HTMLSelectElement>('select[aria-label="Languages"]')?.value).toBe(
    'fr',
  );
  const restoredLanguage = content.querySelector<HTMLSelectElement>(
    'select[aria-label="Languages"]',
  );
  if (!restoredLanguage) throw new Error('Missing restored language filter');
  restoredLanguage.value = '';
  restoredLanguage.dispatchEvent(new Event('change', { bubbles: true }));
  expect(group('Moonshine')?.open).toBe(true);
  expect(group('NVIDIA Parakeet Unified')?.open).toBe(true);
  stt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(group('Pocket TTS')?.open).toBe(false);
  group('Pocket TTS')?.querySelector('summary')?.focus();
  Object.assign(state, {
    failedInstall: {
      artifactIds: [],
      failureId: 'failure-cross-task',
      message: 'Download failed',
      selection: {
        kind: 'catalog_model',
        runtimeId: 'onnx_runtime',
        familyId: 'moonshine',
        modelId: 'English',
      },
    },
  });
  notify();
  expect(group('Moonshine')?.open).toBe(true);
  expect(group('Moonshine')?.textContent).toContain('Retry');
  expect(document.activeElement).toBe(group('Moonshine')?.querySelector('summary'));
  const external = document.createElement('button');
  document.body.append(external);
  external.focus();
  Object.assign(state, { failedInstall: null });
  notify();
  Object.assign(state, {
    failedInstall: {
      artifactIds: [],
      failureId: 'failure-outside',
      message: 'Download failed',
      selection: {
        kind: 'catalog_model',
        runtimeId: 'onnx_runtime',
        familyId: 'moonshine',
        modelId: 'English',
      },
    },
  });
  notify();
  expect(document.activeElement).toBe(external);
  Object.assign(state, { failedInstall: null });
  external.remove();
  modal.close();
  state.selectedModel.familyId = 'nemotron_asr';
  state.selectedModel.modelId = 'missing';
  const reopened = new ManageModelsModal({} as never, {
    feedback: { show: vi.fn() },
    manager: {
      getState: () => state,
      getDictationLanguage: () => 'en',
      subscribe: () => () => {},
    } as never,
    onChanged: vi.fn(),
  });
  reopened.open();
  const initialGroups = [
    ...reopened.contentEl.querySelectorAll<HTMLDetailsElement>('details.local-stt-model-family'),
  ];
  expect(initialGroups.find((item) => item.open)?.querySelector('summary')?.textContent).toBe(
    'Moonshine',
  );
  reopened.close();
});
