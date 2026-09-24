import { type App, type ButtonComponent, Modal, Setting, type TextComponent } from 'obsidian';

import {
  discoverYtDlpCandidates,
  normalizeYouTubeHelperPath,
  probeYtDlpVersion,
} from '../media/youtube-helper';
import {
  explicitYouTubeRightsConfirmation,
  hasYouTubeRightsConfirmation,
  YOUTUBE_POLICY_VERSION,
  type YouTubeConsentGrant,
} from '../media/youtube-media-source';
import { parseYouTubeVideoUrl, type YouTubeVideoRef } from '../media/youtube-url';
import { t } from '../shared/i18n';

export interface YouTubeMediaSourceRequest {
  readonly consent: YouTubeConsentGrant;
  readonly helperPath: string;
  readonly helperVersion: string;
  readonly inputUrl: string;
  readonly ref: YouTubeVideoRef;
}

export interface YouTubeMediaSourceModalDependencies {
  readonly getHelperPath: () => string;
  readonly getPolicyVersion: () => string | null;
}

export interface YouTubeMediaSourceModalSession {
  readonly close: () => void;
  readonly result: Promise<YouTubeMediaSourceRequest | null>;
}

export function openYouTubeMediaSourceModal(
  app: App,
  dependencies: YouTubeMediaSourceModalDependencies,
): Promise<YouTubeMediaSourceRequest | null> {
  return openYouTubeMediaSourceModalSession(app, dependencies).result;
}

export function openYouTubeMediaSourceModalSession(
  app: App,
  dependencies: YouTubeMediaSourceModalDependencies,
): YouTubeMediaSourceModalSession {
  let resolveRequest: ((request: YouTubeMediaSourceRequest | null) => void) | null = null;
  const result = new Promise<YouTubeMediaSourceRequest | null>((resolve) => {
    resolveRequest = resolve;
  });
  const modal = new YouTubeMediaSourceModal(app, dependencies, (request) =>
    resolveRequest?.(request),
  );
  modal.open();
  return { close: () => modal.close(), result };
}

export class YouTubeMediaSourceModalRegistry {
  private readonly sessions = new Set<YouTubeMediaSourceModalSession>();

  get size(): number {
    return this.sessions.size;
  }

  open(
    app: App,
    dependencies: YouTubeMediaSourceModalDependencies,
  ): YouTubeMediaSourceModalSession | null {
    if (this.sessions.size > 0) return null;
    const session = openYouTubeMediaSourceModalSession(app, dependencies);
    this.sessions.add(session);
    return session;
  }

  remove(session: YouTubeMediaSourceModalSession): void {
    this.sessions.delete(session);
  }

  closeAll(): void {
    for (const session of [...this.sessions]) session.close();
    this.sessions.clear();
  }
}

class YouTubeMediaSourceModal extends Modal {
  private readonly lifecycle = new AbortController();
  private probeController: AbortController | null = null;
  private generation = 0;
  private settled = false;
  private previousFocus: HTMLElement | null = null;
  private helperPath: string;
  private helperVersion = '';
  private url = '';
  private rightsConfirmed = false;
  private errorEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private confirmButton: ButtonComponent | null = null;
  private resolveRequest: ((request: YouTubeMediaSourceRequest | null) => void) | null;

  constructor(
    app: App,
    readonly dependencies: YouTubeMediaSourceModalDependencies,
    resolveRequest: (request: YouTubeMediaSourceRequest | null) => void,
  ) {
    super(app);
    this.helperPath = dependencies.getHelperPath();
    this.rightsConfirmed = hasYouTubeRightsConfirmation(dependencies.getPolicyVersion());
    this.resolveRequest = resolveRequest;
  }

  override onOpen(): void {
    this.previousFocus =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    this.setTitle(`${t('commands.transcribeYouTube')} · ${t('youtube.modal.experimentalBadge')}`);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: t('youtube.modal.disclosure') });
    this.contentEl.createEl('p', { text: t('youtube.modal.urlDescription') });

    const helperSetting = new Setting(this.contentEl).setName(t('youtube.modal.helperName'));
    helperSetting.addText((text: TextComponent) => {
      text.setPlaceholder(t('youtube.modal.helperPlaceholder'));
      text.setValue(this.helperPath);
      text.onChange((value) => {
        this.generation += 1;
        this.probeController?.abort();
        this.probeController = null;
        this.helperPath = value;
        this.helperVersion = '';
        this.setError('');
      });
    });
    helperSetting.addButton((button) =>
      button.setButtonText(t('youtube.modal.checkHelper')).onClick(() => {
        void this.probeSelectedHelper();
      }),
    );
    const suggestions = discoverYtDlpCandidates();
    if (suggestions.length > 0) {
      this.contentEl.createEl('p', {
        text: t('youtube.modal.suggestions', { suggestions: suggestions.join(', ') }),
      });
    }
    this.contentEl.createEl('p', {
      text: this.rightsConfirmed
        ? t('youtube.modal.policyAccepted', { policy: YOUTUBE_POLICY_VERSION })
        : t('youtube.modal.policyRequired'),
    });
    if (!this.rightsConfirmed) {
      new Setting(this.contentEl).setName(t('youtube.modal.rightsLabel')).addToggle((toggle) => {
        toggle.setValue(false);
        toggle.onChange((value) => {
          this.rightsConfirmed = value;
        });
      });
    }

    new Setting(this.contentEl)
      .setName(t('youtube.modal.urlName'))
      .addText((text: TextComponent) => {
        text.setPlaceholder(t('youtube.modal.urlPlaceholder'));
        text.onChange((value) => {
          this.url = value;
          this.updateSummary();
        });
      });
    this.summaryEl = this.contentEl.createDiv({ cls: 'local-stt-youtube-source-summary' });
    this.errorEl = this.contentEl.createDiv({ attr: { role: 'alert' } });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t('common.cancel')).onClick(() => this.close()))
      .addButton((button) => {
        this.confirmButton = button;
        button
          .setButtonText(t('youtube.modal.transcribe'))
          .setCta()
          .onClick(() => {
            void this.submit();
          });
      });
    this.updateSummary();
    queueMicrotask(() => {
      const focusTarget = this.contentEl.querySelector<HTMLElement>(
        'input, button, textarea, [tabindex]',
      );
      (focusTarget ?? this.contentEl).focus();
    });
    if (this.helperPath.length > 0) void this.probeSelectedHelper();
  }

  override onClose(): void {
    if (this.settled) {
      this.contentEl.empty();
      this.restoreFocus();
      return;
    }
    this.settled = true;
    this.generation += 1;
    this.lifecycle.abort();
    this.probeController?.abort();
    this.probeController = null;
    this.contentEl.empty();
    this.errorEl = null;
    this.summaryEl = null;
    this.confirmButton = null;
    this.resolveRequest?.(null);
    this.resolveRequest = null;
    this.restoreFocus();
  }

  private restoreFocus(): void {
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  private isCurrent(generation: number, signal: AbortSignal): boolean {
    return !this.settled && !signal.aborted && generation === this.generation;
  }

  private updateSummary(): void {
    if (this.summaryEl === null) return;
    this.summaryEl.empty();
    if (this.url.trim().length === 0) return;
    try {
      const video = parseYouTubeVideoUrl(this.url);
      this.summaryEl.setText(
        t('youtube.modal.summary', {
          canonicalUrl: video.canonicalUrl,
          host: video.host,
          videoId: video.videoId,
        }),
      );
    } catch {
      this.summaryEl.setText(t('youtube.modal.invalidSummary'));
    }
  }

  private async probeSelectedHelper(): Promise<void> {
    this.probeController?.abort();
    const controller = new AbortController();
    this.probeController = controller;
    const generation = this.generation;
    const requestedPath = this.helperPath;
    const normalized = normalizeYouTubeHelperPath(requestedPath);
    if (normalized === null) {
      this.setError(t('youtube.modal.pathRequired'));
      this.probeController = null;
      return;
    }
    try {
      const result = await probeYtDlpVersion(normalized, { signal: controller.signal });
      if (!this.isCurrent(generation, controller.signal) || this.helperPath !== requestedPath)
        return;
      this.helperPath = result.path;
      this.helperVersion = result.version;
      this.setError(t('youtube.modal.helperReady', { version: result.version }));
    } catch {
      if (this.isCurrent(generation, controller.signal) && this.helperPath === requestedPath) {
        this.helperVersion = '';
        this.setError(t('youtube.modal.helperError'));
      }
    } finally {
      if (this.probeController === controller) this.probeController = null;
    }
  }

  private async submit(): Promise<void> {
    if (this.settled) return;
    this.confirmButton?.setDisabled(true);
    this.setError('');
    const generation = this.generation;
    try {
      const video = parseYouTubeVideoUrl(this.url);
      if (normalizeYouTubeHelperPath(this.helperPath) === null)
        throw new Error('absolute helper path required');
      if (this.helperVersion.length === 0) {
        await this.probeSelectedHelper();
        if (!this.isCurrent(generation, this.lifecycle.signal)) return;
      }
      if (!this.rightsConfirmed) throw new Error('rights confirmation required');
      if (!this.isCurrent(generation, this.lifecycle.signal)) return;
      const request: YouTubeMediaSourceRequest = {
        consent: explicitYouTubeRightsConfirmation(),
        helperPath: normalizeYouTubeHelperPath(this.helperPath) ?? this.helperPath,
        helperVersion: this.helperVersion,
        inputUrl: this.url.trim(),
        ref: video,
      };
      if (!this.isCurrent(generation, this.lifecycle.signal)) return;
      this.settled = true;
      this.resolveRequest?.(request);
      this.resolveRequest = null;
      this.close();
    } catch {
      if (this.isCurrent(generation, this.lifecycle.signal)) {
        this.setError(t('youtube.modal.submitError'));
      }
    } finally {
      this.confirmButton?.setDisabled(false);
    }
  }

  private setError(message: string): void {
    this.errorEl?.setText(message);
  }
}
