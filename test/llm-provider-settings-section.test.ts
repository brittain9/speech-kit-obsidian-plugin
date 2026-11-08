import { expect, it, vi } from 'vitest';
import { renderLlmProviderSettings } from '../src/settings/llm-provider-settings-section';
import { Setting, TestElement } from './__mocks__/obsidian';

it('opens the provider controls from settings', async () => {
  Setting.reset();
  const openSidebar = vi.fn();
  renderLlmProviderSettings(new TestElement() as unknown as HTMLElement, openSidebar);
  await Setting.buttonNamed('Open sidebar').click();
  expect(openSidebar).toHaveBeenCalledOnce();
});
