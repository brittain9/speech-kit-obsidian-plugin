export function createReleaseDraft(options: {
  repository: string | undefined;
  tag: string | undefined;
  notesPath: string | undefined;
  releaseDir: string;
  run?: (args: string[]) => string;
}): Promise<string>;
