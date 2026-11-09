// @vitest-environment jsdom
import type { App } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ activate: vi.fn(), providerSelected: false }));
vi.mock('obsidian', () => ({
  getLanguage: () => 'en',
  Setting: class {
    constructor(private readonly parent: HTMLElement) {}
    setName(): this {
      return this;
    }
    addButton(callback: (button: { setButtonText: () => { onClick: () => void } }) => void): this {
      this.parent.append(document.createElement('button'));
      callback({ setButtonText: () => ({ onClick: () => {} }) });
      return this;
    }
  },
}));
vi.mock('../src/ui/llm-daily-controls', () => ({ renderLlmDailyControls: () => {} }));
vi.mock('../src/ui/llm-routing-controls', () => ({
  LlmRoutingControls: class {
    constructor(
      private readonly deps: {
        persist: (mutation: (settings: unknown) => unknown) => Promise<void>;
      },
    ) {}
    render(parent: HTMLElement): void {
      const row = document.createElement('div');
      row.className = 'setting-item';
      const name = document.createElement('div');
      name.className = 'setting-item-name';
      name.textContent = 'Provider';
      const input = document.createElement('input');
      input.setAttribute('aria-label', 'Base URL');
      const button = document.createElement('button');
      button.textContent = 'Link secret';
      button.addEventListener('click', state.activate);
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Provider');
      select.append(new Option('Choose', ''), new Option('Custom', 'custom'));
      select.value = state.providerSelected ? 'custom' : '';
      select.addEventListener('change', () => {
        state.providerSelected = select.value === 'custom';
        void this.deps.persist((settings) => settings);
      });
      row.append(name, input, button, select);
      parent.append(row);
      if (state.providerSelected) {
        const detail = document.createElement('p');
        detail.textContent = 'Custom provider fields';
        parent.append(detail);
      }
    }
    dispose(): void {}
  },
}));

import { renderLlmProviderSettings } from '../src/settings/llm-provider-settings-section';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';

Object.defineProperty(HTMLElement.prototype, 'createDiv', {
  configurable: true,
  value(this: HTMLElement) {
    const el = document.createElement('div');
    this.append(el);
    return el;
  },
});
Object.defineProperty(HTMLElement.prototype, 'empty', {
  configurable: true,
  value(this: HTMLElement) {
    this.replaceChildren();
  },
});
afterEach(() => {
  document.body.replaceChildren();
  state.activate.mockReset();
  state.providerSelected = false;
});

function setup() {
  const parent = document.createElement('div');
  document.body.append(parent);
  const dispose = renderLlmProviderSettings(parent, {
    app: {} as App,
    feedback: { show: vi.fn() },
    getSecret: () => '',
    getSettings: () => DEFAULT_PLUGIN_SETTINGS,
    managePresets: vi.fn(),
    mutatePresetState: vi.fn(async () => {}),
    openContextSettings: vi.fn(),
    openModelSettings: vi.fn(),
    openTimingSettings: vi.fn(),
    persist: vi.fn(async () => {}),
  });
  return { parent, dispose };
}

it('activates a clicked control after the URL field loses focus', () => {
  const { parent, dispose } = setup();
  const input = parent.querySelector('input');
  const button = [...parent.querySelectorAll('button')].find(
    (el) => el.textContent === 'Link secret',
  );
  if (!input || !button) throw new Error('Expected URL and secret controls');
  input.focus();
  button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  button.focus();
  expect(button.isConnected).toBe(true);
  button.click();
  expect(state.activate).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(button);
  dispose();
});

it('shows the selected provider while restoring keyboard focus', async () => {
  const { parent, dispose } = setup();
  const input = parent.querySelector('input');
  const select = parent.querySelector('select');
  if (!input || !select) throw new Error('Expected URL and provider controls');
  input.focus();
  select.focus();
  select.value = 'custom';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(parent.textContent).toContain('Custom provider fields'));
  expect(document.activeElement).toBe(parent.querySelector('select'));
  dispose();
});
