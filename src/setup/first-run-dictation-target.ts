import type { TAbstractFile, TFile, Vault, Workspace } from 'obsidian';

export const FIRST_RUN_SCRATCH_NOTE_PATH = 'Speech Kit scratch note.md';

export interface FirstRunDictationTargetDependencies {
  hasTarget: () => boolean;
  vault: Pick<Vault, 'create' | 'getAbstractFileByPath' | 'getAllLoadedFiles' | 'getMarkdownFiles'>;
  workspace: Pick<Workspace, 'openLinkText'>;
}

export async function prepareFirstRunDictationTarget(
  dependencies: FirstRunDictationTargetDependencies,
  content: string,
): Promise<boolean> {
  if (dependencies.hasTarget()) return true;

  const scratchPath = FIRST_RUN_SCRATCH_NOTE_PATH;
  const exact = dependencies.vault.getAbstractFileByPath(scratchPath);
  const files = dependencies.vault.getAllLoadedFiles();
  const hasPathCaseCollision = files.some(
    (file) =>
      file.path !== scratchPath &&
      file.path.toLocaleLowerCase() === scratchPath.toLocaleLowerCase(),
  );
  if (hasPathCaseCollision) return false;

  const exactFile = isMarkdownFile(exact) && exact.path === scratchPath ? exact : null;
  const markdownFiles = dependencies.vault.getMarkdownFiles();
  const onlyKnownScratchNote =
    exactFile !== null && markdownFiles.every((file) => file.path === scratchPath);
  if (
    (exact !== null && onlyKnownScratchNote === false) ||
    (exact === null && markdownFiles.length > 0)
  ) {
    return false;
  }

  if (exactFile === null) {
    await dependencies.vault.create(scratchPath, content);
  }
  await dependencies.workspace.openLinkText(scratchPath, '', true, {
    active: true,
    state: { mode: 'source' },
  });
  return dependencies.hasTarget();
}

function isMarkdownFile(value: TAbstractFile | null): value is TFile {
  return (
    value !== null &&
    typeof value === 'object' &&
    'extension' in value &&
    typeof value.extension === 'string' &&
    value.extension.toLocaleLowerCase() === 'md'
  );
}
