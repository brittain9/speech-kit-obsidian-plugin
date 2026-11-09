// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
  class Modal {
    modalEl = document.createElement('div');
    contentEl = document.createElement('div');
    constructor() {
      this.modalEl.append(this.contentEl);
      document.body.append(this.modalEl);
    }
    setTitle() {}
    open() {
      (this as unknown as { onOpen(): void }).onOpen();
    }
    close() {
      (this as unknown as { onClose(): void }).onClose();
      this.modalEl.remove();
    }
  }
  class Setting {
    settingEl = document.createElement('div');
    nameEl = document.createElement('div');
    descEl = document.createElement('div');
    controlEl = document.createElement('div');
    constructor(parent: HTMLElement) {
      this.settingEl.className = 'setting-item';
      this.nameEl.className = 'setting-item-name';
      this.settingEl.append(this.nameEl, this.descEl, this.controlEl);
      parent.append(this.settingEl);
    }
    setName(name: string) {
      this.nameEl.textContent = name;
      return this;
    }
    setDesc(description: string) {
      this.descEl.textContent = description;
      return this;
    }
    addDropdown(callback: (component: unknown) => void) {
      const selectEl = document.createElement('select');
      this.controlEl.append(selectEl);
      const component = {
        selectEl,
        addOption: (value: string, label: string) => {
          selectEl.add(new Option(label, value));
          return component;
        },
        setValue: (value: string) => {
          selectEl.value = value;
          return component;
        },
        setDisabled: (value: boolean) => {
          selectEl.disabled = value;
          return component;
        },
        onChange: (handler: (value: string) => void) => {
          selectEl.addEventListener('change', () => handler(selectEl.value));
          return component;
        },
      };
      callback(component);
      return this;
    }
    addToggle(callback: (component: unknown) => void) {
      const toggleEl = document.createElement('input');
      toggleEl.type = 'checkbox';
      this.controlEl.append(toggleEl);
      const component = {
        toggleEl,
        setValue: (value: boolean) => {
          toggleEl.checked = value;
          return component;
        },
        setDisabled: (value: boolean) => {
          toggleEl.disabled = value;
          return component;
        },
        onChange: (handler: (value: boolean) => void) => {
          toggleEl.addEventListener('change', () => handler(toggleEl.checked));
          return component;
        },
      };
      callback(component);
      return this;
    }
    addText(callback: (component: unknown) => void) {
      const inputEl = document.createElement('input');
      this.controlEl.append(inputEl);
      const component = {
        inputEl,
        setValue: (value: string) => {
          inputEl.value = value;
          return component;
        },
        setPlaceholder: (value: string) => {
          inputEl.placeholder = value;
          return component;
        },
        onChange: (handler: (value: string) => void) => {
          inputEl.addEventListener('input', () => handler(inputEl.value));
          return component;
        },
      };
      callback(component);
      return this;
    }
    addButton(callback: (component: unknown) => void) {
      return this.addButtonLike(callback);
    }
    addExtraButton(callback: (component: unknown) => void) {
      return this.addButtonLike(callback);
    }
    private addButtonLike(callback: (component: unknown) => void) {
      const buttonEl = document.createElement('button');
      this.controlEl.append(buttonEl);
      const component = {
        buttonEl,
        extraSettingsEl: buttonEl,
        setButtonText: (value: string) => {
          buttonEl.textContent = value;
          return component;
        },
        setTooltip: (value: string) => {
          buttonEl.title = value;
          return component;
        },
        setIcon: () => component,
        setCta: () => component,
        setDisabled: (value: boolean) => {
          buttonEl.disabled = value;
          return component;
        },
        onClick: (handler: () => void) => {
          buttonEl.addEventListener('click', handler);
          return component;
        },
      };
      callback(component);
      return this;
    }
  }
  return { Modal, Setting, getLanguage: () => 'en', setIcon: () => {}, setTooltip: () => {} };
});

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { renderMediaProgressStatus } from '../src/ui/media-progress-presenter';
import { MediaTranscriptionModalRegistry } from '../src/ui/media-transcription-modal';

Object.assign(HTMLElement.prototype, {
  addClass(this: HTMLElement, name: string) {
    this.classList.add(name);
  },
  removeClass(this: HTMLElement, name: string) {
    this.classList.remove(name);
  },
  empty(this: HTMLElement) {
    this.replaceChildren();
  },
  setText(this: HTMLElement, text: string) {
    this.textContent = text;
  },
  hide(this: HTMLElement) {
    this.style.display = 'none';
  },
  show(this: HTMLElement) {
    this.style.display = '';
  },
  toggle(this: HTMLElement, show: boolean) {
    this.style.display = show ? '' : 'none';
  },
  createEl(
    this: HTMLElement,
    tag: string,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    const element = document.createElement(tag);
    element.className = options.cls ?? '';
    element.textContent = options.text ?? '';
    for (const [name, value] of Object.entries(options.attr ?? {}))
      element.setAttribute(name, value);
    this.append(element);
    return element;
  },
  createDiv(
    this: HTMLElement,
    options?: { cls?: string; text?: string; attr?: Record<string, string> },
  ) {
    return this.createEl('div', options);
  },
  createSpan(
    this: HTMLElement,
    options?: { cls?: string; text?: string; attr?: Record<string, string> },
  ) {
    return this.createEl('span', options);
  },
});

afterEach(() => document.body.replaceChildren());

it('reopens retained partial recovery from the status button without starting a job', async () => {
  const registry = new MediaTranscriptionModalRegistry();
  const startFile = vi.fn(async () => {});
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  let partial: string | null = null;
  let targetMatches = false;
  const dependencies = {
    cancel: vi.fn(async () => {}),
    getModels: () => [],
    getLastError: () => null,
    getLastMediaAiResult: () => null,
    getPartialTranscript: () => partial,
    insertPartialTranscript: () => {
      if (!targetMatches) return false;
      partial = null;
      return true;
    },
    getProgress: () => null,
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    isTranscribing: () => false,
    isJobActive: () => false,
    wasLastJobCancelled: () => true,
    isDecoderInstalled: async () => true,
    openDecoderInstaller: vi.fn(),
    onManageModels: vi.fn(),
    onManagePresets: vi.fn(),
    startFile,
    subscribeProgress: () => () => {},
  };
  registry.open({} as never, dependencies);
  registry.closeAll();
  partial = 'retained partial';
  const status = document.createElement('div');
  document.body.append(status);
  renderMediaProgressStatus(status, null, true, () => registry.open({} as never, dependencies));
  const statusButton = status.querySelector('button');
  if (!statusButton) throw new Error('Missing recovery status button');
  statusButton.focus();
  statusButton.click();
  const buttons = [
    ...document.querySelectorAll<HTMLButtonElement>('.local-stt-media-partial-actions button'),
  ];
  const copyButton = buttons.find((button) => button.textContent === 'Copy partial transcript');
  const insertButton = buttons.find((button) => button.textContent === 'Insert partial transcript');
  expect(document.body.textContent).toContain('Copy it before starting another job.');
  expect(copyButton).toBeDefined();
  expect(insertButton).toBeDefined();
  expect(document.activeElement).toBe(statusButton);
  copyButton?.click();
  expect(copy).toHaveBeenCalledWith('retained partial');
  insertButton?.click();
  expect(document.body.textContent).toContain('Return to the original note');
  expect(partial).toBe('retained partial');
  targetMatches = true;
  insertButton?.click();
  expect(partial).toBeNull();
  expect(document.querySelector('.local-stt-media-partial-actions button')).toBeNull();
  expect(startFile).not.toHaveBeenCalled();
  registry.closeAll();
});
