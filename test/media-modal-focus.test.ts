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
import { MediaTranscriptionModalRegistry } from '../src/ui/media-transcription-modal';
import { YouTubeTranscriptModalRegistry } from '../src/ui/youtube-transcript-modal';

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

function control(label: string): HTMLInputElement {
  const row = [...document.querySelectorAll('.setting-item')].find(
    (item) => item.querySelector('.setting-item-name')?.textContent === label,
  );
  const input = row?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing control: ${label}`);
  return input;
}

it('keeps keyboard focus and scroll position when file transcription options change', () => {
  const registry = new MediaTranscriptionModalRegistry();
  registry.open({} as never, {
    cancel: vi.fn(async () => {}),
    getModels: () => [
      {
        capabilities: {} as never,
        label: 'Model',
        selection: {
          familyId: 'whisper',
          kind: 'catalog_model',
          modelId: 'model',
          runtimeId: 'whisper_cpp',
        },
      },
    ],
    getLastError: () => null,
    getLastMediaAiResult: () => null,
    getPartialTranscript: () => null,
    insertPartialTranscript: () => false,
    getProgress: () => null,
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    isTranscribing: () => false,
    isJobActive: () => false,
    wasLastJobCancelled: () => false,
    isDecoderInstalled: async () => true,
    openDecoderInstaller: vi.fn(),
    onManageModels: vi.fn(),
    onManagePresets: vi.fn(),
    startFile: vi.fn(async () => {}),
    subscribeProgress: () => () => {},
  });
  const content = document.querySelector('.local-stt-media-modal > div') as HTMLElement;
  const details = content.querySelector('details');
  if (!details) throw new Error('Missing transcript options');
  details.open = true;
  details.dispatchEvent(new Event('toggle'));
  const toggle = control('Use timestamps');
  content.scrollTop = 120;
  toggle.focus();
  toggle.checked = !toggle.checked;
  toggle.dispatchEvent(new Event('change'));
  expect(document.activeElement).toBe(control('Use timestamps'));
  expect(content.scrollTop).toBe(120);
  registry.closeAll();
});

it('keeps keyboard focus and scroll position when YouTube options change', () => {
  const registry = new YouTubeTranscriptModalRegistry();
  registry.open({} as never, {
    cancel: vi.fn(async () => {}),
    getProgress: () => null,
    getPartialTranscript: () => null,
    getResultSource: () => null,
    getCompletedVideoId: () => null,
    getAiResult: () => null,
    getError: () => null,
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    insertPartialTranscript: () => false,
    isBusy: () => false,
    isJobActive: () => false,
    wasLastJobCancelled: () => false,
    onManagePresets: vi.fn(),
    start: vi.fn(async () => {}),
    subscribeProgress: () => () => {},
  });
  const content = document.querySelector(
    '.local-stt-youtube-transcript-modal > div',
  ) as HTMLElement;
  const toggle = control('Linked timestamps');
  content.scrollTop = 90;
  toggle.focus();
  toggle.checked = !toggle.checked;
  toggle.dispatchEvent(new Event('change'));
  expect(document.activeElement).toBe(control('Linked timestamps'));
  expect(content.scrollTop).toBe(90);
  registry.closeAll();
});
