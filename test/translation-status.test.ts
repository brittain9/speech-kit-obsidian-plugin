import { describe, expect, it, vi } from 'vitest';

import type { TranslationJobState } from '../src/translation/translation-job';
import {
  TranslationStatusController,
  updateDetachedTranslationStatus,
} from '../src/translation/translation-status';
import { TestElement } from './__mocks__/obsidian';

describe('TranslationStatusController', () => {
  it('forwards the preserve-focus option through the production status adapter', () => {
    const update = vi.fn();
    const reopen = vi.fn();
    const options = { preserveFocus: true };

    updateDetachedTranslationStatus({ update } as never, null, reopen, options);

    expect(update).toHaveBeenCalledExactlyOnceWith(null, reopen, options);
  });

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
    const liveRegion = status.querySelector('.local-stt-translation-status__live');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('type')).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe(
      'Reopen translation: Translating block 1 of 3…',
    );
    expect(button?.getAttribute('title')).toBe('Reopen translation: Translating block 1 of 3…');
    expect(liveRegion !== null && button?.contains(liveRegion)).toBe(false);
    expect(liveRegion?.getAttribute('role')).toBe('status');
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion?.getAttribute('aria-atomic')).toBe('true');
    expect(liveRegion?.textContent).toBe('Translating block 1 of 3…');
    expect(button?.querySelector('span')?.textContent).toBe('Translating block 1 of 3…');

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
    const liveRegion = status.querySelector('.local-stt-translation-status__live');
    button?.focus();

    controller.update(second, secondReopen);

    expect(status.querySelector('button')).toBe(button);
    expect(status.querySelector('.local-stt-translation-status__live')).toBe(liveRegion);
    expect(status.ownerDocument.activeElement).toBe(button);
    expect(liveRegion?.textContent).toBe('Translation ready.');
    expect(button?.getAttribute('aria-label')).toBe('Reopen translation: Translation ready.');
  });

  it('hides and disables the action when there is no detached job', () => {
    const status = new TestElement();
    const controller = new TranslationStatusController(status as unknown as HTMLElement);
    controller.update({ phase: 'cancelled' }, vi.fn());
    const button = status.querySelector('button');
    const liveRegion = status.querySelector('.local-stt-translation-status__live');

    controller.update(null, vi.fn());

    expect(status.style.display).toBe('none');
    expect(status.querySelector('button')).toBe(button);
    expect(status.querySelector('.local-stt-translation-status__live')).toBe(liveRegion);
    expect(button?.disabled).toBe(true);
    expect(liveRegion?.getAttribute('role')).toBe('status');
    expect(liveRegion?.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion?.textContent).toBe('');
  });
});
