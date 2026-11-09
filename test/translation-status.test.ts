import { expect, it, vi } from 'vitest';
import { TranslationStatusController } from '../src/translation/translation-status';
import { TestElement } from './__mocks__/obsidian';

it('opens detached translation through a native button and announces changes separately', async () => {
  const element = new TestElement();
  const reopen = vi.fn();
  const status = new TranslationStatusController(element as unknown as HTMLElement);
  status.update({ phase: 'translating', completed: 1, total: 3, startedAt: 0 }, reopen);
  const button = element.querySelector('button');
  const live = element.findByClass('local-stt-status-live');
  expect(button?.attributes.get('aria-label')).toContain('Reopen');
  expect(live?.attributes.get('aria-live')).toBe('polite');
  expect(live?.attributes.get('role')).toBe('status');
  button?.focus();
  await button?.click();
  expect(reopen).toHaveBeenCalledOnce();
  status.update(null, reopen, { preserveFocus: true });
  status.update({ phase: 'completed', text: 'public', sourceUnitsKept: 0 }, reopen);
  expect(element.ownerDocument.activeElement).toBe(button);
});
