import type { Workspace } from 'obsidian';
import { expect, it, vi } from 'vitest';

import { openSpeechKitView } from '../src/ui/open-speech-kit-view';

it('reveals an existing Speech Kit view without creating a duplicate', async () => {
  const leaf = { setViewState: vi.fn(async () => {}) };
  const workspace = {
    getLeavesOfType: vi.fn(() => [leaf]),
    getLeftLeaf: vi.fn(),
    revealLeaf: vi.fn(async () => {}),
  };
  expect(await openSpeechKitView(workspace as unknown as Workspace)).toBe(true);
  expect(workspace.getLeftLeaf).not.toHaveBeenCalled();
  expect(leaf.setViewState).not.toHaveBeenCalled();
  expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
});

it('creates and reveals controls when the sidebar has no Speech Kit view', async () => {
  const leaf = { setViewState: vi.fn(async () => {}) };
  const workspace = {
    getLeavesOfType: () => [],
    getLeftLeaf: vi.fn(() => leaf),
    revealLeaf: vi.fn(async () => {}),
  };
  expect(await openSpeechKitView(workspace as unknown as Workspace)).toBe(true);
  expect(leaf.setViewState).toHaveBeenCalledWith({ active: true, type: 'local-dictation-sidebar' });
  expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
});

it('reports unavailable workspace space without pretending controls were opened', async () => {
  const workspace = {
    getLeavesOfType: () => [],
    getLeftLeaf: () => null,
    revealLeaf: vi.fn(),
  };
  expect(await openSpeechKitView(workspace as unknown as Workspace)).toBe(false);
  expect(workspace.revealLeaf).not.toHaveBeenCalled();
});

it.each(['setViewState', 'revealLeaf'] as const)(
  'reports failure when the workspace rejects %s',
  async (method) => {
    const leaf = { setViewState: vi.fn(async () => {}) };
    const workspace = {
      getLeavesOfType: () => [],
      getLeftLeaf: () => leaf,
      revealLeaf: vi.fn(async () => {}),
    };
    (method === 'setViewState' ? leaf.setViewState : workspace.revealLeaf).mockRejectedValueOnce(
      new Error('workspace changed'),
    );
    expect(await openSpeechKitView(workspace as unknown as Workspace)).toBe(false);
  },
);
