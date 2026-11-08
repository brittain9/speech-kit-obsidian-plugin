import { describe, expect, it, vi } from 'vitest';
import { renderMediaProgressStatus } from '../src/ui/media-progress-presenter';

function statusElement() {
  return {
    empty: vi.fn(),
    removeAttribute: vi.fn(),
    setAttribute: vi.fn(),
    setText: vi.fn(),
    toggle: vi.fn(),
  } as unknown as HTMLElement;
}

describe('media progress presenter', () => {
  it('renders every production phase accessibly and clears the persistent surface at idle', () => {
    const element = statusElement();
    for (const phase of [
      'acquire',
      'decode',
      'transcribe',
      'format',
      'ai_processing',
      'insert',
    ] as const) {
      renderMediaProgressStatus(element, { phase });
    }
    expect(element.setAttribute).toHaveBeenCalledWith('role', 'status');
    expect(element.setAttribute).toHaveBeenCalledWith('aria-live', 'polite');
    expect(element.toggle).toHaveBeenCalledWith(true);
    expect(element.setText).toHaveBeenLastCalledWith(expect.stringContaining('Inserting'));

    renderMediaProgressStatus(element, null);
    expect(element.toggle).toHaveBeenLastCalledWith(false);
    expect(element.removeAttribute).toHaveBeenCalledWith('aria-live');
  });

  it('does not accept or render source metadata', () => {
    const element = statusElement();
    renderMediaProgressStatus(element, { phase: 'acquire' });
    const renderedText = vi.mocked(element.setText).mock.calls.at(-1)?.[0];
    expect(renderedText).not.toMatch(/path|filename|source|token|url/i);
  });
});
