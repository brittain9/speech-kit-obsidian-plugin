import { describe, expect, it, vi } from 'vitest';
import { renderModelStoreSetting } from '../src/settings/model-store-setting';
import { Setting, TestElement } from './__mocks__/obsidian';

describe('model store setting', () => {
  it('changes the store only when Apply is selected', async () => {
    Setting.reset();
    const changeModelStore = vi.fn(async (_path: string) => {});
    renderModelStoreSetting(new TestElement() as unknown as HTMLElement, {
      currentPath: '/old-models',
      changeModelStore,
      feedback: { show: vi.fn() },
    });
    const setting = Setting.named('Model store folder override');
    const apply = Setting.buttonNamed('Apply');
    expect(apply.disabled).toBe(true);
    setting.onlyText().change('/new-');
    setting.onlyText().change('/new-models');
    expect(changeModelStore).not.toHaveBeenCalled();
    await apply.click();
    expect(changeModelStore).toHaveBeenCalledExactlyOnceWith('/new-models');
  });

  it('keeps the entered path available for retry when applying fails', async () => {
    Setting.reset();
    const changeModelStore = vi.fn(async () => {
      throw new Error('invalid path');
    });
    const show = vi.fn();
    renderModelStoreSetting(new TestElement() as unknown as HTMLElement, {
      currentPath: '/old-models',
      changeModelStore,
      feedback: { show },
    });
    const setting = Setting.named('Model store folder override');
    setting.onlyText().change('/bad-models');
    await Setting.buttonNamed('Apply').click();
    expect(setting.onlyText().getValue()).toBe('/bad-models');
    expect(Setting.buttonNamed('Apply').disabled).toBe(false);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' }));
  });
});
