// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PushToTalkControl } from '../src/ui/push-to-talk-control';

function pointer(type: string, pointerId = 1): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    button: 0,
    pointerId,
  });
}

describe('push-to-talk control', () => {
  it('holds once and releases on pointer cancellation or lost focus', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.setPointerCapture = vi.fn();
    const release = vi.fn(async () => {});
    const start = vi.fn(() => ({ release }));
    const control = new PushToTalkControl(button, start);
    control.setEnabled(true);
    button.dispatchEvent(pointer('pointerdown'));
    button.dispatchEvent(pointer('pointerdown'));
    expect(start).toHaveBeenCalledOnce();
    button.dispatchEvent(pointer('pointercancel'));
    window.dispatchEvent(new Event('blur'));
    expect(release).toHaveBeenCalledOnce();
    control.dispose();
    button.remove();
  });

  it('ignores keyboard repeat and stops when the focused control loses focus', () => {
    const button = document.createElement('button');
    document.body.append(button);
    const release = vi.fn(async () => {});
    const start = vi.fn(() => ({ release }));
    const control = new PushToTalkControl(button, start);
    control.setEnabled(true);
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true }));
    expect(start).toHaveBeenCalledOnce();
    button.blur();
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(release).toHaveBeenCalledOnce();
    control.dispose();
    button.remove();
  });

  it('releases the owned hold on pointer release, disable, and disposal', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.setPointerCapture = vi.fn();
    const release = vi.fn(async () => {});
    const control = new PushToTalkControl(button, () => ({ release }));
    control.setEnabled(true);
    button.dispatchEvent(pointer('pointerdown'));
    button.dispatchEvent(pointer('pointerup'));
    expect(release).toHaveBeenCalledTimes(1);
    button.dispatchEvent(pointer('pointerdown'));
    control.setEnabled(false);
    expect(release).toHaveBeenCalledTimes(2);
    control.setEnabled(true);
    button.dispatchEvent(pointer('pointerdown'));
    control.dispose();
    expect(release).toHaveBeenCalledTimes(3);
  });
});
