// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';

const menuState = vi.hoisted(() => ({ items: [] as Array<{ title: string; click: () => void }> }));
vi.mock('obsidian', () => ({
  getLanguage: () => 'en',
  setIcon: (element: HTMLElement, icon: string) => element.setAttribute('data-icon', icon),
  Setting: class {
    readonly settingEl = document.createElement('div');
    readonly infoEl = document.createElement('div');
    readonly controlEl = document.createElement('div');
    constructor(parent: HTMLElement) {
      this.settingEl.className = 'setting-item';
      this.infoEl.className = 'setting-item-info';
      this.controlEl.className = 'setting-item-control';
      this.settingEl.append(this.infoEl, this.controlEl);
      parent.append(this.settingEl);
    }
    setClass(name: string) {
      this.settingEl.classList.add(name);
      return this;
    }
  },
  Menu: class {
    addItem(
      callback: (item: {
        setTitle(title: string): unknown;
        onClick(click: () => void): unknown;
      }) => void,
    ) {
      const entry = { title: '', click: () => {} };
      const item = {
        setTitle(title: string) {
          entry.title = title;
          return item;
        },
        onClick(click: () => void) {
          entry.click = click;
          return item;
        },
      };
      callback(item);
      menuState.items.push(entry);
      return this;
    }
    showAtPosition() {
      return this;
    }
  },
}));

import type { ModelInstallManager } from '../src/models/model-install-manager';
import { renderModelSection } from '../src/settings/model-settings-section';
import { renderModelSummaryRow } from '../src/settings/model-summary-row';

Object.assign(HTMLElement.prototype, {
  empty(this: HTMLElement) {
    this.replaceChildren();
  },
  hide(this: HTMLElement) {
    this.hidden = true;
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
  createSpan(
    this: HTMLElement,
    options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
  ) {
    return this.createEl('span', options);
  },
});

it('keeps the focused speech summary button after a model update', () => {
  const host = document.createElement('div');
  document.body.append(host);
  let notify = () => {};
  const manager = {
    getState: () => ({
      selectedModel: null,
      selectedModelCapabilities: { status: 'none' },
      activeInstall: null,
      catalog: { models: [] },
    }),
    subscribe: (listener: () => void) => {
      notify = listener;
      return () => {};
    },
  } as unknown as ModelInstallManager;
  const dispose = renderModelSection(host, manager, {
    onManageModels: vi.fn(),
    onExternalFile: vi.fn(),
    onModelInfo: null,
  });
  host.querySelector<HTMLButtonElement>('.local-stt-model-summary-open')?.focus();
  notify();
  expect(document.activeElement).toBe(host.querySelector('.local-stt-model-summary-open'));
  dispose();
  host.remove();
});

it('opens the task picker or distinct menu actions without nested or duplicate buttons', () => {
  menuState.items.length = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const openPicker = vi.fn();
  const openDetails = vi.fn();
  const openExternal = vi.fn();
  renderModelSummaryRow(host, {
    taskLabel: 'Speech to text',
    modelName: 'NVIDIA Nemotron English 560 ms',
    icon: 'mic',
    streaming: true,
    status: null,
    onOpen: openPicker,
    actions: [
      { label: 'Model details', onSelect: openDetails },
      { label: 'Use external file', onSelect: openExternal },
    ],
  });
  const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons).toHaveLength(2);
  expect(host.querySelector('button button')).toBeNull();
  expect(buttons[0]?.textContent).toContain('NVIDIA Nemotron English 560 ms');
  expect(buttons[0]?.textContent).toContain('Streaming');
  buttons[0]?.focus();
  buttons[0]?.click();
  expect(openPicker).toHaveBeenCalledOnce();
  buttons[1]?.click();
  expect(openPicker).toHaveBeenCalledOnce();
  expect(menuState.items.map((item) => item.title)).toEqual(['Model details', 'Use external file']);
  menuState.items[0]?.click();
  menuState.items[1]?.click();
  expect(openDetails).toHaveBeenCalledOnce();
  expect(openExternal).toHaveBeenCalledOnce();
  host.remove();
});
