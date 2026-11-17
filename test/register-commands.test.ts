import { type Command, type Editor, Platform, type Plugin } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';

import { registerCommands, registerEditorMenu } from '../src/commands/register-commands';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';

describe('registerCommands', () => {
  it('hides disabled feature commands dynamically while preserving active playback controls', () => {
    const commands: Command[] = [];
    let settings = {
      ...DEFAULT_PLUGIN_SETTINGS,
      readAloudEnabled: false,
      translationEnabled: false,
    };
    const readAloud = vi.fn(async () => {});
    const translateNote = vi.fn();
    registerCommands({
      getSettings: () => settings,
      plugin: { addCommand: (command: Command) => commands.push(command) } as unknown as Plugin,
      openSpeechKit: vi.fn(async () => {}),
      cancelAudioFile: vi.fn(async () => {}),
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance: vi.fn(),
      clearRawTranscriptRecovery: vi.fn(),
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance: vi.fn(),
      copyRawTranscript: vi.fn(),
      hasLastUtterance: () => false,
      hasRawTranscriptRecovery: () => false,
      isAudioFileTranscriptionActive: () => false,
      isReadAloudActive: () => true,
      readAloud,
      readAloudFromCursor: vi.fn(async () => {}),
      reinsertLastUtterance: vi.fn(),
      restoreRawTranscript: vi.fn(),
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile: vi.fn(async () => {}),
      translateNote,
      translateSelection: vi.fn(),
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });
    const editor = { somethingSelected: () => true } as Editor;
    for (const id of [
      'translate-note',
      'translate-selection',
      'read-aloud',
      'read-aloud-from-cursor',
    ]) {
      const command = commands.find((command) => command.id === id);
      expect(command?.editorCheckCallback?.(true, editor, {} as never)).toBe(false);
      expect(command?.editorCheckCallback?.(false, editor, {} as never)).toBe(false);
    }
    expect(readAloud).not.toHaveBeenCalled();
    expect(translateNote).not.toHaveBeenCalled();
    expect(commands.find(({ id }) => id === 'stop-read-aloud')?.checkCallback?.(true)).toBe(true);
    expect(commands.find(({ id }) => id === 'pause-resume-read-aloud')?.checkCallback?.(true)).toBe(
      true,
    );
    settings = { ...settings, readAloudEnabled: true, translationEnabled: true };
    expect(
      commands
        .find(({ id }) => id === 'read-aloud')
        ?.editorCheckCallback?.(false, editor, {} as never),
    ).toBe(true);
    expect(
      commands
        .find(({ id }) => id === 'translate-note')
        ?.editorCheckCallback?.(false, editor, {} as never),
    ).toBe(true);
    expect(readAloud).toHaveBeenCalledOnce();
    expect(translateNote).toHaveBeenCalledOnce();
  });

  it('exposes recovery commands only while a retained utterance is available', async () => {
    const commands: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
      }),
    } as unknown as Plugin;
    let available = false;
    const clearLastUtterance = vi.fn(() => {
      available = false;
    });
    const reinsertLastUtterance = vi.fn((_editor: Editor) => {});
    const copyLastUtterance = vi.fn();
    const openSpeechKit = vi.fn(async () => {});
    const translateNote = vi.fn();
    const translateSelection = vi.fn();
    registerCommands({
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      cancelAudioFile: vi.fn(async () => {}),
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance,
      clearRawTranscriptRecovery: vi.fn(),
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance,
      copyRawTranscript: vi.fn(),
      hasLastUtterance: () => available,
      hasRawTranscriptRecovery: () => false,
      isAudioFileTranscriptionActive: () => false,
      isReadAloudActive: () => false,
      openSpeechKit,
      plugin,
      readAloud: vi.fn(async () => {}),
      readAloudFromCursor: vi.fn(async () => {}),
      reinsertLastUtterance,
      restoreRawTranscript: vi.fn(),
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile: vi.fn(async () => {}),
      translateNote,
      translateSelection,
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });
    const reinsertCommand = commands.find(({ id }) => id === 'reinsert-last-utterance');
    const copyCommand = commands.find(({ id }) => id === 'copy-last-utterance');
    const clearCommand = commands.find(({ id }) => id === 'clear-last-utterance');
    const editor = {} as Editor;

    const translationEditor = { somethingSelected: () => true } as Editor;
    const view = { file: { path: 'Notes/source.md' } } as never;
    commands
      .find(({ id }) => id === 'translate-note')
      ?.editorCheckCallback?.(false, translationEditor, view);
    commands
      .find(({ id }) => id === 'translate-selection')
      ?.editorCheckCallback?.(false, translationEditor, view);
    expect(translateNote).toHaveBeenCalledWith(translationEditor, view);
    expect(translateSelection).toHaveBeenCalledWith(translationEditor, view);

    await commands.find(({ id }) => id === 'open-speech-kit')?.callback?.();
    expect(openSpeechKit).toHaveBeenCalledOnce();
    expect(reinsertCommand?.name).toBe('Reinsert last utterance');
    expect(copyCommand?.name).toBe('Copy last utterance');
    expect(clearCommand?.name).toBe('Clear last utterance');
    expect(reinsertCommand?.editorCheckCallback?.(true, editor, {} as never)).toBe(false);
    expect(copyCommand?.checkCallback?.(true)).toBe(false);
    expect(clearCommand?.checkCallback?.(true)).toBe(false);
    expect(reinsertLastUtterance).not.toHaveBeenCalled();
    expect(clearLastUtterance).not.toHaveBeenCalled();

    available = true;
    expect(reinsertCommand?.editorCheckCallback?.(true, editor, {} as never)).toBe(true);
    expect(copyCommand?.checkCallback?.(true)).toBe(true);
    expect(clearCommand?.checkCallback?.(true)).toBe(true);
    expect(reinsertLastUtterance).not.toHaveBeenCalled();
    expect(clearLastUtterance).not.toHaveBeenCalled();

    expect(reinsertCommand?.editorCheckCallback?.(false, editor, {} as never)).toBe(true);
    expect(reinsertLastUtterance).toHaveBeenCalledOnce();
    expect(reinsertLastUtterance).toHaveBeenCalledWith(editor);

    expect(copyCommand?.checkCallback?.(false)).toBe(true);
    expect(copyLastUtterance).toHaveBeenCalledOnce();

    expect(clearCommand?.checkCallback?.(false)).toBe(true);
    expect(clearLastUtterance).toHaveBeenCalledOnce();
    expect(reinsertCommand?.editorCheckCallback?.(true, editor, {} as never)).toBe(false);
    expect(clearCommand?.checkCallback?.(true)).toBe(false);
  });

  it('gates raw transcript recovery commands on one shared availability source', () => {
    const commands: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
      }),
    } as unknown as Plugin;
    let available = false;
    const clearRawTranscriptRecovery = vi.fn(() => {
      available = false;
    });
    const copyRawTranscript = vi.fn();
    const restoreRawTranscript = vi.fn();
    registerCommands({
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      cancelAudioFile: vi.fn(async () => {}),
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance: vi.fn(),
      clearRawTranscriptRecovery,
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance: vi.fn(),
      copyRawTranscript,
      hasLastUtterance: () => false,
      hasRawTranscriptRecovery: () => available,
      isAudioFileTranscriptionActive: () => false,
      isReadAloudActive: () => false,
      openSpeechKit: vi.fn(async () => {}),
      plugin,
      readAloud: vi.fn(async () => {}),
      readAloudFromCursor: vi.fn(async () => {}),
      reinsertLastUtterance: vi.fn(),
      restoreRawTranscript,
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile: vi.fn(async () => {}),
      translateNote: vi.fn(),
      translateSelection: vi.fn(),
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });
    const restoreCommand = commands.find(({ id }) => id === 'restore-raw-transcript');
    const copyCommand = commands.find(({ id }) => id === 'copy-raw-transcript');
    const clearCommand = commands.find(({ id }) => id === 'clear-raw-transcript-recovery');

    expect(restoreCommand?.name).toBe('Restore raw transcript');
    expect(copyCommand?.name).toBe('Copy raw transcript');
    expect(clearCommand?.name).toBe('Clear raw recovery');
    expect(restoreCommand?.checkCallback?.(true)).toBe(false);
    expect(copyCommand?.checkCallback?.(true)).toBe(false);
    expect(clearCommand?.checkCallback?.(true)).toBe(false);

    available = true;
    expect(restoreCommand?.checkCallback?.(true)).toBe(true);
    expect(copyCommand?.checkCallback?.(true)).toBe(true);
    expect(clearCommand?.checkCallback?.(true)).toBe(true);
    expect(restoreRawTranscript).not.toHaveBeenCalled();
    expect(copyRawTranscript).not.toHaveBeenCalled();
    expect(clearRawTranscriptRecovery).not.toHaveBeenCalled();

    expect(restoreCommand?.checkCallback?.(false)).toBe(true);
    expect(copyCommand?.checkCallback?.(false)).toBe(true);
    expect(clearCommand?.checkCallback?.(false)).toBe(true);
    expect(restoreRawTranscript).toHaveBeenCalledOnce();
    expect(copyRawTranscript).toHaveBeenCalledOnce();
    expect(clearRawTranscriptRecovery).toHaveBeenCalledOnce();
    expect(restoreCommand?.checkCallback?.(true)).toBe(false);
  });

  it('registers the local audio-file transcription command', async () => {
    const commands: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
      }),
    } as unknown as Plugin;
    const transcribeAudioFile = vi.fn(async () => {});

    registerCommands({
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      cancelAudioFile: vi.fn(async () => {}),
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance: vi.fn(),
      clearRawTranscriptRecovery: vi.fn(),
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance: vi.fn(),
      copyRawTranscript: vi.fn(),
      hasLastUtterance: () => false,
      hasRawTranscriptRecovery: () => false,
      isAudioFileTranscriptionActive: () => false,
      isReadAloudActive: () => false,
      openSpeechKit: vi.fn(async () => {}),
      plugin,
      readAloud: vi.fn(async () => {}),
      readAloudFromCursor: vi.fn(async () => {}),
      reinsertLastUtterance: vi.fn(),
      restoreRawTranscript: vi.fn(),
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile,
      translateNote: vi.fn(),
      translateSelection: vi.fn(),
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });

    const command = commands.find(({ id }) => id === 'transcribe-local-audio-file');
    expect(command?.name).toBe('Transcribe local audio file');
    command?.checkCallback?.(false);
    expect(transcribeAudioFile).toHaveBeenCalledOnce();

    const originalDesktop = Platform.isDesktopApp;
    Platform.isDesktopApp = false;
    expect(command?.checkCallback?.(true)).toBe(false);
    Platform.isDesktopApp = originalDesktop;
  });

  it('registers the caption-only YouTube command on desktop', () => {
    const commands: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
      }),
    } as unknown as Plugin;
    const transcribeYouTube = vi.fn(async () => {});
    registerCommands({
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      cancelAudioFile: vi.fn(async () => {}),
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance: vi.fn(),
      clearRawTranscriptRecovery: vi.fn(),
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance: vi.fn(),
      copyRawTranscript: vi.fn(),
      hasLastUtterance: () => false,
      hasRawTranscriptRecovery: () => false,
      isAudioFileTranscriptionActive: () => false,
      isReadAloudActive: () => false,
      openSpeechKit: vi.fn(async () => {}),
      plugin,
      readAloud: vi.fn(async () => {}),
      readAloudFromCursor: vi.fn(async () => {}),
      reinsertLastUtterance: vi.fn(),
      restoreRawTranscript: vi.fn(),
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile: vi.fn(async () => {}),
      transcribeYouTube,
      translateNote: vi.fn(),
      translateSelection: vi.fn(),
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });

    const command = commands.find(({ id }) => id === 'transcribe-youtube-video');
    const originalDesktop = Platform.isDesktopApp;
    try {
      expect(command?.checkCallback?.(true)).toBe(true);
      expect(transcribeYouTube).not.toHaveBeenCalled();
      expect(command?.checkCallback?.(false)).toBe(true);
      expect(transcribeYouTube).toHaveBeenCalledOnce();
      Platform.isDesktopApp = false;
      expect(command?.checkCallback?.(true)).toBe(false);
    } finally {
      Platform.isDesktopApp = originalDesktop;
    }
  });

  it('registers cancellation only while local audio-file transcription is active', async () => {
    const commands: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
      }),
    } as unknown as Plugin;
    const cancelAudioFile = vi.fn(async () => {});
    let active = false;

    registerCommands({
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      cancelAudioFile,
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance: vi.fn(),
      clearRawTranscriptRecovery: vi.fn(),
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance: vi.fn(),
      copyRawTranscript: vi.fn(),
      hasLastUtterance: () => false,
      hasRawTranscriptRecovery: () => false,
      isAudioFileTranscriptionActive: () => active,
      isReadAloudActive: () => false,
      openSpeechKit: vi.fn(async () => {}),
      plugin,
      readAloud: vi.fn(async () => {}),
      readAloudFromCursor: vi.fn(async () => {}),
      reinsertLastUtterance: vi.fn(),
      restoreRawTranscript: vi.fn(),
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile: vi.fn(async () => {}),
      translateNote: vi.fn(),
      translateSelection: vi.fn(),
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });

    const command = commands.find(({ id }) => id === 'cancel-local-audio-file-transcription');
    expect(command?.checkCallback?.(true)).toBe(false);
    active = true;
    expect(command?.checkCallback?.(true)).toBe(true);
    command?.checkCallback?.(false);
    expect(cancelAudioFile).toHaveBeenCalledOnce();
  });

  it('registers both read-aloud start commands', async () => {
    const commands: Command[] = [];
    const plugin = {
      addCommand: vi.fn((command: Command) => {
        commands.push(command);
      }),
    } as unknown as Plugin;

    const readAloud = vi.fn(async () => {});
    const readAloudFromCursor = vi.fn(async () => {});
    registerCommands({
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      cancelAudioFile: vi.fn(async () => {}),
      cancelDictation: vi.fn(async () => {}),
      clearLastUtterance: vi.fn(),
      clearRawTranscriptRecovery: vi.fn(),
      checkSidecarHealth: vi.fn(async () => {}),
      copyLastUtterance: vi.fn(),
      copyRawTranscript: vi.fn(),
      hasLastUtterance: () => false,
      hasRawTranscriptRecovery: () => false,
      isAudioFileTranscriptionActive: () => false,
      isReadAloudActive: () => false,
      openSpeechKit: vi.fn(async () => {}),
      plugin,
      readAloud,
      readAloudFromCursor,
      reinsertLastUtterance: vi.fn(),
      restoreRawTranscript: vi.fn(),
      restartSidecar: vi.fn(async () => {}),
      startDictation: vi.fn(async () => {}),
      stopReadAloud: vi.fn(),
      stopDictation: vi.fn(async () => {}),
      transcribeAudioFile: vi.fn(async () => {}),
      translateNote: vi.fn(),
      translateSelection: vi.fn(),
      toggleDictation: vi.fn(async () => {}),
      toggleReadAloudPaused: vi.fn(async () => {}),
    });

    const readAloudCommand = commands.find(({ id }) => id === 'read-aloud');
    const readFromCursorCommand = commands.find(({ id }) => id === 'read-aloud-from-cursor');
    const editor = {} as Editor;

    expect(readAloudCommand).toBeDefined();
    expect(readFromCursorCommand).toBeDefined();
    expect(readAloudCommand?.name).toBe('Read aloud from selection or note start');
    expect(readFromCursorCommand?.name).toBe('Read aloud from cursor');
    expect(commands.some(({ id }) => id === 'read-entire-note')).toBe(false);

    await readAloudCommand?.editorCheckCallback?.(false, editor, {} as never);
    await readFromCursorCommand?.editorCheckCallback?.(false, editor, {} as never);

    expect(readAloud).toHaveBeenCalledWith(editor);
    expect(readAloudFromCursor).toHaveBeenCalledWith(editor);
  });
});

it('hides disabled editor menu tools and ignores a stale menu action after disabling', () => {
  let settings = { ...DEFAULT_PLUGIN_SETTINGS };
  let onMenu: (...args: unknown[]) => void = () => {};
  const workspace = {
    on: (_name: string, listener: typeof onMenu) => {
      onMenu = listener;
      return {};
    },
  };
  const actions: Array<{ title: string; run: () => void }> = [];
  const menu = {
    addItem: (configure: (item: unknown) => void) => {
      let title = '';
      const item = {
        setTitle: (value: string) => {
          title = value;
          return item;
        },
        setIcon: () => item,
        onClick: (run: () => void) => {
          actions.push({ title, run });
          return item;
        },
      };
      configure(item);
    },
  };
  const readAloud = vi.fn(async () => {});
  const translateSelection = vi.fn();
  registerEditorMenu(workspace as never, {
    getSettings: () => settings,
    readAloud,
    translateSelection,
  });
  const editor = { somethingSelected: () => true };
  onMenu(menu, editor, {});
  expect(actions.map(({ title }) => title)).toEqual([
    t('commands.translateSelection'),
    t('commands.readAloud'),
  ]);
  settings = { ...settings, readAloudEnabled: false, translationEnabled: false };
  for (const action of actions) action.run();
  expect(readAloud).not.toHaveBeenCalled();
  expect(translateSelection).not.toHaveBeenCalled();
  actions.length = 0;
  onMenu(menu, editor, {});
  expect(actions).toHaveLength(0);
});
