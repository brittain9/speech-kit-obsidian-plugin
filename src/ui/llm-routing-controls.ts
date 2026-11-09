import { createHash, randomUUID } from 'node:crypto';
import {
  AbstractInputSuggest,
  type App,
  type ExtraButtonComponent,
  SecretComponent,
  Setting,
  setIcon,
} from 'obsidian';

import { isLoopbackHostname, validateOpenAiCompatibleBaseUrl } from '../llm/openai-compatible-url';
import { MIN_OUTPUT_TOKENS } from '../llm/output-budget';
import {
  formatLlmProviderName,
  getProviderModel,
  LLM_PROVIDER_IDS,
  type LlmProviderId,
  type LlmRoutingPolicy,
  type ModelOption,
  ProviderError,
  type ProviderHealth,
  withOpenAiCompatibleBaseUrl,
  withProviderConfigurationModel,
  withProviderSecretId,
} from '../llm/provider';
import { createProvider } from '../llm/provider-factory';
import { resolveLlmReadiness } from '../llm/readiness';
import { activeLlmProviderIds } from '../llm/routing-policy';
import type { PluginSettingsMutation } from '../settings/llm-preset-state';
import {
  DEFAULT_LLM_ROUTING_THRESHOLD_CHARS,
  MAX_LLM_ROUTING_THRESHOLD_CHARS,
  MIN_LLM_ROUTING_THRESHOLD_CHARS,
  type PluginSettings,
} from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import { formatCleanupFailureBanner, priceTier, providerHealthFromError } from './llm-provider-ui';
import { deriveInlineStatus, INLINE_STATUS_PRESENTATION } from './llm-status';
import { addValidatedNumberSetting } from './validated-number-setting';

export interface LlmRoutingControlsDependencies {
  app: App;
  feedback: Pick<UserFeedback, 'show'>;
  getSecret: (secretId: string) => string;
  getSettings: () => PluginSettings;
  logger?: PluginLogger | undefined;
  persist: (mutation: PluginSettingsMutation, options?: { rerender?: boolean }) => Promise<void>;
  openModelSettings?: () => void;
}

const SECRET_REFRESH_DEBOUNCE_MS = 500;
const TEST_RESULT_ICON_MS = 2500;

interface ProviderState {
  health: ProviderHealth;
  models: ModelOption[];
  modelsLoaded: boolean;
}

function emptyProviderState(): ProviderState {
  return { health: { kind: 'unknown' }, models: [], modelsLoaded: false };
}

class ModelSuggest extends AbstractInputSuggest<ModelOption> {
  constructor(
    app: App,
    inputEl: HTMLInputElement | HTMLDivElement,
    private readonly getCatalog: () => ModelOption[],
    private readonly onChoose: (id: string) => void,
  ) {
    super(app, inputEl);
  }

  override getSuggestions(query: string): ModelOption[] {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return this.getCatalog();
    }
    return this.getCatalog().filter(
      (model) =>
        model.id.toLowerCase().includes(normalized) ||
        model.displayName.toLowerCase().includes(normalized),
    );
  }

  override renderSuggestion(model: ModelOption, el: HTMLElement): void {
    const top = el.createDiv({ cls: 'local-dictation-suggest__top' });
    top.createSpan({ cls: 'local-dictation-suggest__primary', text: model.id });
    const tier = priceTier(model.pricing);
    if (tier !== null) {
      const pill = top.createSpan({
        cls: 'local-dictation-price',
        text: tier === 'free' ? t('common.free') : tier,
      });
      pill.setAttribute('title', t('llm.routing.priceTierTooltip'));
      if (tier === 'free') pill.addClass('local-dictation-price--free');
      if (tier === '$$$' || tier === '$$$$') pill.addClass('local-dictation-price--premium');
    }
    if (model.displayName !== model.id) {
      el.createSpan({ cls: 'local-dictation-suggest__secondary', text: model.displayName });
    }
  }

  override selectSuggestion(model: ModelOption): void {
    this.setValue(model.id);
    this.onChoose(model.id);
    this.close();
  }
}

export class LlmRoutingControls {
  private readonly providers: Record<LlmProviderId, ProviderState> = {
    ollama: emptyProviderState(),
    openrouter: emptyProviderState(),
    openai_compatible: emptyProviderState(),
  };
  private readonly modelListId = `local-dictation-openai-compatible-models-${randomUUID()}`;
  private disposed = false;
  private renderGeneration = 0;
  private readinessHost: HTMLElement | null = null;
  private providerViewUpdates: Partial<Record<LlmProviderId, () => void>> = {};
  private modelsRefreshInFlight: Partial<
    Record<LlmProviderId, { state: ProviderState; promise: Promise<void> }>
  > = {};
  private readonly discoveryConfigurations: Partial<
    Record<LlmProviderId, { baseUrl: string; secretId: string; secretFingerprint: string }>
  > = {};
  private readonly configurationRevisions: Record<LlmProviderId, number> = {
    ollama: 0,
    openrouter: 0,
    openai_compatible: 0,
  };
  private readonly configurationSaves: Partial<Record<LlmProviderId, Promise<void>>> = {};
  private secretRefreshTimerId: number | null = null;
  private readonly testsInFlight = new Map<LlmProviderId, number>();

  constructor(private readonly dependencies: LlmRoutingControlsDependencies) {}

  dispose(): void {
    this.disposed = true;
    if (this.secretRefreshTimerId !== null) {
      window.clearTimeout(this.secretRefreshTimerId);
      this.secretRefreshTimerId = null;
    }
  }

  refreshActiveProviders(options: { forceLocal?: boolean } = {}): Promise<void> {
    const settings = this.dependencies.getSettings();
    const refreshes = activeLlmProviderIds(settings.llmRoutingPolicy).map((providerId) =>
      options.forceLocal === true && shouldForceLocalCatalogRefresh(providerId, settings)
        ? this.refreshModels(providerId, true)
        : this.recheckModels(providerId),
    );
    return Promise.all(refreshes).then(() => undefined);
  }

  render(parent: HTMLElement, settings: PluginSettings): void {
    this.renderGeneration += 1;
    this.providerViewUpdates = {};
    this.renderProviderSelection(parent, settings);

    const policy = settings.llmRoutingPolicy;
    if (policy === null) {
      return;
    }
    if (policy.kind === 'fixed') {
      this.renderProviderConfiguration(parent, settings, policy.providerId);
      return;
    }

    this.renderLeg(parent, t('llm.routing.defaultLeg'));
    this.renderProviderConfiguration(parent, settings, policy.defaultProviderId);
    this.renderLeg(parent, t('llm.routing.largeLeg'));
    this.renderProviderConfiguration(parent, settings, policy.largeTranscriptProviderId);
  }

  async testProvider(providerId: Exclude<LlmProviderId, 'ollama'>): Promise<string | null> {
    const settings = this.dependencies.getSettings();
    const model = getProviderModel(settings.llmProviderConfigurations, providerId);
    if (model.length === 0) {
      return formatCleanupFailureBanner({
        code: 'model_not_configured',
        message: '',
        providerId,
      });
    }
    if (providerId === 'openai_compatible') {
      const validation = validateOpenAiCompatibleBaseUrl(
        settings.llmProviderConfigurations.openai_compatible.baseUrl,
      );
      if (!validation.valid) {
        return customUrlValidationMessage(validation.code);
      }
    }

    try {
      await this.createProvider(providerId, settings).cleanup({
        // Reasoning models can spend hidden output tokens before their visible
        // reply, so the normal budget floor is the smallest reliable probe.
        maxOutputTokens: MIN_OUTPUT_TOKENS,
        model,
        prompt: 'Reply with the single word OK.',
        temperature: 0,
        userMessage: 'ping',
      });
      return null;
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError(
              error instanceof Error ? error.message : String(error),
              'connection_failed',
            );
      return formatCleanupFailureBanner({
        code: providerError.code,
        message: providerError.message,
        providerId,
      });
    }
  }

  private renderProviderSelection(parent: HTMLElement, settings: PluginSettings): void {
    const policy = settings.llmRoutingPolicy;
    const selectedProvider =
      policy === null ? '' : policy.kind === 'fixed' ? policy.providerId : policy.defaultProviderId;
    const name =
      policy?.kind === 'transcript_size'
        ? t('llm.routing.defaultProvider')
        : t('llm.routing.provider');

    const selection = new Setting(parent)
      .setName(name)
      .setDesc(t('llm.routing.audioPrivacy'))
      .addDropdown((dropdown) => {
        dropdown.addOption('', t('llm.routing.chooseProvider'));
        for (const providerId of LLM_PROVIDER_IDS) {
          dropdown.addOption(providerId, providerLabel(providerId));
        }
        dropdown.setValue(selectedProvider);
        dropdown.onChange(async (value) => {
          if (value === '') {
            await this.persistPolicy(() => null);
            return;
          }
          if (!LLM_PROVIDER_IDS.includes(value as LlmProviderId)) {
            return;
          }
          const providerId = value as LlmProviderId;
          await this.persistPolicy((current) =>
            current?.kind === 'transcript_size'
              ? {
                  ...current,
                  defaultProviderId: providerId,
                  largeTranscriptProviderId:
                    current.largeTranscriptProviderId === providerId
                      ? firstOtherProvider(providerId)
                      : current.largeTranscriptProviderId,
                }
              : { kind: 'fixed', providerId },
          );
        });
      });
    this.readinessHost = selection.descEl.createDiv();
    this.renderReadiness(this.readinessHost, settings);
    if (policy === null) this.addModelSettingsAction(selection);

    if (policy !== null) {
      new Setting(parent)
        .setName(t('llm.routing.useLargeProvider'))
        .setDesc(t('llm.routing.useLargeProviderDescription'))
        .addToggle((toggle) => {
          toggle.setValue(policy.kind === 'transcript_size');
          toggle.onChange(async (enabled) => {
            await this.persistPolicy((current) => {
              if (current === null) return null;
              const defaultProviderId =
                current.kind === 'fixed' ? current.providerId : current.defaultProviderId;
              if (!enabled) return { kind: 'fixed', providerId: defaultProviderId };
              return {
                defaultProviderId,
                kind: 'transcript_size',
                largeTranscriptProviderId:
                  current.kind === 'transcript_size'
                    ? current.largeTranscriptProviderId
                    : firstOtherProvider(defaultProviderId),
                thresholdChars:
                  current.kind === 'transcript_size'
                    ? current.thresholdChars
                    : DEFAULT_LLM_ROUTING_THRESHOLD_CHARS,
              };
            });
          });
        });
    }

    if (policy?.kind === 'transcript_size') {
      new Setting(parent).setName(t('llm.routing.largeProvider')).addDropdown((dropdown) => {
        for (const providerId of LLM_PROVIDER_IDS) {
          if (providerId !== policy.defaultProviderId) {
            dropdown.addOption(providerId, providerLabel(providerId));
          }
        }
        dropdown.setValue(policy.largeTranscriptProviderId);
        dropdown.onChange(async (value) => {
          if (!LLM_PROVIDER_IDS.includes(value as LlmProviderId)) return;
          const providerId = value as LlmProviderId;
          await this.persistPolicy((current) =>
            current?.kind === 'transcript_size' && providerId !== current.defaultProviderId
              ? { ...current, largeTranscriptProviderId: providerId }
              : current,
          );
        });
      });

      addValidatedNumberSetting(parent, {
        desc: t('llm.model.routingThreshold.description'),
        integer: true,
        max: MAX_LLM_ROUTING_THRESHOLD_CHARS,
        min: MIN_LLM_ROUTING_THRESHOLD_CHARS,
        name: t('llm.model.routingThreshold.name'),
        onChange: (thresholdChars) => {
          void this.persistRoutingThreshold(thresholdChars);
        },
        value: policy.thresholdChars,
      }).setClass('local-dictation-route-setting');
    }
  }

  private renderReadiness(parent: HTMLElement, settings: PluginSettings): void {
    const readiness = resolveLlmReadiness({
      configurations: settings.llmProviderConfigurations,
      getSecret: this.dependencies.getSecret,
      policy: settings.llmRoutingPolicy,
    });
    if (readiness.ready) return;

    const row = parent.createDiv({ cls: 'local-dictation-status local-dictation-status--warning' });
    row.setAttribute('role', 'status');
    const icon = row.createSpan({ cls: 'local-dictation-status__icon' });
    icon.setAttribute('aria-hidden', 'true');
    setIcon(icon, 'alert-triangle');
    row.createSpan({
      cls: 'local-dictation-status__text',
      text: readinessMessage(readiness.issue),
    });
  }

  private updateReadiness(): void {
    if (this.disposed || this.readinessHost === null) return;
    this.readinessHost.empty();
    this.renderReadiness(this.readinessHost, this.dependencies.getSettings());
  }

  private updateProviderView(providerId: LlmProviderId): void {
    if (this.disposed) return;
    this.providerViewUpdates[providerId]?.();
    this.updateReadiness();
  }

  private renderProviderConfiguration(
    parent: HTMLElement,
    settings: PluginSettings,
    providerId: LlmProviderId,
  ): void {
    this.syncDiscoveryConfiguration(providerId);
    switch (providerId) {
      case 'ollama':
        this.renderOllamaModel(parent);
        return;
      case 'openrouter':
        this.renderSecret(parent, settings, providerId);
        this.renderEditableModel(parent, settings, providerId);
        return;
      case 'openai_compatible':
        this.renderCustomBaseUrl(parent, settings);
        this.renderSecret(parent, settings, providerId);
        this.renderEditableModel(parent, settings, providerId);
        return;
    }
  }

  private renderOllamaModel(parent: HTMLElement): void {
    const providerId = 'ollama';
    let updateModels: () => void = () => {};
    const setting = new Setting(parent)
      .setName(t('llm.routing.providerModel', { provider: formatLlmProviderName(providerId) }))
      .setDesc(t('llm.routing.ollamaModelDescription'))
      .addDropdown((dropdown) => {
        updateModels = () => {
          const state = this.providers[providerId];
          const selectedModel = getProviderModel(
            this.dependencies.getSettings().llmProviderConfigurations,
            providerId,
          );
          dropdown.selectEl.empty();
          dropdown.addOption('', t('llm.routing.selectModel'));
          if (selectedModel.length > 0 && !state.models.some((model) => model.id === selectedModel))
            dropdown.addOption(selectedModel, selectedModel);
          for (const model of state.models) dropdown.addOption(model.id, model.displayName);
          dropdown.setValue(selectedModel);
        };
        updateModels();
        dropdown.onChange(async (model) => {
          await this.persistModel(providerId, model);
          const updated = this.dependencies.getSettings();
          if (
            this.automaticRequestsAllowed('ollama') &&
            getProviderModel(updated.llmProviderConfigurations, 'ollama') === model
          )
            this.prewarm(model);
        });
      })
      .addExtraButton((button) => {
        button
          .setIcon('refresh-cw')
          .setTooltip(t('llm.routing.refreshModels', { provider: 'Ollama' }))
          .onClick(() => void this.refreshModels(providerId));
      });
    this.addModelSettingsAction(setting);
    const updateStatus = this.renderStatusRow(setting.descEl, providerId);
    this.providerViewUpdates[providerId] = () => {
      updateModels();
      updateStatus();
    };
  }

  private renderCustomBaseUrl(parent: HTMLElement, settings: PluginSettings): void {
    const config = settings.llmProviderConfigurations.openai_compatible;
    const setting = new Setting(parent)
      .setName(t('llm.routing.customBaseUrl.name'))
      .setDesc(t('llm.routing.customBaseUrl.description'))
      .addText((text) => {
        text.setPlaceholder('http://localhost:1234/v1');
        text.setValue(config.baseUrl);
        text.onChange(async (baseUrl) => {
          this.configurationRevisions.openai_compatible += 1;
          this.providers.openai_compatible = emptyProviderState();
          await this.saveConfiguration('openai_compatible', (current) => ({
            ...current,
            llmProviderConfigurations: withOpenAiCompatibleBaseUrl(
              current.llmProviderConfigurations,
              baseUrl,
            ),
          }));
          if (this.disposed || this.renderGeneration !== generation) return;
          updateDestination();
          this.updateProviderView('openai_compatible');
        });
      });

    const generation = this.renderGeneration;
    const destinationHost = setting.descEl.createDiv();
    const updateDestination = (): void => {
      destinationHost.empty();
      const validation = validateOpenAiCompatibleBaseUrl(
        this.dependencies.getSettings().llmProviderConfigurations.openai_compatible.baseUrl,
      );
      if (!validation.valid) return;
      const url = new URL(validation.normalizedUrl);
      const destination = destinationHost.createDiv({ cls: 'local-dictation-route-field__hint' });
      destination.setText(t('llm.routing.customDestination', { host: url.host }));
      if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
        const warning = destinationHost.createDiv({
          cls: 'local-dictation-status local-dictation-status--warning',
        });
        warning.setText(t('llm.routing.insecureHttpWarning'));
      }
    };
    updateDestination();
  }

  private renderSecret(
    parent: HTMLElement,
    settings: PluginSettings,
    providerId: 'openrouter' | 'openai_compatible',
  ): void {
    const configuration = settings.llmProviderConfigurations[providerId];
    new Setting(parent)
      .setName(
        providerId === 'openrouter'
          ? t('llm.routing.openRouterApiKey.name')
          : t('llm.routing.customApiKey.name'),
      )
      .setDesc(
        providerId === 'openrouter'
          ? t('llm.routing.openRouterApiKey.description')
          : t('llm.routing.customApiKey.description'),
      )
      .addComponent((containerEl) =>
        new SecretComponent(this.dependencies.app, containerEl)
          .setValue(configuration.secretId)
          .onChange(async (secretId) => {
            this.configurationRevisions[providerId] += 1;
            this.providers[providerId] = emptyProviderState();
            await this.saveConfiguration(providerId, (current) => ({
              ...current,
              llmProviderConfigurations: withProviderSecretId(
                current.llmProviderConfigurations,
                providerId,
                secretId,
              ),
            }));
            this.updateProviderView(providerId);
            const updated = this.dependencies.getSettings();
            if (
              !this.disposed &&
              updated.llmFeaturesEnabled &&
              updated.llmPostprocessMode !== 'off'
            ) {
              this.scheduleSecretRefresh(providerId);
            } else {
              this.updateReadiness();
            }
          }),
      );
  }

  private renderEditableModel(
    parent: HTMLElement,
    settings: PluginSettings,
    providerId: 'openrouter' | 'openai_compatible',
  ): void {
    const selectedModel = getProviderModel(settings.llmProviderConfigurations, providerId);
    const renderGeneration = this.renderGeneration;
    let refreshStatus: () => void = () => {};
    let refreshOptions: () => void = () => {};
    const setting = new Setting(parent)
      .setName(
        providerId === 'openrouter'
          ? t('llm.routing.openRouterModel.name')
          : t('llm.routing.customModel.name'),
      )
      .setDesc(
        providerId === 'openrouter'
          ? t('llm.routing.openRouterModel.description')
          : t('llm.routing.customModel.description'),
      );
    setting.setClass('local-dictation-model-setting');
    setting.addText((text) => {
      text.setPlaceholder(providerId === 'openrouter' ? 'anthropic/claude-sonnet-4.5' : 'model-id');
      text.setValue(selectedModel);
      if (providerId === 'openrouter') {
        new ModelSuggest(
          this.dependencies.app,
          text.inputEl,
          () => this.providers[providerId].models,
          (model) =>
            void this.persistModel(providerId, model, false).then(() => {
              if (!this.disposed && this.renderGeneration === renderGeneration) {
                refreshStatus();
                this.updateReadiness();
              }
            }),
        );
      } else {
        refreshOptions = this.renderOpenAiCompatibleModelOptions(setting.controlEl, text.inputEl);
      }
      text.onChange(async (model) => {
        await this.persistModel(providerId, model, false);
        if (!this.disposed && this.renderGeneration === renderGeneration) {
          refreshStatus();
          this.updateReadiness();
        }
      });
    });
    setting.addExtraButton((button) => {
      const label = t('llm.routing.refreshModels', {
        provider: formatLlmProviderName(providerId),
      });
      button.setIcon('refresh-cw').setTooltip(label);
      button.extraSettingsEl.setAttribute('aria-label', label);
      button.onClick(() => void this.refreshModels(providerId));
    });
    setting.addExtraButton((button) => {
      button.setIcon('plug-zap').setTooltip(t('llm.routing.testConnection'));
      button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testConnection'));
      button.onClick(() => void this.runConnectionTest(providerId, button));
    });
    this.addModelSettingsAction(setting);
    refreshStatus = this.renderStatusRow(setting.descEl, providerId);
    this.providerViewUpdates[providerId] = () => {
      refreshOptions();
      refreshStatus();
    };
  }

  private addModelSettingsAction(setting: Setting): void {
    const open = this.dependencies.openModelSettings;
    if (!open) return;
    const label = t('llm.model.title');
    setting.addExtraButton((button) => {
      button.setIcon('settings').setTooltip(label).onClick(open);
      button.extraSettingsEl.setAttribute('aria-label', label);
    });
  }

  private renderOpenAiCompatibleModelOptions(
    control: HTMLElement,
    input: HTMLInputElement,
  ): () => void {
    const listId = this.modelListId;
    input.setAttribute('list', listId);
    const datalist = control.createEl('datalist', { attr: { id: listId } });
    const update = (): void => {
      datalist.empty();
      for (const model of this.providers.openai_compatible.models) {
        datalist.createEl('option', { attr: { label: model.displayName, value: model.id } });
      }
    };
    update();
    return update;
  }

  private renderStatusRow(parent: HTMLElement, providerId: LlmProviderId): () => void {
    const row = parent.createDiv();
    row.setAttribute('aria-live', 'polite');
    row.setAttribute('role', 'status');
    const update = (): void => {
      row.empty();
      const state = this.providers[providerId];
      const status = deriveInlineStatus({
        health: state.health,
        models: state.modelsLoaded ? state.models : [],
        providerId,
        selectedModel: getProviderModel(
          this.dependencies.getSettings().llmProviderConfigurations,
          providerId,
        ),
      });
      if (status === null) {
        row.className = '';
        return;
      }
      const presentation = INLINE_STATUS_PRESENTATION[status.variant];
      row.className = `local-dictation-status ${presentation.className}`;
      const icon = row.createSpan({ cls: 'local-dictation-status__icon' });
      icon.setAttribute('aria-hidden', 'true');
      setIcon(icon, presentation.icon);
      row.createSpan({ cls: 'local-dictation-status__text', text: status.text });
    };
    update();
    return update;
  }

  private renderLeg(parent: HTMLElement, label: string): void {
    parent.createDiv({ cls: 'local-dictation-route-leg', text: label });
  }

  private async persistPolicy(
    update: (policy: LlmRoutingPolicy | null) => LlmRoutingPolicy | null,
  ): Promise<void> {
    await this.dependencies.persist((current) => ({
      ...current,
      llmRoutingPolicy: update(current.llmRoutingPolicy),
    }));
    const settings = this.dependencies.getSettings();
    if (!this.disposed && settings.llmFeaturesEnabled && settings.llmPostprocessMode !== 'off') {
      void this.refreshActiveProviders();
    }
  }

  private async persistRoutingThreshold(thresholdChars: number): Promise<void> {
    await this.dependencies.persist(
      (current) =>
        current.llmRoutingPolicy?.kind === 'transcript_size'
          ? { ...current, llmRoutingPolicy: { ...current.llmRoutingPolicy, thresholdChars } }
          : { ...current },
      { rerender: false },
    );
  }

  private async persistModel(
    providerId: LlmProviderId,
    model: string,
    rerender = true,
  ): Promise<void> {
    this.configurationRevisions[providerId] += 1;
    await this.saveConfiguration(
      providerId,
      (current) => ({
        ...current,
        llmProviderConfigurations: withProviderConfigurationModel(
          current.llmProviderConfigurations,
          providerId,
          model,
        ),
      }),
      { rerender },
    );
  }

  private async saveConfiguration(
    providerId: LlmProviderId,
    mutation: PluginSettingsMutation,
    options: { rerender?: boolean } = { rerender: false },
  ): Promise<void> {
    const pending = this.dependencies.persist(mutation, options);
    this.configurationSaves[providerId] = pending;
    try {
      await pending;
    } finally {
      if (this.configurationSaves[providerId] === pending)
        delete this.configurationSaves[providerId];
    }
  }

  private recheckModels(providerId: LlmProviderId): Promise<void> {
    this.syncDiscoveryConfiguration(providerId);
    const state = this.providers[providerId];
    return state.modelsLoaded && state.health.kind === 'ready'
      ? Promise.resolve()
      : this.refreshModels(providerId, true);
  }

  private refreshModels(providerId: LlmProviderId, automatic = false): Promise<void> {
    const pending = this.configurationSaves[providerId];
    if (pending !== undefined)
      return pending.then(
        () =>
          this.disposed || (automatic && !this.automaticRequestsAllowed(providerId))
            ? undefined
            : this.refreshModels(providerId, automatic),
        () => undefined,
      );
    this.syncDiscoveryConfiguration(providerId);
    const currentRefresh = this.modelsRefreshInFlight[providerId];
    const state = this.providers[providerId];
    if (currentRefresh?.state === state) return currentRefresh.promise;
    if (
      providerId === 'openai_compatible' &&
      !validateOpenAiCompatibleBaseUrl(
        this.dependencies.getSettings().llmProviderConfigurations.openai_compatible.baseUrl,
      ).valid
    ) {
      return Promise.resolve();
    }
    const refresh = this.loadModels(providerId, state);
    this.modelsRefreshInFlight[providerId] = { state, promise: refresh };
    return refresh;
  }

  private async loadModels(providerId: LlmProviderId, state: ProviderState): Promise<void> {
    const configuration = this.discoveryConfiguration(providerId);
    try {
      const models = await this.createProvider(providerId).listModels();
      if (!this.sameDiscoveryConfiguration(providerId, configuration)) return;
      state.models = models;
      state.health =
        models.length === 0 ? { kind: 'no_models' } : { kind: 'ready', modelCount: models.length };
    } catch (error) {
      if (!this.sameDiscoveryConfiguration(providerId, configuration)) return;
      state.models = [];
      state.health = providerHealthFromError(error);
      this.dependencies.logger?.warn(
        'llm',
        `${formatLlmProviderName(providerId)} refresh failed (${error instanceof ProviderError ? error.code : 'unknown'}).`,
      );
    } finally {
      if (this.sameDiscoveryConfiguration(providerId, configuration)) state.modelsLoaded = true;
      else if (this.providers[providerId] === state)
        this.providers[providerId] = emptyProviderState();
      if (this.modelsRefreshInFlight[providerId]?.state === state)
        delete this.modelsRefreshInFlight[providerId];
      this.updateProviderView(providerId);
    }
  }

  private syncDiscoveryConfiguration(providerId: LlmProviderId): void {
    const previous = this.discoveryConfigurations[providerId];
    if (previous !== undefined && !this.sameDiscoveryConfiguration(providerId, previous)) {
      this.providers[providerId] = emptyProviderState();
    }
    this.discoveryConfigurations[providerId] = this.discoveryConfiguration(providerId);
  }

  private discoveryConfiguration(providerId: LlmProviderId): {
    baseUrl: string;
    secretId: string;
    secretFingerprint: string;
  } {
    const settings = this.dependencies.getSettings();
    const config = settings.llmProviderConfigurations[providerId];
    const secretId = 'secretId' in config ? config.secretId : '';
    return {
      baseUrl: 'baseUrl' in config ? config.baseUrl : '',
      secretId,
      secretFingerprint:
        secretId.length === 0
          ? ''
          : createHash('sha256').update(this.dependencies.getSecret(secretId)).digest('hex'),
    };
  }

  private sameDiscoveryConfiguration(
    providerId: LlmProviderId,
    expected: { baseUrl: string; secretId: string; secretFingerprint: string },
  ): boolean {
    const current = this.discoveryConfiguration(providerId);
    return (
      current.baseUrl === expected.baseUrl &&
      current.secretId === expected.secretId &&
      current.secretFingerprint === expected.secretFingerprint
    );
  }

  private scheduleSecretRefresh(providerId: 'openrouter' | 'openai_compatible'): void {
    if (this.secretRefreshTimerId !== null) window.clearTimeout(this.secretRefreshTimerId);
    this.secretRefreshTimerId = window.setTimeout(() => {
      this.secretRefreshTimerId = null;
      void this.refreshAfterSecretChange(providerId);
    }, SECRET_REFRESH_DEBOUNCE_MS);
  }

  private async refreshAfterSecretChange(
    providerId: 'openrouter' | 'openai_compatible',
  ): Promise<void> {
    try {
      while (this.configurationSaves[providerId] !== undefined)
        await this.configurationSaves[providerId];
      if (!this.automaticRequestsAllowed(providerId)) return;
      if (providerId === 'openrouter') {
        const secretId =
          this.dependencies.getSettings().llmProviderConfigurations.openrouter.secretId;
        if (secretId.length === 0 || this.dependencies.getSecret(secretId).length === 0) {
          this.updateProviderView(providerId);
          return;
        }
      }
      const state = this.providers[providerId];
      await this.refreshModels(providerId, true);
      if (
        providerId === 'openrouter' &&
        this.automaticRequestsAllowed(providerId) &&
        this.providers[providerId] === state
      ) {
        await this.refreshProviderHealth(providerId);
      }
    } catch {
      // The setting save reports its own failure; do not probe the old configuration.
    }
  }

  private async refreshProviderHealth(providerId: 'openrouter'): Promise<void> {
    const state = this.providers[providerId];
    const configuration = this.discoveryConfiguration(providerId);
    try {
      const health = await this.createProvider(providerId).probe();
      if (
        this.providers[providerId] === state &&
        this.sameDiscoveryConfiguration(providerId, configuration)
      )
        state.health = health;
    } catch (error) {
      if (
        this.providers[providerId] === state &&
        this.sameDiscoveryConfiguration(providerId, configuration)
      )
        state.health = providerHealthFromError(error);
    }
    this.updateProviderView(providerId);
  }

  private async runConnectionTest(
    providerId: 'openrouter' | 'openai_compatible',
    button: ExtraButtonComponent,
  ): Promise<void> {
    const generation = this.renderGeneration;
    const revision = this.configurationRevisions[providerId];
    if (this.testsInFlight.get(providerId) === generation) return;
    this.testsInFlight.set(providerId, generation);
    button
      .setDisabled(true)
      .setIcon('loader-circle')
      .setTooltip(t('llm.routing.testingConnection'));
    button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testingConnection'));
    button.extraSettingsEl.addClass('local-dictation-connection-test--loading');
    try {
      while (this.configurationSaves[providerId] !== undefined)
        await this.configurationSaves[providerId];
      if (
        this.disposed ||
        this.renderGeneration !== generation ||
        this.configurationRevisions[providerId] !== revision
      )
        return;
      const before = this.dependencies.getSettings().llmProviderConfigurations[providerId];
      const secret = this.dependencies.getSecret(before.secretId);
      const beforeUrl =
        providerId === 'openai_compatible'
          ? this.dependencies.getSettings().llmProviderConfigurations.openai_compatible.baseUrl
          : null;
      const failure = await this.testProvider(providerId);
      const after = this.dependencies.getSettings().llmProviderConfigurations[providerId];
      const afterUrl =
        providerId === 'openai_compatible'
          ? this.dependencies.getSettings().llmProviderConfigurations.openai_compatible.baseUrl
          : null;
      if (
        this.disposed ||
        this.renderGeneration !== generation ||
        this.configurationRevisions[providerId] !== revision ||
        before.model !== after.model ||
        before.secretId !== after.secretId ||
        beforeUrl !== afterUrl ||
        secret !== this.dependencies.getSecret(after.secretId)
      ) {
        if (!this.disposed && this.renderGeneration === generation) {
          button.setIcon('plug-zap').setTooltip(t('llm.routing.testConnection'));
          button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testConnection'));
        }
        return;
      }
      button.setIcon(failure === null ? 'check' : 'x');
      if (failure !== null) {
        button.setTooltip(t('llm.routing.testConnection'));
        button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testConnection'));
        this.dependencies.feedback.show({ intent: 'warning', message: failure });
      } else {
        const message = t('llm.routing.connectionSuccessful');
        button.setTooltip(message);
        button.extraSettingsEl.setAttribute('aria-label', message);
        this.dependencies.feedback.show({ intent: 'success', message });
      }
      window.setTimeout(() => {
        if (
          !this.disposed &&
          this.renderGeneration === generation &&
          this.configurationRevisions[providerId] === revision
        ) {
          button.setIcon('plug-zap').setTooltip(t('llm.routing.testConnection'));
          button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testConnection'));
        }
      }, TEST_RESULT_ICON_MS);
    } catch {
      if (!this.disposed && this.renderGeneration === generation) {
        button.setIcon('x').setTooltip(t('llm.routing.testConnection'));
        button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testConnection'));
        this.dependencies.feedback.show({
          intent: 'warning',
          message: t('llm.routing.settingsSaveFailed'),
        });
      }
    } finally {
      if (this.testsInFlight.get(providerId) === generation) this.testsInFlight.delete(providerId);
      if (!this.disposed && this.renderGeneration === generation) {
        if (this.configurationRevisions[providerId] !== revision) {
          button.setIcon('plug-zap').setTooltip(t('llm.routing.testConnection'));
          button.extraSettingsEl.setAttribute('aria-label', t('llm.routing.testConnection'));
        }
        button.extraSettingsEl.removeClass('local-dictation-connection-test--loading');
        button.setDisabled(false);
      }
    }
  }

  private automaticRequestsAllowed(providerId: LlmProviderId): boolean {
    const settings = this.dependencies.getSettings();
    return (
      !this.disposed &&
      settings.llmFeaturesEnabled &&
      settings.llmPostprocessMode !== 'off' &&
      activeLlmProviderIds(settings.llmRoutingPolicy).includes(providerId)
    );
  }

  private prewarm(model: string): void {
    if (model.length === 0) return;
    const provider = this.createProvider('ollama');
    void provider.prewarmModel?.(model)?.catch((error: unknown) => {
      this.dependencies.logger?.warn(
        'llm',
        `Ollama pre-warm failed (${error instanceof ProviderError ? error.code : 'unknown'}).`,
      );
    });
  }

  private createProvider(
    providerId: LlmProviderId,
    settings = this.dependencies.getSettings(),
  ): ReturnType<typeof createProvider> {
    return createProvider(providerId, {
      configurations: settings.llmProviderConfigurations,
      getSecret: this.dependencies.getSecret,
      networkTimeoutMs: settings.llmNetworkTimeoutSec * 1000,
    });
  }
}

function providerLabel(providerId: LlmProviderId): string {
  switch (providerId) {
    case 'ollama':
      return t('llm.provider.ollama');
    case 'openrouter':
      return t('llm.provider.openrouter');
    case 'openai_compatible':
      return t('llm.provider.custom');
  }
}

function firstOtherProvider(providerId: LlmProviderId): LlmProviderId {
  return LLM_PROVIDER_IDS.find((candidate) => candidate !== providerId) ?? 'ollama';
}

function shouldForceLocalCatalogRefresh(
  providerId: LlmProviderId,
  settings: PluginSettings,
): boolean {
  if (providerId === 'ollama') return true;
  if (providerId !== 'openai_compatible') return false;

  const validation = validateOpenAiCompatibleBaseUrl(
    settings.llmProviderConfigurations.openai_compatible.baseUrl,
  );
  return validation.valid && isLoopbackHostname(new URL(validation.normalizedUrl).hostname);
}

function readinessMessage(issue: {
  code: string;
  message?: string;
  providerId?: LlmProviderId;
}): string {
  switch (issue.code) {
    case 'provider_missing':
      return t('llm.readiness.chooseProvider');
    case 'model_missing':
      return t('llm.readiness.chooseModel', {
        provider: formatLlmProviderName(issue.providerId ?? 'ollama'),
      });
    case 'api_key_missing':
      return t('llm.readiness.apiKeyMissing');
    case 'base_url_invalid':
      return t('llm.readiness.baseUrlInvalid');
    default:
      return t('llm.readiness.routingInvalid');
  }
}

function customUrlValidationMessage(
  code: Exclude<ReturnType<typeof validateOpenAiCompatibleBaseUrl>, { valid: true }>['code'],
): string {
  switch (code) {
    case 'empty':
      return t('llm.validation.baseUrl.empty');
    case 'not_absolute':
      return t('llm.validation.baseUrl.absolute');
    case 'scheme':
      return t('llm.validation.baseUrl.scheme');
    case 'credentials':
      return t('llm.validation.baseUrl.credentials');
    case 'query_or_fragment':
      return t('llm.validation.baseUrl.queryOrFragment');
  }
}
