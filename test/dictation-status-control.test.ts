import { expect, it, vi } from 'vitest';
import type { DictationWorkflowStatus } from '../src/dictation/dictation-session-controller';
import { mountDictationStatusControl } from '../src/ui/dictation-workflow-status';
import { TestElement } from './__mocks__/obsidian';

const idle: DictationWorkflowStatus = {
  capture: null,
  transcribing: false,
  finishing: false,
  providerCleanup: false,
  queue: 'normal',
};

it('keeps a native capture action available without a ribbon and delegates every state to the shared toggle', async () => {
  const element = new TestElement();
  const toggle = vi.fn(async () => {});
  const control = mountDictationStatusControl(element as unknown as HTMLElement, toggle);
  control.render('idle', idle);
  const button = element.querySelector('button');
  expect(button?.tagName).toBe('BUTTON');
  expect(button?.attributes.get('type')).toBe('button');
  expect(button?.textContent).toBe('Dictate');
  expect(button?.attributes.get('aria-label')).toBe('Speech Kit: Start dictation');
  expect(element.style.display).not.toBe('none');
  await button?.click();
  expect(toggle).toHaveBeenCalledTimes(1);
  control.render('starting', { ...idle, capture: 'starting' });
  expect(button?.textContent).toBe('Cancel start');
  await button?.click();
  control.render('listening', { ...idle, capture: 'listening' });
  expect(button?.textContent).toBe('Stop');
  expect(button?.attributes.get('aria-label')).toBe('Speech Kit: Stop dictation');
  await button?.click();
  control.render('error', idle);
  expect(button?.textContent).toBe('Retry');
  expect(button?.attributes.get('aria-label')).toBe('Speech Kit: Retry dictation');
  await button?.click();
  expect(toggle).toHaveBeenCalledTimes(4);
  control.dispose();
});

it('keeps older finishing work separate from capture and preserves the focused button across updates', async () => {
  const element = new TestElement();
  const toggle = vi.fn(async () => {});
  const control = mountDictationStatusControl(element as unknown as HTMLElement, toggle);
  control.render('idle', idle);
  const button = element.querySelector('button');
  button?.focus();
  control.render('idle', { ...idle, finishing: true, providerCleanup: true });
  expect(button?.textContent).toBe('Dictate');
  expect(element.querySelector('button')).toBe(button);
  expect(element.ownerDocument.activeElement).toBe(button);
  expect(
    element.children.find((child) => child.attributes.get('role') === 'status')?.textContent,
  ).toContain('Finishing captured speech');
  await button?.click();
  expect(toggle).toHaveBeenCalledOnce();
  control.render('listening', { ...idle, capture: 'listening', finishing: true });
  expect(button?.textContent).toBe('Stop');
  expect(element.ownerDocument.activeElement).toBe(button);
  control.dispose();
  await button?.click();
  expect(toggle).toHaveBeenCalledOnce();
  control.render('idle', idle);
  expect(element.children).toHaveLength(0);
});

it('can hide and restore the control without duplicating its listener or changing capture action', async () => {
  const element = new TestElement();
  const toggle = vi.fn(async () => {});
  const control = mountDictationStatusControl(element as unknown as HTMLElement, toggle);
  control.render('listening', { ...idle, capture: 'listening' }, false);
  const button = element.querySelector('button');
  expect(button?.style.display).toBe('none');
  expect(element.style.display).not.toBe('none');
  for (let i = 0; i < 3; i++) {
    control.render('listening', { ...idle, capture: 'listening' }, true);
    expect(element.querySelector('button')).toBe(button);
    control.render('listening', { ...idle, capture: 'listening' }, false);
  }
  control.render('listening', { ...idle, capture: 'listening' }, true);
  expect(button?.textContent).toBe('Stop');
  await button?.click();
  expect(toggle).toHaveBeenCalledOnce();
  control.render('idle', idle, false);
  expect(element.style.display).toBe('none');
  control.dispose();
});
