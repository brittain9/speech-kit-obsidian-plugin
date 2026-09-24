import { describe, expect, it, vi } from 'vitest';

import {
  FIRST_RUN_SCRATCH_NOTE_PATH,
  type FirstRunDictationTargetDependencies,
  prepareFirstRunDictationTarget,
} from '../src/setup/first-run-dictation-target';

interface FakeVault {
  create: ReturnType<typeof vi.fn>;
  files: Array<FakeFile | FakeFolder>;
  getAbstractFileByPath: (path: string) => FakeFile | FakeFolder | null;
  getAllLoadedFiles: () => Array<FakeFile | FakeFolder>;
  getMarkdownFiles: () => FakeFile[];
}

interface FakeFile {
  extension: string;
  path: string;
}

interface FakeFolder {
  children: unknown[];
  path: string;
}

function file(path: string, extension = 'md'): FakeFile {
  return { extension, path };
}

function createHarness(
  options: {
    exact?: FakeFile | FakeFolder | null;
    files?: Array<FakeFile | FakeFolder>;
    markdownFiles?: FakeFile[];
    targetAfterOpen?: boolean;
  } = {},
) {
  const files = [...(options.files ?? [])];
  const markdownFiles = [
    ...(options.markdownFiles ??
      files.filter((candidate): candidate is FakeFile => 'extension' in candidate)),
  ];
  let hasTarget = false;
  const vault: FakeVault = {
    create: vi.fn(async (path: string) => {
      const created = file(path);
      files.push(created);
      markdownFiles.push(created);
      return created;
    }),
    files,
    getAbstractFileByPath: vi.fn((path: string) =>
      path === FIRST_RUN_SCRATCH_NOTE_PATH ? (options.exact ?? null) : null,
    ),
    getAllLoadedFiles: () => files,
    getMarkdownFiles: () => markdownFiles,
  };
  const openLinkText = vi.fn(async () => {
    hasTarget = options.targetAfterOpen ?? true;
  });
  return {
    dependencies: {
      hasTarget: () => hasTarget,
      vault,
      workspace: { openLinkText },
    } as unknown as FirstRunDictationTargetDependencies,
    openLinkText,
    vault,
  };
}

describe('first-run dictation target', () => {
  it('creates one root scratch note and reuses it on later attempts', async () => {
    const harness = createHarness();

    await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).resolves.toBe(
      true,
    );
    await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).resolves.toBe(
      true,
    );

    expect(harness.vault.create).toHaveBeenCalledOnce();
    expect(harness.vault.create).toHaveBeenCalledWith(FIRST_RUN_SCRATCH_NOTE_PATH, '# Scratch');
    expect(harness.openLinkText).toHaveBeenCalledOnce();
    expect(harness.openLinkText).toHaveBeenCalledWith(FIRST_RUN_SCRATCH_NOTE_PATH, '', true, {
      active: true,
      state: { mode: 'source' },
    });
  });

  it.each(['create', 'open'] as const)(
    'propagates a safe %s failure to setup recovery',
    async (operation) => {
      const harness = createHarness();
      const cause = new Error(`${operation} failed`);
      if (operation === 'create') {
        harness.vault.create.mockRejectedValue(cause);
      } else {
        harness.openLinkText.mockRejectedValue(cause);
      }

      await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).rejects.toBe(
        cause,
      );
    },
  );

  it('does not create a scratch note when a nested Markdown note exists', async () => {
    const nested = file('Notes/existing.md');
    const harness = createHarness({ files: [nested], markdownFiles: [nested] });

    await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).resolves.toBe(
      false,
    );
    expect(harness.vault.create).not.toHaveBeenCalled();
    expect(harness.openLinkText).not.toHaveBeenCalled();
  });

  it('reopens an existing root scratch note without creating another one', async () => {
    const scratch = file(FIRST_RUN_SCRATCH_NOTE_PATH);
    const harness = createHarness({ exact: scratch, files: [scratch], markdownFiles: [scratch] });

    await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).resolves.toBe(
      true,
    );
    expect(harness.vault.create).not.toHaveBeenCalled();
    expect(harness.openLinkText).toHaveBeenCalledOnce();
  });

  it.each([
    ['folder collision', { children: [], path: FIRST_RUN_SCRATCH_NOTE_PATH } as FakeFolder],
    ['non-Markdown collision', file(FIRST_RUN_SCRATCH_NOTE_PATH, 'txt')],
  ])('never overwrites a %s at the scratch path', async (_label, collision) => {
    const harness = createHarness({ exact: collision, files: [], markdownFiles: [] });

    await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).resolves.toBe(
      false,
    );
    expect(harness.vault.create).not.toHaveBeenCalled();
    expect(harness.openLinkText).not.toHaveBeenCalled();
  });

  it('never overwrites a path that differs only by case', async () => {
    const collision = file('speech kit scratch note.md');
    const harness = createHarness({ files: [collision], markdownFiles: [collision] });

    await expect(prepareFirstRunDictationTarget(harness.dependencies, '# Scratch')).resolves.toBe(
      false,
    );
    expect(harness.vault.create).not.toHaveBeenCalled();
    expect(harness.openLinkText).not.toHaveBeenCalled();
  });
});
