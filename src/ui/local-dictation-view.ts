import { ItemView, Setting, setIcon, type WorkspaceLeaf } from 'obsidian';

import type { LlmCleanupFailure } from '../llm/provider';
import type { LlmPresetStateMutation, PluginSettingsMutation } from '../settings/llm-preset-state';
import type { PluginSettings } from '../settings/plugin-settings';
import { createSettingGroup } from '../settings/setting-helpers';
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
  getLlmCleanupFailure?: () => LlmCleanupFailure | null;
  logger?: PluginLogger | undefined;
  mutatePresetState: (mutation: LlmPresetStateMutation) => Promise<void>;
  openSettings?: () => void;
  mutateSettings: (mutation: PluginSettingsMutation) => Promise<void>;
  subscribeLlmCleanupFailure?: (callback: () => void) => () => void;
  synchronizePresets: () => Promise<void>;
}

export class LocalDictationView extends ItemView {
  private closed = false;
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

      const presentation = resolveLlmSidebarPresentation(settings);
      this.renderOverview(contentEl, presentation);
      new Setting(contentEl).addButton((button) => {
        button
          .setButtonText(t('llm.sidebar.openSettings'))
          .onClick(() => this.dependencies.openSettings?.());
      });

      if (!settings.llmFeaturesEnabled) {
        this.renderEmptyState(contentEl, presentation);
        return;
      }

      const dailyGroup = createSettingGroup(contentEl, t('llm.sidebar.group.preset'));
      renderLlmDailyControls(dailyGroup, {
        getSettings: this.dependencies.getSettings,
        mutateSettings: this.dependencies.mutateSettings,
        mutatePresetState: this.dependencies.mutatePresetState,
        rerender: () => this.requestRefresh(),
      });
      if (settings.llmPostprocessMode === 'off') {
        this.renderEmptyState(contentEl, presentation);
      } else {
        this.renderRuntimeFailureBanner(dailyGroup);
      }
    } finally {
      contentEl.scrollTop = scrollTop;
    }
  }

  requestRefresh(): void {
    if (!this.closed) this.scheduleRender();
  }

  private renderOverview(parent: HTMLElement, presentation: LlmSidebarPresentation): void {
    const header = parent.createEl('header', { cls: 'local-dictation-sidebar__header' });
    header.createDiv({
      cls: 'local-dictation-sidebar__eyebrow',
      text: t('llm.sidebar.eyebrow'),
    });
    header.createEl('h2', {
      cls: 'local-dictation-sidebar__title',
      text: t('llm.sidebar.title'),
    });
    header.createEl('p', {
      cls: 'local-dictation-sidebar__description',
      text: t('llm.sidebar.description'),
    });

    const status = header.createDiv({ cls: 'local-dictation-sidebar__summary' });
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    status.createSpan({
      cls: `local-dictation-sidebar__badge local-dictation-sidebar__badge--${presentation.state}`,
      text: presentation.statusLabel,
    });
    status.createSpan({
      cls: 'local-dictation-sidebar__summary-text',
      text: presentation.summary,
      title: presentation.summary,
    });
  }

  private renderEmptyState(parent: HTMLElement, presentation: LlmSidebarPresentation): void {
    if (presentation.emptyState === null) {
      return;
    }

    const emptyState = parent.createDiv({ cls: 'local-dictation-sidebar__empty' });
    const icon = emptyState.createDiv({ cls: 'local-dictation-sidebar__empty-icon' });
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, presentation.emptyState.icon);
    emptyState.createEl('h3', { text: presentation.emptyState.title });
    emptyState.createEl('p', { text: presentation.emptyState.description });
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
