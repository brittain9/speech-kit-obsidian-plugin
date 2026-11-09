import { expect, it } from 'vitest';
import { renderDictationWorkflowStatus } from '../src/ui/dictation-workflow-status';
import { TestElement } from './__mocks__/obsidian';

it('shows listening and local processing together, with real queue pressure', () => {
  const element = new TestElement();
  renderDictationWorkflowStatus(element as unknown as HTMLElement, {
    capture: 'listening',
    transcribing: true,
    finishing: false,
    providerCleanup: false,
    queue: 'catching_up',
  });
  expect(element.textContent).toContain('Listening');
  expect(element.textContent).toContain('Transcribing locally');
  expect(element.textContent).toContain('Catching up');
  expect(element.attributes.get('aria-live')).toBe('polite');
  expect(element.attributes.get('role')).toBe('status');
});

it('separates retained local work from provider processing and clears after completion', () => {
  const element = new TestElement();
  renderDictationWorkflowStatus(element as unknown as HTMLElement, {
    capture: null,
    transcribing: false,
    finishing: true,
    providerCleanup: true,
    queue: 'normal',
  });
  expect(element.textContent).toContain('Finishing captured speech');
  expect(element.textContent).toContain('Provider processing');
  expect(element.textContent).not.toContain('Catching up');
  renderDictationWorkflowStatus(element as unknown as HTMLElement, {
    capture: null,
    transcribing: false,
    finishing: false,
    providerCleanup: false,
    queue: 'normal',
  });
  expect(element.textContent).toBe('');
});
