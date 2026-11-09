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
Object.assign(globalThis, { createFragment: () => document.createDocumentFragment() });

it('keeps native filter focus and task selections while all families remain reachable', () => {
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
    selectedModel: null,
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
  const language = content.querySelector<HTMLSelectElement>('select[aria-label="Languages"]');
  let family = content.querySelector<HTMLSelectElement>('select[aria-label="Model families"]');
  if (!language || !family) throw new Error('Expected native filters');
  expect([...family.options].map((option) => option.text)).toContain(
    'NVIDIA Parakeet Unified with a very long label',
  );
  language.focus();
  language.value = 'fr';
  language.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.activeElement).toBe(language);
  expect(language.isConnected).toBe(true);
  family = content.querySelector<HTMLSelectElement>('select[aria-label="Model families"]');
  expect(family?.selectedOptions[0]?.text).toBe('Nemotron');
  language.value = '';
  language.dispatchEvent(new Event('change', { bubbles: true }));
  family = content.querySelector<HTMLSelectElement>('select[aria-label="Model families"]');
  if (!family) throw new Error('Expected family filter');
  family.focus();
  family.value = 'onnx_runtime:parakeet_unified';
  family.dispatchEvent(new Event('change', { bubbles: true }));
  expect(document.activeElement).toBe(family);
  expect(content.textContent).toContain('Parakeet');
  state.catalog.catalogVersion += 1;
  notify();
  family = content.querySelector<HTMLSelectElement>('select[aria-label="Model families"]');
  expect(family?.value).toBe('onnx_runtime:parakeet_unified');
  expect(document.activeElement).toBe(family);
  const task = [...content.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (tab) => tab.textContent === 'Text to speech',
  );
  const stt = [...content.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (tab) => tab.textContent === 'Speech to text',
  );
  if (!task || !stt) throw new Error('Expected model task tabs');
  stt.focus();
  stt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.activeElement).toBe(task);
  expect(content.querySelector<HTMLSelectElement>('select[aria-label="Languages"]')?.value).toBe(
    '',
  );
  task.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(document.activeElement).toBe(stt);
  expect(
    content.querySelector<HTMLSelectElement>('select[aria-label="Model families"]')?.value,
  ).toBe('onnx_runtime:parakeet_unified');
  modal.close();
});
