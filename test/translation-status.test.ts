import { describe, expect, it, vi } from 'vitest';

import type { TranslationJobState } from '../src/translation/translation-job';
import { TranslationStatusController } from '../src/translation/translation-status';
import { TestElement } from './__mocks__/obsidian';

describe('TranslationStatusController', () => {
  it('exposes a keyboard-operable button with a polite translation status region', async () => {
    const status = new TestElement();
    const controller = new TranslationStatusController(status as unknown as HTMLElement);
    const reopen = vi.fn();
    const translating: TranslationJobState = {
      completed: 1,
      phase: 'translating',
      startedAt: 0,
      total: 3,
    };

    controller.update(translating, reopen);

    const button = status.querySelector('button');
    const liveRegion = status.querySelector('span');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe(
      'Reopen translation: Translating block 1 of 3…',
    );
    expect(button?.getAttribute('title')).toBe('Reopen translation: Translating block 1 of 3…');
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion?.getAttribute('aria-atomic')).toBe('true');
    expect(liveRegion?.textContent).toBe('Translating block 1 of 3…');

    await button?.click();
    expect(reopen).toHaveBeenCalledOnce();
  });

  it('updates live text without replacing the focused button', () => {
    const status = new TestElement();
    const controller = new TranslationStatusController(status as unknown as HTMLElement);
    const firstReopen = vi.fn();
    const secondReopen = vi.fn();
    const first: TranslationJobState = {
      completed: 1,
      phase: 'translating',
      startedAt: 0,
      total: 3,
    };
    const second: TranslationJobState = {
      phase: 'completed',
      sourceUnitsKept: 0,
      text: 'Traduzca esto.',
    };

    controller.update(first, firstReopen);
    const button = status.querySelector('button');
    const liveRegion = status.querySelector('span');
    button?.focus();

    controller.update(second, secondReopen);

    expect(status.querySelector('button')).toBe(button);
    expect(status.querySelector('span')).toBe(liveRegion);
    expect(status.ownerDocument.activeElement).toBe(button);
    expect(liveRegion?.textContent).toBe('Translation ready.');
    expect(button?.getAttribute('aria-label')).toBe('Reopen translation: Translation ready.');
  });

  it('hides and disables the action when there is no detached job', () => {
    const status = new TestElement();
    const controller = new TranslationStatusController(status as unknown as HTMLElement);
    controller.update({ phase: 'cancelled' }, vi.fn());

    controller.update(null, vi.fn());

    expect(status.style.display).toBe('none');
    expect(status.querySelector('button')?.disabled).toBe(true);
    expect(status.querySelector('span')?.textContent).toBe('');
  });
});
