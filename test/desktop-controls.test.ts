import { describe, expect, it, vi } from 'vitest';
import { DesktopControls } from '../src/desktop/desktop-controls';

describe('desktop controls', () => {
  function setup() {
    const actions = {
      toggle: vi.fn(async () => {}),
      openTarget: vi.fn(),
      openSettings: vi.fn(),
      notify: vi.fn(),
      sound: vi.fn(),
    };
    const desktop = new DesktopControls(actions);
    return { desktop, actions };
  }
  it('rejects actions from old configurations and duplicate activations', async () => {
    const { desktop, actions } = setup();
    desktop.setGeneration('current');
    await desktop.handleAction({ generation: 'old', actionId: 1, action: 'toggle' });
    await desktop.handleAction({ generation: 'current', actionId: 1, action: 'toggle' });
    await desktop.handleAction({ generation: 'current', actionId: 1, action: 'toggle' });
    expect(actions.toggle).toHaveBeenCalledTimes(1);
  });
  it('contains feedback failures without interrupting controls', async () => {
    const { desktop, actions } = setup();
    actions.sound.mockImplementation(() => {
      throw new Error('audio unavailable');
    });
    desktop.setGeneration('current');
    expect(() => desktop.update('recording', true, false)).not.toThrow();
    await desktop.handleAction({ generation: 'current', actionId: 1, action: 'toggle' });
    expect(actions.toggle).toHaveBeenCalledOnce();
  });
  it('blocks a desktop start while finishing but allows opening the note', async () => {
    const { desktop, actions } = setup();
    desktop.setGeneration('current');
    desktop.update('finishing', false, false);
    await desktop.handleAction({ generation: 'current', actionId: 1, action: 'toggle' });
    await desktop.handleAction({ generation: 'current', actionId: 2, action: 'open_target' });
    expect(actions.toggle).not.toHaveBeenCalled();
    expect(actions.openTarget).toHaveBeenCalledOnce();
  });
  it('only cues actual recording transitions and hides private text', () => {
    const { desktop, actions } = setup();
    desktop.update('starting', true, false);
    expect(actions.sound).not.toHaveBeenCalled();
    desktop.update('recording', true, false);
    desktop.update('recording', true, false);
    desktop.update('finishing', true, false);
    expect(actions.sound.mock.calls).toEqual([['start'], ['stop']]);
    expect(actions.notify.mock.calls).toEqual([['recording'], ['stopped']]);
  });
});
