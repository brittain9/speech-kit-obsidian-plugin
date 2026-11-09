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
  return {
    Modal,
    Setting,
    getLanguage: () => 'en',
    setIcon: () => {},
    setTooltip: () => {},
  };
});

import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { renderMediaProgressStatus } from '../src/ui/media-progress-presenter';
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

afterEach(() => {
  document.body.replaceChildren();
});

it('reopens retained partial recovery from the status button without starting a job', async () => {
  const registry = new MediaTranscriptionModalRegistry();
  const startFile = vi.fn(async () => {});
  let resolveCopy!: () => void;
  let rejectCopy!: (error: Error) => void;
  const copy = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        resolveCopy = resolve;
        rejectCopy = reject;
      }),
  );
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
  copyButton?.focus();
  copyButton?.click();
  copyButton?.click();
  expect(copy).toHaveBeenCalledWith('retained partial');
  expect(copy).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(copyButton);
  const feedback = document.querySelector<HTMLElement>('.local-stt-partial-copy-status');
  expect(feedback?.getAttribute('role')).toBe('status');
  expect(feedback?.textContent).toBe('');
  resolveCopy();
  await vi.waitFor(() => expect(feedback?.textContent).toBe('Partial transcript copied.'));
  copyButton?.click();
  rejectCopy(new Error('private clipboard failure'));
  await vi.waitFor(() =>
    expect(feedback?.textContent).toBe(
      'Could not copy. Try again or insert the partial transcript in its original note.',
    ),
  );
  expect(feedback?.textContent).not.toContain('private clipboard failure');
  expect(partial).toBe('retained partial');
  copyButton?.click();
  insertButton?.click();
  expect(document.body.textContent).toContain('Return to the original note');
  expect(partial).toBe('retained partial');
  targetMatches = true;
  insertButton?.click();
  expect(partial).toBeNull();
  expect(document.querySelector('.local-stt-media-partial-actions button')).toBeNull();
  resolveCopy();
  await Promise.resolve();
  await Promise.resolve();
  expect(feedback?.textContent).toBe('');
  expect(startFile).not.toHaveBeenCalled();
  registry.closeAll();
});

it.each(['resolve', 'reject'] as const)(
  'does not show a late copy result after closing (%s)',
  async (outcome) => {
    let resolveCopy!: () => void;
    let rejectCopy!: (error: Error) => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          resolveCopy = resolve;
          rejectCopy = reject;
        }),
    );
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const registry = new MediaTranscriptionModalRegistry();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [],
      getLastError: () => null,
      getLastMediaAiResult: () => null,
      getPartialTranscript: () => 'retained partial',
      insertPartialTranscript: () => false,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isJobActive: () => false,
      wasLastJobCancelled: () => true,
      isDecoderInstalled: async () => true,
      openDecoderInstaller: vi.fn(),
      onManageModels: vi.fn(),
      onManagePresets: vi.fn(),
      startFile: vi.fn(async () => {}),
      subscribeProgress: () => () => {},
    });
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === 'Copy partial transcript',
    );
    expect(button).toBeDefined();
    const feedback = document.querySelector<HTMLElement>('.local-stt-partial-copy-status');
    expect(feedback).not.toBeNull();
    button?.click();
    registry.closeAll();
    if (outcome === 'resolve') resolveCopy();
    else rejectCopy(new Error('private clipboard failure'));
    await Promise.resolve();
    await Promise.resolve();
    expect(feedback?.textContent).toBe('');
  },
);

it('reports clipboard failure for a YouTube partial without removing recovery actions', async () => {
  let active = true;
  const registry = new YouTubeTranscriptModalRegistry();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: vi.fn(async () => {
        throw new Error('private clipboard failure');
      }),
    },
  });
  registry.open({} as never, {
    cancel: async () => {
      active = false;
    },
    getProgress: () => null,
    getPartialTranscript: () => 'retained partial',
    getResultSource: () => null,
    getCompletedVideoId: () => null,
    getAiResult: () => null,
    getError: () => null,
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    insertPartialTranscript: () => false,
    isBusy: () => active,
    isJobActive: () => active,
    wasLastJobCancelled: () => !active,
    onManagePresets: vi.fn(),
    start: vi.fn(async () => {}),
    subscribeProgress: () => () => {},
  });
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Cancel transcription',
  );
  if (!cancel) throw new Error('Missing cancel action');
  cancel.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Copy partial transcript'));
  const copy = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Copy partial transcript',
  );
  copy?.click();
  await vi.waitFor(() =>
    expect(document.querySelector('.local-stt-partial-copy-status')?.textContent).toBe(
      'Could not copy. Try again or insert the partial transcript in its original note.',
    ),
  );
  expect(document.body.textContent).toContain('Insert partial transcript');
  expect(document.body.textContent).not.toContain('private clipboard failure');
  registry.closeAll();
});
