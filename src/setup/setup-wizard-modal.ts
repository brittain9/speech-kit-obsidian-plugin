import type { App } from 'obsidian';
import { Modal, Platform, setIcon } from 'obsidian';
import {
  formatMicrophoneCaptureErrorMessage,
  formatMicrophonePermissionDeniedMessage,
} from '../audio/microphone-permission-message';
import { formatCatalogLanguageLabel } from '../language/dictation-language';
import { ManageModelsModal } from '../models/manage-models-modal';
import type { ModelInstallManager, ModelManagerState } from '../models/model-install-manager';
import {
  getTotalModelSize,
  matchesModelTriple,
  type SelectedModel,
} from '../models/model-management-types';
import { openFilteredHotkeySettings } from '../settings/open-hotkey-settings';
import { formatBytes } from '../shared/format-utils';
import { t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import type { SidecarInstallManager } from '../sidecar/sidecar-install-manager';
import {
  readFirstRunHardwareProfile,
  resolveStartingModelRecommendation,
  type StartingModelRecommendation,
} from './first-run-model-guidance';
import { MicrophoneReadiness, type MicrophoneReadinessResult } from './microphone-readiness';
import { SetupReadyActions } from './setup-ready-actions';
import { getInstallCopy } from './sidecar-install-copy';
import { SidecarInstallModal } from './sidecar-install-modal';

interface WizardDependencies {
  app: App;
  feedback: Pick<UserFeedback, 'show'>;
  hasDictationTarget: () => boolean;
  hasSelectedModel: () => boolean;
  isDictationBusy: () => boolean;
  isSidecarInstalled: () => Promise<boolean>;
  logger?: PluginLogger;
  modelInstallManager: ModelInstallManager;
  onCompleted: () => Promise<void>;
  pluginDirectory: string;
  postSidecarInstalled: () => Promise<void>;
  prepareDictationTarget: () => Promise<boolean>;
  sidecarVersion: string;
  sidecarConnection: Pick<SidecarConnection, 'restart'>;
  sidecarInstallManager: SidecarInstallManager;
  sidecarStartupTimeoutMs: number;
  startDictation: () => Promise<void>;
}

type WizardStepId = 'sidecar' | 'model' | 'microphone' | 'ready';

const STEP_ORDER: readonly WizardStepId[] = ['sidecar', 'model', 'microphone', 'ready'];

export class SetupWizardModal extends Modal {
  private currentStep: WizardStepId = 'sidecar';
  private sidecarReady = false;
  private modelReady = false;
  private modelManagerUnsub: (() => void) | null = null;
  private modelStateSignature = '';
  private openGeneration = 0;
  private recommendationPending: 'installing' | 'selecting' | null = null;
  private checkingMicrophone = false;
  private microphoneReadiness = new MicrophoneReadiness();
  private microphoneResult: MicrophoneReadinessResult = {
    recovery: 'recheck',
    status: 'unavailable',
  };
  private readonly readyActions: SetupReadyActions;

  constructor(private readonly deps: WizardDependencies) {
    super(deps.app);
    this.readyActions = new SetupReadyActions({
      closeWizard: () => this.close(),
      feedback: deps.feedback,
      hasDictationTarget: deps.hasDictationTarget,
      isDictationBusy: deps.isDictationBusy,
      onCompleted: deps.onCompleted,
      prepareDictationTarget: deps.prepareDictationTarget,
      startDictation: deps.startDictation,
    });
  }

  override onOpen(): void {
    const generation = ++this.openGeneration;
    this.checkingMicrophone = false;
    this.microphoneReadiness = new MicrophoneReadiness();
    this.microphoneResult = { recovery: 'recheck', status: 'unavailable' };
    void this.openAsync(generation);
  }

  private async openAsync(generation: number): Promise<void> {
    this.modalEl.addClass('local-stt-setup-wizard');
    this.sidecarReady = await this.deps.isSidecarInstalled();
    if (generation !== this.openGeneration) {
      return;
    }
    this.modelReady = this.deps.hasSelectedModel();

    if (!this.sidecarReady) {
      this.currentStep = 'sidecar';
    } else if (!this.modelReady) {
      this.currentStep = 'model';
    } else {
      this.currentStep = 'microphone';
    }

    this.modelStateSignature = recommendationStateSignature(
      this.deps.modelInstallManager.getState(),
    );
    this.modelManagerUnsub = this.deps.modelInstallManager.subscribe(() => {
      const nextSignature = recommendationStateSignature(this.deps.modelInstallManager.getState());
      if (nextSignature === this.modelStateSignature) return;
      const wasModelReady = this.modelReady;
      this.modelStateSignature = nextSignature;
      this.modelReady = this.deps.hasSelectedModel();
      if (wasModelReady && !this.modelReady) {
        this.currentStep = 'model';
        this.render();
        return;
      }
      if (this.currentStep === 'model') {
        this.render();
      }
    });

    this.render();
  }

  override onClose(): void {
    // Invalidate a prerequisite check that may still be awaiting the filesystem.
    // Without this guard, its continuation can subscribe and render after close.
    this.openGeneration += 1;
    this.modelManagerUnsub?.();
    this.modelManagerUnsub = null;
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    const isWelcome = this.currentStep === 'sidecar' && !this.sidecarReady;
    this.setTitle(isWelcome ? t('setup.wizard.welcomeTitle') : t('setup.wizard.title'));

    this.renderProgress();

    switch (this.currentStep) {
      case 'sidecar':
        this.renderSidecarStep();
        break;
      case 'model':
        this.renderModelStep();
        break;
      case 'microphone':
        this.renderMicrophoneStep();
        break;
      case 'ready':
        this.renderReadyStep();
        break;
    }
  }

  private renderProgress(): void {
    const bar = this.contentEl.createDiv({ cls: 'local-stt-wizard-progress' });
    STEP_ORDER.forEach((step, index) => {
      const dot = bar.createDiv({
        cls: 'local-stt-wizard-progress__dot',
      });
      if (step === this.currentStep) {
        dot.addClass('is-active');
      }
      if (this.isStepComplete(step)) {
        dot.addClass('is-complete');
      }
      dot.setText(String(index + 1));
    });
  }

  private isStepComplete(step: WizardStepId): boolean {
    if (step === 'sidecar') return this.sidecarReady;
    if (step === 'model') return this.modelReady;
    if (step === 'microphone') return this.microphoneResult.status === 'ready';
    return false;
  }

  // ---------------- Step 1: Sidecar ----------------
  private renderSidecarStep(): void {
    const body = this.contentEl.createDiv({ cls: 'local-stt-wizard-step' });

    if (this.sidecarReady) {
      body.createEl('h2', {
        cls: 'local-stt-wizard-step__title',
        text: t('setup.wizard.engineReadyTitle'),
      });
      body.createEl('p', {
        text: t('setup.wizard.engineReadyDesc'),
      });
    } else {
      body.createEl('p', {
        text: t('setup.wizard.intro'),
      });

      body.createEl('p', { text: t('setup.wizard.quickSetup') });
      const steps = body.createEl('ol');
      steps.createEl('li', { text: t('setup.wizard.downloadEngineStep') });
      steps.createEl('li', { text: t('setup.wizard.pickModelStep') });

      body.createEl('p', {
        text: t('setup.wizard.startTalking'),
      });

      if (!Platform.isMacOS) {
        body.createEl('p', {
          cls: 'local-stt-wizard-step__muted',
          text: t('setup.wizard.cpuBuildNote'),
        });
      }
    }

    const actions = this.contentEl.createDiv({ cls: 'local-stt-wizard-actions' });
    actions.createEl('button', { text: t('common.cancel') }).addEventListener('click', () => {
      this.close();
    });

    if (this.sidecarReady) {
      const next = actions.createEl('button', {
        cls: 'mod-cta',
        text: t('common.next'),
      });
      next.addEventListener('click', () => this.goNext());
    } else {
      const installBtn = actions.createEl('button', {
        cls: 'mod-cta',
        text: t('setup.wizard.downloadEngine'),
      });
      installBtn.addEventListener('click', () => this.openSidecarInstall());
    }
  }

  private openSidecarInstall(): void {
    const modal = new SidecarInstallModal(this.deps.app, {
      copy: getInstallCopy('cpu', 'first-run'),
      feedback: this.deps.feedback,
      manager: this.deps.sidecarInstallManager,
      onInstalled: async () => {
        await this.deps.postSidecarInstalled();
        this.sidecarReady = true;
        this.goNext();
      },
      pluginDirectory: this.deps.pluginDirectory,
      variants: ['cpu'],
      version: this.deps.sidecarVersion,
    });
    modal.open();
  }

  // ---------------- Step 2: Model ----------------
  private renderModelStep(): void {
    const body = this.contentEl.createDiv({ cls: 'local-stt-wizard-step' });
    body.createEl('h2', {
      cls: 'local-stt-wizard-step__title',
      text: this.modelReady
        ? t('setup.wizard.modelSelectedTitle')
        : t('setup.wizard.pickModelTitle'),
    });
    if (this.modelReady) {
      body.createEl('p', {
        text: t('setup.wizard.modelSelectedDesc'),
      });
    } else {
      this.renderStartingModelRecommendation(body);
    }

    const recommendation = this.modelReady ? null : this.resolveStartingModelRecommendation();
    const actions = this.contentEl.createDiv({ cls: 'local-stt-wizard-actions' });
    actions
      .createEl('button', { text: t('common.back') })
      .addEventListener('click', () => this.goBack());
    const customize = actions.createEl('button', { text: t('setup.wizard.openModelPicker') });
    customize.addEventListener('click', () => this.openModelPicker());
    const capabilityLoadError = this.deps.modelInstallManager.getState().capabilityLoadError;
    const capabilitiesUnavailable = capabilityLoadError != null;
    if (capabilitiesUnavailable) {
      actions
        .createEl('button', {
          cls: 'mod-cta',
          text: t('setup.wizard.recommendation.retryCapabilities'),
        })
        .addEventListener('click', () => {
          void this.deps.modelInstallManager.init();
        });
    }

    if (this.modelReady) {
      const next = actions.createEl('button', { cls: 'mod-cta', text: t('common.next') });
      next.addEventListener('click', () => this.goNext());
    } else if (recommendation !== null) {
      const state = this.deps.modelInstallManager.getState();
      const installed = state.installedModels.some((model) =>
        matchesModelTriple(
          model,
          recommendation.model.runtimeId,
          recommendation.model.familyId,
          recommendation.model.modelId,
        ),
      );
      const actionState = recommendationActionState(
        state,
        recommendation,
        installed,
        this.recommendationPending,
      );
      const action = actions.createEl('button', {
        cls: 'mod-cta',
        text: actionState.label,
      });
      action.disabled = actionState.disabled;
      action.addEventListener('click', () => {
        void this.useStartingModel(recommendation, installed);
      });
    } else if (!capabilitiesUnavailable) {
      customize.addClass('mod-cta');
    }
  }

  private renderStartingModelRecommendation(body: HTMLDivElement): void {
    const state = this.deps.modelInstallManager.getState();
    if (state.loadStatus === 'loading') {
      body.createEl('p', { text: t('setup.wizard.recommendation.catalogLoading') });
      return;
    }
    if (state.loadStatus === 'error') {
      body.createEl('p', { text: t('models.manage.loadCatalogFailed') });
      return;
    }
    if (state.capabilityLoadError != null) {
      body.createEl('h3', { text: t('setup.wizard.recommendation.capabilitiesUnavailableTitle') });
      body.createEl('p', { text: t('setup.wizard.recommendation.capabilitiesUnavailableDesc') });
      return;
    }

    const recommendation = this.resolveStartingModelRecommendation();
    if (recommendation === null) {
      body.createEl('h3', { text: t('setup.wizard.recommendation.unavailableTitle') });
      body.createEl('p', { text: t('setup.wizard.recommendation.unavailableDesc') });
      return;
    }

    const card = body.createDiv({ cls: 'local-stt-wizard-model-recommendation' });
    const heading = card.createDiv({ cls: 'local-stt-wizard-model-recommendation__heading' });
    const icon = heading.createSpan({ cls: 'local-stt-wizard-model-recommendation__icon' });
    setIcon(icon, 'sparkles');
    const headingText = heading.createDiv();
    headingText.createSpan({
      cls: 'local-stt-wizard-model-recommendation__eyebrow',
      text: t('setup.wizard.recommendation.title'),
    });
    headingText.createEl('h3', { text: recommendation.model.displayName });

    card.createEl('p', {
      cls: 'local-stt-wizard-model-recommendation__task',
      text: t('setup.wizard.recommendation.task'),
    });
    card.createEl('p', {
      text: `${recommendationReason(recommendation)} ${hardwareReason(recommendation)}`,
    });
    card.createEl('p', {
      text: t(
        recommendation.mode === 'live'
          ? 'setup.wizard.recommendation.mode.live'
          : 'setup.wizard.recommendation.mode.final',
      ),
    });
    card.createEl('p', {
      text: t('setup.wizard.recommendation.languages', {
        languages: recommendation.supportedLanguages.map(formatCatalogLanguageLabel).join(', '),
      }),
    });
    card.createEl('p', {
      text: t('setup.wizard.recommendation.cost', {
        size: formatBytes(recommendation.totalSizeBytes),
      }),
    });
    if (!Platform.isMacOS) {
      card.createEl('p', {
        cls: 'local-stt-wizard-step__muted',
        text: t('setup.wizard.recommendation.cudaOptional'),
      });
    }
  }

  private resolveStartingModelRecommendation(): StartingModelRecommendation | null {
    const state = this.deps.modelInstallManager.getState();
    if (state.loadStatus !== 'ready' || state.capabilityLoadError != null) return null;
    return resolveStartingModelRecommendation(
      state,
      this.deps.modelInstallManager.getDictationLanguage(),
      readFirstRunHardwareProfile(),
    );
  }

  private async useStartingModel(
    recommendation: StartingModelRecommendation,
    installed: boolean,
  ): Promise<void> {
    if (this.recommendationPending !== null) return;
    if (this.deps.hasSelectedModel()) {
      this.modelReady = true;
      this.render();
      return;
    }

    const generation = this.openGeneration;
    this.recommendationPending = installed ? 'selecting' : 'installing';
    this.render();
    const selection = {
      familyId: recommendation.model.familyId,
      kind: 'catalog_model' as const,
      modelId: recommendation.model.modelId,
      runtimeId: recommendation.model.runtimeId,
    };

    try {
      if (installed) {
        await this.deps.modelInstallManager.select(selection);
      } else {
        await this.deps.modelInstallManager.installAndWait(selection);
      }
      this.modelReady = this.deps.hasSelectedModel();
      if (!this.modelReady) {
        throw new Error('The model was installed but no selection was committed.');
      }
    } catch (cause) {
      this.deps.feedback.show({
        cause,
        intent: 'error',
        key: 'setup-wizard-recommended-model',
        message: t(
          installed
            ? 'setup.wizard.recommendation.selectFailed'
            : 'setup.wizard.recommendation.failed',
        ),
      });
    } finally {
      this.recommendationPending = null;
      if (generation === this.openGeneration) {
        this.render();
      }
    }
  }

  private openModelPicker(): void {
    const modal = new ManageModelsModal(this.deps.app, {
      feedback: this.deps.feedback,
      initialTask: 'stt',
      manager: this.deps.modelInstallManager,
      onChanged: () => {
        // Re-check on any change so the wizard advances as soon as a model is selected.
        this.modelReady = this.deps.hasSelectedModel();
        if (this.modelReady) {
          this.render();
        }
      },
    });
    modal.open();
  }

  // ---------------- Step 3: Microphone ----------------
  private renderMicrophoneStep(): void {
    const ready = this.microphoneResult.status === 'ready';
    const body = this.contentEl.createDiv({ cls: 'local-stt-wizard-step' });
    body.createEl('h2', {
      cls: 'local-stt-wizard-step__title',
      text: t(ready ? 'setup.microphone.readyTitle' : 'setup.microphone.title'),
    });
    body.createEl('p', {
      text: t(ready ? 'setup.microphone.readyDesc' : 'setup.microphone.intro'),
    });

    if (!ready && this.microphoneResult.error !== undefined) {
      const recovery = body.createDiv({ cls: 'local-stt-wizard-warning' });
      recovery.createEl('strong', {
        text:
          formatMicrophoneCaptureErrorMessage(this.microphoneResult.error) ??
          formatMicrophonePermissionDeniedMessage(),
      });
      recovery.createEl('p', {
        text: t(
          this.microphoneResult.recovery === 'reopen'
            ? 'setup.microphone.reopenSetup'
            : 'setup.microphone.recheck',
        ),
      });
    }

    const actions = this.contentEl.createDiv({ cls: 'local-stt-wizard-actions' });
    actions
      .createEl('button', { text: t('common.back') })
      .addEventListener('click', () => this.goBack());
    if (ready) {
      actions
        .createEl('button', { cls: 'mod-cta', text: t('common.continue') })
        .addEventListener('click', () => this.goNext());
    } else {
      const check = actions.createEl('button', {
        cls: 'mod-cta',
        text: t(
          this.checkingMicrophone
            ? 'setup.microphone.checking'
            : this.microphoneResult.error === undefined
              ? 'setup.microphone.check'
              : 'setup.microphone.checkAgain',
        ),
      });
      check.disabled = this.checkingMicrophone;
      check.addEventListener('click', () => {
        void this.checkMicrophone();
      });
    }
  }

  private async checkMicrophone(): Promise<void> {
    if (this.checkingMicrophone) return;
    const generation = this.openGeneration;
    this.checkingMicrophone = true;
    this.render();
    try {
      this.microphoneResult = await this.microphoneReadiness.check();
    } finally {
      this.checkingMicrophone = false;
      if (generation === this.openGeneration) {
        this.render();
      }
    }
  }

  // ---------------- Step 4: Ready ----------------
  private renderReadyStep(): void {
    const body = this.contentEl.createDiv({ cls: 'local-stt-wizard-step' });
    body.createEl('h2', {
      cls: 'local-stt-wizard-step__title',
      text: t('setup.wizard.readyTitle'),
    });
    body.createEl('p', {
      text: t('setup.wizard.readyDesc'),
    });

    const cardRibbon = body.createDiv({ cls: 'local-stt-wizard-card' });
    const ribbonIcon = cardRibbon.createSpan({ cls: 'local-stt-wizard-card__icon' });
    setIcon(ribbonIcon, 'mic');
    const ribbonText = cardRibbon.createDiv({ cls: 'local-stt-wizard-card__text' });
    ribbonText.createEl('strong', { text: t('setup.wizard.ribbonTitle') });
    ribbonText.createEl('p', {
      text: t('setup.wizard.ribbonDesc'),
    });

    const cardHotkey = body.createDiv({ cls: 'local-stt-wizard-card' });
    const hotkeyIcon = cardHotkey.createSpan({ cls: 'local-stt-wizard-card__icon' });
    setIcon(hotkeyIcon, 'keyboard');
    const hotkeyText = cardHotkey.createDiv({ cls: 'local-stt-wizard-card__text' });
    hotkeyText.createEl('strong', { text: t('setup.wizard.hotkeyTitle') });
    const hotkeyDesc = hotkeyText.createEl('p');
    hotkeyDesc.appendText(t('setup.wizard.hotkeyDescBefore'));
    hotkeyDesc.createEl('strong', { text: t('setup.wizard.toggleCommandName') });
    hotkeyDesc.appendText(t('setup.wizard.hotkeyDescAfter'));
    const hotkeyBtn = cardHotkey.createEl('button', {
      text: t('setup.wizard.openHotkeySettings'),
    });
    hotkeyBtn.addEventListener('click', () => this.openHotkeySettings());

    const actions = this.contentEl.createDiv({ cls: 'local-stt-wizard-actions' });
    actions
      .createEl('button', { text: t('common.back') })
      .addEventListener('click', () => this.goBack());
    const done = actions.createEl('button', { text: t('common.done') });
    done.addEventListener('click', () => {
      void this.readyActions.done();
    });
    const tryDictation = actions.createEl('button', {
      cls: 'mod-cta',
      text: t('setup.wizard.tryDictationNow'),
    });
    tryDictation.addEventListener('click', () => {
      void this.readyActions.tryDictationNow();
    });
  }

  private openHotkeySettings(): void {
    openFilteredHotkeySettings(this.deps.app, 'Speech Kit', (error) => {
      this.deps.feedback.show({
        cause: error,
        intent: 'warning',
        message: t('setup.wizard.openHotkeySettingsFallback'),
      });
    });
  }

  // ---------------- Navigation ----------------
  private goNext(): void {
    const idx = STEP_ORDER.indexOf(this.currentStep);
    if (idx < 0) return;
    const next = STEP_ORDER[idx + 1];
    if (next !== undefined) {
      this.currentStep = next;
      this.render();
    }
  }

  private goBack(): void {
    const idx = STEP_ORDER.indexOf(this.currentStep);
    if (idx <= 0) return;
    const prev = STEP_ORDER[idx - 1];
    if (prev !== undefined) {
      this.currentStep = prev;
      this.render();
    }
  }
}

export function recommendationStateSignature(state: ModelManagerState): string {
  const active = state.activeInstall;
  return JSON.stringify({
    activeInstall:
      active === null
        ? null
        : [modelTripleKey(active.installUpdate), active.phase, active.installUpdate.state],
    capabilityLoadError: state.capabilityLoadError ?? null,
    catalog: [
      state.catalog.catalogVersion,
      state.catalog.models.map((model) => [
        model.runtimeId,
        model.familyId,
        model.modelId,
        model.displayName,
        model.task,
        model.languageTags,
        model.supportsAutomaticLanguageDetection,
        model.uxTags,
        getTotalModelSize(model),
      ]),
    ],
    compiledAdapters: state.compiledAdapters.map((adapter) => [
      adapter.runtimeId,
      adapter.familyId,
      adapter.familyCapabilities.task,
      adapter.familyCapabilities.supportsStreaming,
      adapter.familyCapabilities.supportedLanguages,
    ]),
    compiledRuntimes: state.compiledRuntimes.map((runtime) => runtime.runtimeId),
    failedInstall:
      state.failedInstall === null
        ? null
        : [state.failedInstall.failureId, modelTripleKey(state.failedInstall.selection)],
    installedModels: state.installedModels.map(modelTripleKey).sort(),
    loadError: state.loadError,
    loadStatus: state.loadStatus,
    selectedModel: selectedModelKey(state.selectedModel),
  });
}

function modelTripleKey(model: { familyId: string; modelId: string; runtimeId: string }): string {
  return `${model.runtimeId}:${model.familyId}:${model.modelId}`;
}

function selectedModelKey(selection: SelectedModel | null): string | null {
  if (selection === null) return null;
  return selection.kind === 'catalog_model'
    ? modelTripleKey(selection)
    : `external:${selection.familyId}:${selection.filePath}`;
}

interface RecommendationActionState {
  disabled: boolean;
  label: string;
}

function recommendationActionState(
  state: ModelManagerState,
  recommendation: StartingModelRecommendation,
  installed: boolean,
  pending: 'installing' | 'selecting' | null,
): RecommendationActionState {
  if (pending === 'installing') {
    return { disabled: true, label: t('setup.wizard.recommendation.installing') };
  }
  if (pending === 'selecting') {
    return { disabled: true, label: t('setup.wizard.recommendation.selecting') };
  }
  const active = state.activeInstall?.installUpdate;
  if (
    active !== undefined &&
    matchesModelTriple(
      active,
      recommendation.model.runtimeId,
      recommendation.model.familyId,
      recommendation.model.modelId,
    )
  ) {
    return { disabled: true, label: t('setup.wizard.recommendation.installing') };
  }
  if (active !== undefined) {
    return {
      disabled: true,
      label: t('setup.wizard.recommendation.anotherInstallActive'),
    };
  }
  if (
    state.failedInstall !== null &&
    matchesModelTriple(
      state.failedInstall.selection,
      recommendation.model.runtimeId,
      recommendation.model.familyId,
      recommendation.model.modelId,
    )
  ) {
    return { disabled: false, label: t('setup.wizard.recommendation.retry') };
  }
  return {
    disabled: false,
    label: installed
      ? t('setup.wizard.recommendation.use')
      : t('setup.wizard.recommendation.installAndUse'),
  };
}

function recommendationReason(recommendation: StartingModelRecommendation): string {
  switch (recommendation.reason) {
    case 'automatic':
      return t('setup.wizard.recommendation.reason.automatic');
    case 'liveEnglish':
      return t('setup.wizard.recommendation.reason.liveEnglish');
    case 'multilingual':
      return t('setup.wizard.recommendation.reason.multilingual');
    case 'finalOnly':
      return t('setup.wizard.recommendation.reason.finalOnly');
  }
}

function hardwareReason(recommendation: StartingModelRecommendation): string {
  switch (recommendation.hardwareClass) {
    case 'constrained':
      if (recommendation.resourceClass === 'demanding') {
        if (recommendation.mode === 'live' && recommendation.liveChoiceIsOnly) {
          return t('setup.wizard.recommendation.reason.hardware.constrainedOnlyLive');
        }
        if (recommendation.mode === 'live') {
          return t('setup.wizard.recommendation.reason.hardware.constrainedFallback');
        }
        return t('setup.wizard.recommendation.reason.hardware.constrainedFinalFallback');
      }
      return t(
        recommendation.mode === 'live'
          ? 'setup.wizard.recommendation.reason.hardware.constrainedLive'
          : 'setup.wizard.recommendation.reason.hardware.constrained',
      );
    case 'standard':
      return t('setup.wizard.recommendation.reason.hardware.standard');
    case 'unknown':
      return t('setup.wizard.recommendation.reason.hardware.unknown');
  }
}
