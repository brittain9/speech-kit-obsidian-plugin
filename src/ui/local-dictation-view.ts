import { type ButtonComponent, ItemView, Setting, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { DictationControllerState } from '../dictation/dictation-session-controller';
import type { LlmCleanupFailure } from '../llm/provider';
import type { LlmPresetStateMutation, PluginSettingsMutation } from '../settings/llm-preset-state';
import type { PluginSettings } from '../settings/plugin-settings';
import { createSettingGroup } from '../settings/setting-helpers';
import { captureSettingsFocus, restoreSettingsFocus } from '../settings/settings-tab-lifecycle';
import { t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import { FocusRefreshController } from './focus-refresh-controller';
import { renderLlmDailyControls } from './llm-daily-controls';
import { formatCleanupFailureBanner } from './llm-provider-ui';
import {
  type LlmSidebarPresentation,
  resolveLlmSidebarPresentation,
} from './llm-sidebar-presentation';
import { INLINE_STATUS_PRESENTATION } from './llm-status';

export const LOCAL_DICTATION_VIEW_TYPE = 'local-dictation-sidebar';
const LOCAL_DICTATION_VIEW_ICON = 'audio-lines';
const NARROW_SIDEBAR_WIDTH_PX = 560;

interface LocalDictationViewDependencies {
  feedback: Pick<UserFeedback, 'show'>;
  getSecret: (secretId: string) => string;
  getSettings: () => PluginSettings;
  getDictationState: () => DictationControllerState;
  toggleDictation: () => Promise<void>;
  getLlmCleanupFailure?: () => LlmCleanupFailure | null;
  logger?: PluginLogger | undefined;
  mutatePresetState: (mutation: LlmPresetStateMutation) => Promise<void>;
  openSettings?: () => void;
  editPreset?: (ref: string, onClosed: () => void) => void;
  mutateSettings: (mutation: PluginSettingsMutation) => Promise<void>;
  subscribeLlmCleanupFailure?: (callback: () => void) => () => void;
  synchronizePresets: () => Promise<void>;
}

export class LocalDictationView extends ItemView {
  private closed = false;
  private dictationButton: ButtonComponent | null = null;
  private narrowObserver: ResizeObserver | null = null;
  private readonly focusRefreshController: FocusRefreshController;
  private unsubscribeLlmCleanupFailure: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly dependencies: LocalDictationViewDependencies,
  ) {
    super(leaf);
    this.focusRefreshController = new FocusRefreshController({
      now: () => window.performance.now(),
      refreshPresets: () => this.dependencies.synchronizePresets(),
      refreshProviders: () => Promise.resolve(),
    });
  }

  override getViewType(): string {
    return LOCAL_DICTATION_VIEW_TYPE;
  }

  override getDisplayText(): string {
    return t('plugin.name');
  }

  override getIcon(): string {
    return LOCAL_DICTATION_VIEW_ICON;
  }

  override async onOpen(): Promise<void> {
    this.closed = false;
    this.refresh();
    this.attachWidthObserver();
    this.unsubscribeLlmCleanupFailure =
      this.dependencies.subscribeLlmCleanupFailure?.(() => {
        this.refresh();
      }) ?? null;
    this.registerDomEvent(this.contentEl.win, 'focus', () => {
      this.focusRefreshController.request();
    });
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.dictationButton = null;
    this.narrowObserver?.disconnect();
    this.narrowObserver = null;
    this.unsubscribeLlmCleanupFailure?.();
    this.unsubscribeLlmCleanupFailure = null;
  }

  private attachWidthObserver(): void {
    if (this.narrowObserver !== null) return;
    const target = this.contentEl;
    if (typeof ResizeObserver === 'undefined') return;
    this.narrowObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width;
        target.toggleClass(
          'local-dictation-sidebar--narrow',
          width > 0 && width < NARROW_SIDEBAR_WIDTH_PX,
        );
      }
    });
    this.narrowObserver.observe(target);
  }

  refresh(): void {
    const { contentEl } = this;
    const scrollTop = contentEl.scrollTop;
    const settings = this.dependencies.getSettings();

    try {
      contentEl.empty();
      contentEl.addClass('local-dictation-sidebar');

      new Setting(contentEl)
        .setName(t('sidebar.dictation.title'))
        .setDesc(t('sidebar.dictation.destination'))
        .addButton((button) => {
          this.dictationButton = button;
          this.updateDictationState(this.dependencies.getDictationState());
          button.onClick(() => this.dependencies.toggleDictation());
        });

      const presentation = resolveLlmSidebarPresentation(settings);
      new Setting(contentEl).addButton((button) => {
        button
          .setButtonText(t('llm.sidebar.openSettings'))
          .onClick(() => this.dependencies.openSettings?.());
      });

      if (!settings.llmFeaturesEnabled) return;

      const dailyGroup = createSettingGroup(contentEl, t('llm.sidebar.group.transforms'));
      if (presentation.state === 'active') this.renderTransformStatus(dailyGroup, presentation);
      renderLlmDailyControls(dailyGroup, {
        getSettings: this.dependencies.getSettings,
        mutateSettings: this.dependencies.mutateSettings,
        mutatePresetState: this.dependencies.mutatePresetState,
        rerender: () => this.requestRefresh(),
        ...(this.dependencies.editPreset === undefined
          ? {}
          : { editPreset: (ref: string) => this.openPresetEditor(ref) }),
      });
      if (settings.llmPostprocessMode !== 'off') {
        this.renderRuntimeFailureBanner(dailyGroup);
      }
    } finally {
      contentEl.scrollTop = scrollTop;
    }
  }

  private openPresetEditor(ref: string): void {
    const focus = captureSettingsFocus(this.contentEl);
    this.dependencies.editPreset?.(ref, () => {
      if (this.closed) return;
      this.refresh();
      const document = this.contentEl.ownerDocument;
      const active = document.activeElement;
      if (active === null || active === document.body || active === document.documentElement) {
        restoreSettingsFocus(this.contentEl, focus);
      }
    });
  }

  updateDictationState(state: DictationControllerState): void {
    const active = state === 'starting' || state === 'listening' || state === 'speech_detected';
    this.dictationButton?.setButtonText(
      t(active ? 'commands.stopDictation' : 'commands.startDictation'),
    );
  }

  requestRefresh(): void {
    if (!this.closed) this.scheduleRender();
  }

  private renderTransformStatus(parent: HTMLElement, presentation: LlmSidebarPresentation): void {
    const status = parent.createEl('p', {
      cls: 'local-dictation-sidebar__summary setting-item-description',
      text: presentation.summary,
    });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
  }

  private renderRuntimeFailureBanner(parent: HTMLElement): void {
    const failure = this.dependencies.getLlmCleanupFailure?.() ?? null;
    if (failure === null) {
      return;
    }

    const row = parent.createDiv({
      cls: `local-dictation-status ${INLINE_STATUS_PRESENTATION.warning.className}`,
    });
    row.setAttribute('aria-live', 'polite');
    row.setAttribute('role', 'alert');
    const iconEl = row.createSpan({ cls: 'local-dictation-status__icon' });
    iconEl.setAttribute('aria-hidden', 'true');
    setIcon(iconEl, INLINE_STATUS_PRESENTATION.warning.icon);
    row.createSpan({
      cls: 'local-dictation-status__text',
      text: formatCleanupFailureBanner(failure),
    });
  }

  private scheduleRender(): void {
    this.refresh();
  }
}
