import {
  type Editor,
  type EventRef,
  type MarkdownFileInfo,
  Platform,
  type Plugin,
  type Workspace,
} from 'obsidian';
import type { PluginSettings } from '../settings/plugin-settings';
import { t } from '../shared/i18n';

const START_DICTATION_COMMAND_ID = 'start-dictation-session';
const STOP_DICTATION_COMMAND_ID = 'stop-dictation-session';
const CANCEL_DICTATION_COMMAND_ID = 'cancel-dictation-session';
const TOGGLE_DICTATION_COMMAND_ID = 'toggle-dictation-session';
const REINSERT_LAST_UTTERANCE_COMMAND_ID = 'reinsert-last-utterance';
const CLEAR_LAST_UTTERANCE_COMMAND_ID = 'clear-last-utterance';
const RESTORE_RAW_TRANSCRIPT_COMMAND_ID = 'restore-raw-transcript';
const COPY_RAW_TRANSCRIPT_COMMAND_ID = 'copy-raw-transcript';
const CLEAR_RAW_RECOVERY_COMMAND_ID = 'clear-raw-transcript-recovery';

interface CommandDependencies {
  getSettings: () => Pick<PluginSettings, 'translationEnabled' | 'readAloudEnabled'>;
  cancelAudioFile: () => Promise<void>;
  cancelDictation: () => Promise<void>;
  clearLastUtterance: () => void;
  clearRawTranscriptRecovery: () => void;
  checkSidecarHealth: () => Promise<void>;
  copyLastUtterance: () => void;
  copyRawTranscript: () => void;
  hasRawTranscriptRecovery: () => boolean;
  isAudioFileTranscriptionActive: () => boolean;
  isReadAloudActive: () => boolean;
  plugin: Plugin;
  openSpeechKit: () => Promise<void>;
  hasLastUtterance: () => boolean;
  reinsertLastUtterance: (editor: Editor) => void;
  restoreRawTranscript: () => void;
  restartSidecar: () => Promise<void>;
  readAloud: (editor: Editor) => Promise<void>;
  readAloudFromCursor: (editor: Editor) => Promise<void>;
  stopReadAloud: () => void;
  transcribeAudioFile: () => Promise<void>;
  transcribeYouTube?: () => Promise<void>;
  translateNote: (editor: Editor, view: MarkdownFileInfo) => void;
  translateSelection: (editor: Editor, view: MarkdownFileInfo) => void;
  toggleReadAloudPaused: () => Promise<void>;
  startDictation: () => Promise<void>;
  stopDictation: () => Promise<void>;
  toggleDictation: () => Promise<void>;
}

export function registerCommands(dependencies: CommandDependencies): void {
  dependencies.plugin.addCommand({
    id: 'open-speech-kit',
    name: t('commands.openSpeechKit'),
    callback: () => dependencies.openSpeechKit(),
  });
  dependencies.plugin.addCommand({
    id: 'translate-selection',
    name: t('commands.translateSelection'),
    editorCheckCallback: (checking, editor, view) => {
      if (!dependencies.getSettings().translationEnabled || !editor.somethingSelected())
        return false;
      if (!checking) dependencies.translateSelection(editor, view);
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'translate-note',
    name: t('commands.translateNote'),
    editorCheckCallback: (checking, editor, view) => {
      if (!dependencies.getSettings().translationEnabled) return false;
      if (!checking) dependencies.translateNote(editor, view);
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'read-aloud',
    name: t('commands.readAloud'),
    editorCheckCallback: (checking, editor) => {
      if (!dependencies.getSettings().readAloudEnabled) return false;
      if (!checking) void dependencies.readAloud(editor);
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'read-aloud-from-cursor',
    name: t('commands.readAloudFromCursor'),
    editorCheckCallback: (checking, editor) => {
      if (!dependencies.getSettings().readAloudEnabled) return false;
      if (!checking) void dependencies.readAloudFromCursor(editor);
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'pause-resume-read-aloud',
    name: t('commands.pauseResumeReadAloud'),
    checkCallback: (checking) => {
      if (!dependencies.isReadAloudActive()) return false;
      if (!checking) void dependencies.toggleReadAloudPaused();
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'stop-read-aloud',
    name: t('commands.stopReadAloud'),
    checkCallback: (checking) => {
      if (!dependencies.isReadAloudActive()) return false;
      if (!checking) dependencies.stopReadAloud();
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'transcribe-local-audio-file',
    name: t('commands.transcribeAudioFile'),
    checkCallback: (checking) => {
      if (!Platform.isDesktopApp) return false;
      if (!checking) void dependencies.transcribeAudioFile();
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'transcribe-youtube-video',
    name: t('commands.transcribeYouTube'),
    checkCallback: (checking) => {
      if (!Platform.isDesktopApp) return false;
      if (!checking) void dependencies.transcribeYouTube?.();
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'cancel-local-audio-file-transcription',
    name: t('commands.cancelAudioFile'),
    checkCallback: (checking) => {
      if (!dependencies.isAudioFileTranscriptionActive()) return false;
      if (!checking) void dependencies.cancelAudioFile();
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: TOGGLE_DICTATION_COMMAND_ID,
    name: t('commands.toggleDictation'),
    callback: async () => {
      await dependencies.toggleDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: START_DICTATION_COMMAND_ID,
    name: t('commands.startDictation'),
    callback: async () => {
      await dependencies.startDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: STOP_DICTATION_COMMAND_ID,
    name: t('commands.stopDictation'),
    callback: async () => {
      await dependencies.stopDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: CANCEL_DICTATION_COMMAND_ID,
    name: t('commands.cancelDictation'),
    callback: async () => {
      await dependencies.cancelDictation();
    },
  });

  dependencies.plugin.addCommand({
    id: REINSERT_LAST_UTTERANCE_COMMAND_ID,
    name: t('commands.reinsertLastUtterance'),
    editorCheckCallback: (checking, editor) => {
      if (!dependencies.hasLastUtterance()) {
        return false;
      }
      if (!checking) {
        dependencies.reinsertLastUtterance(editor);
      }
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: CLEAR_LAST_UTTERANCE_COMMAND_ID,
    name: t('commands.clearLastUtterance'),
    checkCallback: (checking) => {
      if (!dependencies.hasLastUtterance()) {
        return false;
      }
      if (!checking) {
        dependencies.clearLastUtterance();
      }
      return true;
    },
  });

  dependencies.plugin.addCommand({
    id: 'copy-last-utterance',
    name: t('commands.copyLastUtterance'),
    checkCallback: (checking) =>
      runAvailableCommand(checking, dependencies.hasLastUtterance, dependencies.copyLastUtterance),
  });

  dependencies.plugin.addCommand({
    id: RESTORE_RAW_TRANSCRIPT_COMMAND_ID,
    name: t('commands.restoreRawTranscript'),
    checkCallback: (checking) =>
      runAvailableCommand(
        checking,
        dependencies.hasRawTranscriptRecovery,
        dependencies.restoreRawTranscript,
      ),
  });

  dependencies.plugin.addCommand({
    id: COPY_RAW_TRANSCRIPT_COMMAND_ID,
    name: t('commands.copyRawTranscript'),
    checkCallback: (checking) =>
      runAvailableCommand(
        checking,
        dependencies.hasRawTranscriptRecovery,
        dependencies.copyRawTranscript,
      ),
  });

  dependencies.plugin.addCommand({
    id: CLEAR_RAW_RECOVERY_COMMAND_ID,
    name: t('commands.clearRawRecovery'),
    checkCallback: (checking) =>
      runAvailableCommand(
        checking,
        dependencies.hasRawTranscriptRecovery,
        dependencies.clearRawTranscriptRecovery,
      ),
  });

  dependencies.plugin.addCommand({
    id: 'check-sidecar-health',
    name: t('commands.checkSidecarHealth'),
    callback: async () => {
      await dependencies.checkSidecarHealth();
    },
  });

  dependencies.plugin.addCommand({
    id: 'restart-sidecar',
    name: t('commands.restartSidecar'),
    callback: async () => {
      await dependencies.restartSidecar();
    },
  });
}

export function registerEditorMenu(
  workspace: Pick<Workspace, 'on'>,
  dependencies: Pick<CommandDependencies, 'getSettings' | 'translateSelection' | 'readAloud'>,
): EventRef {
  return workspace.on('editor-menu', (menu, editor, view) => {
    if (!editor.somethingSelected()) return;
    if (dependencies.getSettings().translationEnabled) {
      menu.addItem((item) => {
        item
          .setTitle(t('commands.translateSelection'))
          .setIcon('languages')
          .onClick(() => {
            if (dependencies.getSettings().translationEnabled)
              dependencies.translateSelection(editor, view);
          });
      });
    }
    if (dependencies.getSettings().readAloudEnabled) {
      menu.addItem((item) => {
        item
          .setTitle(t('commands.readAloud'))
          .setIcon('audio-lines')
          .onClick(() => {
            if (dependencies.getSettings().readAloudEnabled) void dependencies.readAloud(editor);
          });
      });
    }
  });
}

function runAvailableCommand(
  checking: boolean,
  isAvailable: () => boolean,
  run: () => void,
): boolean {
  if (!isAvailable()) {
    return false;
  }
  if (!checking) {
    run();
  }
  return true;
}
