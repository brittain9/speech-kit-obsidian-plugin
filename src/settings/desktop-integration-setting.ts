import { type App, Modal, Platform, Setting, type TextComponent } from 'obsidian';
import { t } from '../shared/i18n';
import type { PluginSettings } from './plugin-settings';
import { addToggleSetting, appendInfoTooltip, type SettingAccess } from './setting-helpers';

type DesktopPlatform = 'macos' | 'windows' | 'linux';

export interface DesktopIntegrationSettingsDependencies {
  access: SettingAccess;
  getStatus: () => string;
  subscribeStatus: (listener: () => void) => () => void;
  retry: () => Promise<void>;
  onError: (error: unknown) => void;
  onChanged?: () => void;
  onClosed?: () => void;
  onDialogOpened?: () => () => void;
}

function platform(): DesktopPlatform {
  return Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows' : 'linux';
}

/** Display only: keep the saved chord in the native parser's textual syntax. */
export function formatDesktopShortcut(value: string, host: DesktopPlatform): string {
  const keys = value
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);
  const modifiers = new Set(keys.slice(0, -1).map((key) => key.toLowerCase()));
  const has = (...names: string[]) => names.some((name) => modifiers.has(name));
  const commandOrControl = has('commandorcontrol', 'cmdorctrl');
  const key =
    keys
      .at(-1)
      ?.replace(/^(?:Key|Digit)(?=[A-Z0-9]$)/u, '')
      .toUpperCase() ?? '';
  if (host === 'macos') {
    return `${has('control', 'ctrl') ? '⌃' : ''}${has('alt', 'option') ? '⌥' : ''}${has('shift') ? '⇧' : ''}${has('command', 'cmd', 'meta', 'super') || commandOrControl ? '⌘' : ''}${key}`;
  }
  return [
    has('control', 'ctrl') || commandOrControl ? 'Ctrl' : '',
    has('alt', 'option') ? 'Alt' : '',
    has('shift') ? 'Shift' : '',
    has('command', 'cmd', 'meta', 'super') ? (host === 'windows' ? 'Win' : 'Super') : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
}

function summary(settings: PluginSettings): string {
  if (!settings.desktopControlsEnabled) return t('desktop.captureDesc');
  if (settings.globalDictationShortcut) {
    return t('desktop.shortcutSummary', {
      shortcut: formatDesktopShortcut(settings.globalDictationShortcut, platform()),
    });
  }
  return settings.showDesktopStatusIcon
    ? t(`desktop.icon.${platform()}`)
    : t('desktop.configureHint');
}

export function renderDesktopIntegrationSetting(
  parent: HTMLElement,
  app: App,
  deps: DesktopIntegrationSettingsDependencies,
): void {
  const row = addToggleSetting(parent, deps.access, {
    name: t('desktop.enabled'),
    desc: summary(deps.access.getSettings()),
    key: 'desktopControlsEnabled',
    onChange: () => {
      row.setDesc(summary(deps.access.getSettings()));
      deps.onChanged?.();
    },
  });
  row.addExtraButton((button) => {
    button.setIcon('sliders-horizontal').setTooltip(t('desktop.modal.settings'));
    button.extraSettingsEl.setAttribute('aria-label', t('desktop.modal.settings'));
    button.onClick(() => {
      const restore = deps.onDialogOpened?.();
      new DesktopIntegrationSettingsModal(app, {
        ...deps,
        onClosed: () => {
          deps.onChanged?.();
          deps.onClosed?.();
          restore?.();
        },
      }).open();
    });
  });
}

export class DesktopIntegrationSettingsModal extends Modal {
  private shortcutInput: TextComponent | null = null;
  private unsubscribe: (() => void) | null = null;
  private status: Setting | null = null;
  private shortcut: Setting | null = null;
  private pendingShortcut: { value: string; operation: Promise<boolean> } | null = null;
  private savedShortcut = '';
  private openGeneration = 0;

  constructor(
    app: App,
    private readonly deps: DesktopIntegrationSettingsDependencies,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.openGeneration += 1;
    this.savedShortcut = this.deps.access.getSettings().globalDictationShortcut;
    this.setTitle(t('desktop.enabled'));
    const host = platform();
    this.shortcut = new Setting(this.contentEl).setName(t('desktop.modal.shortcut'));
    this.shortcut.addText((input) => {
      this.shortcutInput = input;
      input.setValue(this.savedShortcut);
      input.setPlaceholder(host === 'macos' ? 'Control+Alt+J' : 'Control+Shift+D');
      input.inputEl.setAttribute('aria-label', t('desktop.modal.shortcut'));
      input.inputEl.addEventListener('blur', () => {
        void this.saveShortcut();
      });
    });
    appendInfoTooltip(this.shortcut, t(`desktop.shortcutHelp.${host}`));
    addToggleSetting(this.contentEl, this.deps.access, {
      name: t(`desktop.icon.${host}`),
      desc: t(`desktop.iconDesc.${host}`),
      key: 'showDesktopStatusIcon',
    });
    const sounds = addToggleSetting(this.contentEl, this.deps.access, {
      name: t('desktop.sounds'),
      desc: t('desktop.modal.soundsDesc'),
      key: 'playRecordingSounds',
    });
    appendInfoTooltip(sounds, t('desktop.soundsDesc'));
    this.status = new Setting(this.contentEl).setName(t('desktop.modal.status'));
    this.status.addButton((button) => {
      button.setButtonText(t('desktop.modal.retry')).onClick(async () => {
        if (!this.deps.access.getSettings().desktopControlsEnabled) return;
        const generation = this.openGeneration;
        button.setDisabled(true);
        try {
          if (await this.saveShortcut()) await this.deps.retry();
        } catch (error) {
          this.deps.onError(error);
        } finally {
          if (generation === this.openGeneration) {
            button.setDisabled(false);
            this.refreshStatus();
          }
        }
      });
      button.setDisabled(!this.deps.access.getSettings().desktopControlsEnabled);
    });
    this.refreshStatus();
    this.unsubscribe = this.deps.subscribeStatus(() => this.refreshStatus());
  }

  override onClose(): void {
    const saved = this.saveShortcut();
    this.openGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.shortcutInput = null;
    this.shortcut = null;
    this.status = null;
    this.contentEl.empty();
    void saved.then(() => this.deps.onClosed?.());
  }

  private saveShortcut(): Promise<boolean> {
    const value = this.shortcutInput?.getValue().trim();
    if (value === undefined) return this.pendingShortcut?.operation ?? Promise.resolve(true);
    if (this.pendingShortcut?.value === value) return this.pendingShortcut.operation;
    if (this.pendingShortcut === null && value === this.savedShortcut) return Promise.resolve(true);
    const operation = Promise.resolve()
      .then(() => this.deps.access.persistOne('globalDictationShortcut', value))
      .then(
        () => {
          this.savedShortcut = value;
          return true;
        },
        (error) => {
          this.deps.onError(error);
          return false;
        },
      )
      .finally(() => {
        if (this.pendingShortcut?.operation === operation) this.pendingShortcut = null;
      });
    this.pendingShortcut = { value, operation };
    return operation;
  }

  private refreshStatus(): void {
    const settings = this.deps.access.getSettings();
    this.shortcut?.setDesc(
      settings.globalDictationShortcut
        ? formatDesktopShortcut(settings.globalDictationShortcut, platform())
        : t('desktop.modal.noShortcut'),
    );
    const raw = this.deps.getStatus();
    const status =
      raw === settings.globalDictationShortcut && raw
        ? t('desktop.modal.registered', { shortcut: formatDesktopShortcut(raw, platform()) })
        : raw === 'disabled'
          ? t('desktop.modal.noShortcut')
          : raw;
    this.status?.setDesc(
      !settings.desktopControlsEnabled
        ? t('desktop.modal.off')
        : status || t('desktop.configureHint'),
    );
  }
}
