import type { Workspace } from 'obsidian';

import { LOCAL_DICTATION_VIEW_TYPE } from './local-dictation-view';

export async function openSpeechKitView(
  workspace: Pick<Workspace, 'getLeavesOfType' | 'getLeftLeaf' | 'revealLeaf'>,
): Promise<boolean> {
  let leaf = workspace.getLeavesOfType(LOCAL_DICTATION_VIEW_TYPE)[0];
  if (leaf === undefined) {
    const available = workspace.getLeftLeaf(false);
    if (available === null) return false;
    leaf = available;
    await leaf.setViewState({ active: true, type: LOCAL_DICTATION_VIEW_TYPE });
  }
  await workspace.revealLeaf(leaf);
  return true;
}
