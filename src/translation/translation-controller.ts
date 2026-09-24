import type { App, Editor, EditorPosition } from 'obsidian';
import type { ModelInstallManager } from '../models/model-install-manager';
import { type CatalogModelRecord, matchesModelTriple } from '../models/model-management-types';
import {
  normalizeTranslationStyleInstruction,
  type PluginSettings,
  resolveTranslationStyleInstruction,
  type TranslationStyle,
} from '../settings/plugin-settings';
import { t } from '../shared/i18n';
import type { PluginLogger } from '../shared/plugin-logger';
import type { UserFeedback } from '../shared/user-feedback';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import { TranslationCancelledError, translateWithBergamot } from './bergamot-client';
import { translateWithHyMt } from './hy-mt-client';
import {
  findInstalledTranslationModel,
  type InstalledTranslationModel,
  resolveTranslationLanguages,
  type TranslationLanguage,
} from './languages';
import {
  protectedMarkerModeForTranslation,
  rebuildTranslatedMarkdown,
  segmentMarkdownForTranslation,
  translatableTexts,
} from './markdown-segmentation';
import {
  TranslationJob,
  type TranslationJobResult,
  type TranslationJobRunOptions,
  type TranslationJobState,
} from './translation-job';
import { TranslationModal, type TranslationSnapshot } from './translation-modal';
import { translationInstallRequirement } from './translation-packs';

const MAX_TRANSLATION_CHARACTERS = 50_000;

interface TranslationAdapterContext {
  installed: InstalledTranslationModel;
  model: CatalogModelRecord;
  options: TranslationJobRunOptions;
  settings: PluginSettings;
  sidecarConnection:
    | Pick<SidecarConnection, 'cancelTranslation' | 'startTranslation' | 'subscribe'>
    | undefined;
  sourceLanguage: TranslationLanguage;
  styleInstruction?: string;
  targetLanguage: TranslationLanguage;
  texts: string[];
}

type TranslationAdapter = (context: TranslationAdapterContext) => Promise<string[]>;

const TRANSLATION_ADAPTERS: Readonly<Record<string, TranslationAdapter>> = {
  'bergamot_wasm:firefox_translations': ({
    installed,
    options,
    sourceLanguage,
    targetLanguage,
    texts,
  }) =>
    translateWithBergamot({
      ...installed,
      ...options,
      sourceLanguage,
      targetLanguage,
      texts,
    }),
  'llama_cpp:tencent_hy_mt': ({
    model,
    options,
    settings,
    sidecarConnection,
    sourceLanguage,
    styleInstruction,
    targetLanguage,
    texts,
  }) => {
    if (sidecarConnection === undefined)
      throw new Error('This translation model requires the native sidecar.');
    return translateWithHyMt({
      accelerationPreference: settings.accelerationPreference,
      modelSelection: {
        kind: 'catalog_model',
        runtimeId: model.runtimeId,
        familyId: model.familyId,
        modelId: model.modelId,
      },
      ...(settings.modelStorePathOverride === ''
        ? {}
        : { modelStorePathOverride: settings.modelStorePathOverride }),
      ...options,
      sidecarConnection,
      sourceLanguage,
      ...(styleInstruction === undefined ? {} : { styleInstruction }),
      targetLanguage,
      texts,
      translationId: createTranslationId(),
    });
  },
};

interface TranslationControllerDependencies {
  app: App;
  canReadAloud: (text: string, language: TranslationLanguage) => boolean;
  feedback: Pick<UserFeedback, 'show'>;
  getSettings: () => PluginSettings;
  logger: PluginLogger;
  modelManager: ModelInstallManager;
  onReadAloud: (text: string, language: TranslationLanguage) => Promise<void> | void;
  saveSettings: (settings: PluginSettings) => Promise<void>;
  sidecarConnection?: Pick<
    SidecarConnection,
    'cancelTranslation' | 'startTranslation' | 'subscribe'
  >;
  setDetachedStatus?: (state: TranslationJobState | null, reopen: () => void) => void;
}
interface ActiveTranslation {
  configuration: TranslationConfiguration;
  configurationListeners: Set<() => void>;
  editor: Editor;
  job: TranslationJob;
  modelSelectionGeneration: number;
  modelSelectionPendingGeneration: number | null;
  modelSelectionTarget: CatalogModelRecord | null;
  release: () => void;
  snapshot: TranslationSnapshot;
}
interface TranslationConfiguration {
  model: CatalogModelRecord | null;
  sourceLanguage: TranslationLanguage;
  styleInstruction: string;
  targetLanguage: TranslationLanguage;
}

export class TranslationController {
  private active: ActiveTranslation | null = null;
  private activeModal: TranslationModal | null = null;
  constructor(private readonly dependencies: TranslationControllerDependencies) {}

  translateSelection(editor: Editor): void {
    if (this.reopenActive() || !editor.somethingSelected()) return;
    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    this.begin(editor, { from, kind: 'selection', source: editor.getRange(from, to), to });
  }
  translateNote(editor: Editor): void {
    if (this.reopenActive()) return;
    const source = editor.getValue();
    if (source.trim().length === 0) {
      this.dependencies.feedback.show({
        intent: 'warning',
        key: 'translation-no-text',
        message: t('translation.notice.noText'),
      });
      return;
    }
    this.begin(editor, { from: { line: 0, ch: 0 }, kind: 'note', source, to: endPosition(source) });
  }
  dispose(): void {
    this.active?.job.cancel();
    this.activeModal?.close();
    this.clearActive();
  }

  private reopenActive(): boolean {
    if (this.active === null) return false;
    this.openModal();
    return true;
  }
  private begin(
    editor: Editor,
    snapshot: TranslationSnapshot,
    sourceOverride?: TranslationLanguage,
    targetOverride?: TranslationLanguage,
    styleInstructionOverride?: string,
  ): void {
    if (snapshot.source.length > MAX_TRANSLATION_CHARACTERS) {
      this.dependencies.feedback.show({
        intent: 'warning',
        key: 'translation-too-long',
        message: t('translation.notice.tooLong', {
          count: MAX_TRANSLATION_CHARACTERS.toLocaleString(),
        }),
      });
      return;
    }
    this.clearActive();
    const settings = this.dependencies.getSettings();
    const model = selectedTranslationModel(this.dependencies.modelManager.getState(), settings);
    const styleInstruction = normalizeTranslationStyleInstruction(
      styleInstructionOverride ??
        resolveTranslationStyleInstruction(
          settings.translationStyle,
          settings.translationStyleInstruction,
        ),
    );
    const resolved = resolveTranslationLanguages(
      settings.dictationLanguage,
      sourceOverride ?? settings.translationSourceLanguage,
      targetOverride ?? settings.translationTargetLanguage,
      model,
    );
    const { sourceLanguage, targetLanguage } = resolved;
    const job = new TranslationJob({
      model,
      sourceLanguage,
      targetLanguage,
      run: (options) =>
        this.runTranslation(
          snapshot.source,
          model,
          sourceLanguage,
          targetLanguage,
          styleInstruction,
          options,
        ),
    });
    const active: ActiveTranslation = {
      configuration: { model, sourceLanguage, styleInstruction, targetLanguage },
      configurationListeners: new Set(),
      editor,
      job,
      modelSelectionGeneration: 0,
      modelSelectionPendingGeneration: null,
      modelSelectionTarget: null,
      release: () => {},
      snapshot,
    };
    const releaseJob = job.subscribe((state) => {
      if (this.active !== active) return;
      if (this.activeModal === null)
        this.dependencies.setDetachedStatus?.(state, () => this.openModal());
    });
    const releaseModelManager = this.dependencies.modelManager.subscribe(() => {
      this.reconcilePersistedModelSelection(active);
    });
    active.release = () => {
      releaseJob();
      releaseModelManager();
    };
    this.active = active;
    this.openModal();
    job.start();
  }
  private isCurrentModelSelection(active: ActiveTranslation, generation: number): boolean {
    return this.active === active && active.modelSelectionGeneration === generation;
  }

  private notifyConfiguration(active: ActiveTranslation): void {
    for (const listener of active.configurationListeners) listener();
  }

  private reconcilePersistedModelSelection(active: ActiveTranslation, force = false): void {
    if (this.active !== active) return;
    const model = selectedTranslationModel(
      this.dependencies.modelManager.getState(),
      this.dependencies.getSettings(),
    );
    if (
      model === null ||
      sameTranslationModel(model, active.configuration.model) ||
      (!force && sameTranslationModel(model, active.modelSelectionTarget))
    )
      return;
    ++active.modelSelectionGeneration;
    const { sourceLanguage, targetLanguage } = resolveTranslationLanguages(
      this.dependencies.getSettings().dictationLanguage,
      active.configuration.sourceLanguage,
      active.configuration.targetLanguage,
      model,
    );
    Object.assign(active.configuration, { model, sourceLanguage, targetLanguage });
    this.notifyConfiguration(active);
  }

  private finishModelSelection(active: ActiveTranslation, generation: number): boolean {
    if (this.active !== active || active.modelSelectionPendingGeneration !== generation)
      return false;
    active.modelSelectionPendingGeneration = null;
    active.modelSelectionTarget = null;
    return true;
  }

  private openModal(): void {
    const active = this.active;
    if (active === null || this.activeModal !== null) return;
    this.dependencies.setDetachedStatus?.(null, () => {});
    const modal = new TranslationModal(this.dependencies.app, {
      canReadAloud: this.dependencies.canReadAloud,
      editor: active.editor,
      feedback: this.dependencies.feedback,
      job: active.job,
      configuration: active.configuration,
      modelManager: this.dependencies.modelManager,
      getModelSelectionState: () => ({
        generation: active.modelSelectionGeneration,
        pendingGeneration: active.modelSelectionPendingGeneration,
      }),
      isModelSelectionPending: () => active.modelSelectionPendingGeneration !== null,
      snapshot: active.snapshot,
      onApplied: () => this.clearActive(),
      onDismissed: () => this.clearActive(),
      subscribeConfiguration: (listener) => {
        active.configurationListeners.add(listener);
        return () => {
          active.configurationListeners.delete(listener);
        };
      },
      onClosed: () => {
        if (this.activeModal === modal) {
          this.activeModal = null;
          if (this.active === active)
            this.dependencies.setDetachedStatus?.(active.job.state(), () => this.openModal());
        }
      },
      onLanguageChange: (sourceLanguage, targetLanguage) => {
        Object.assign(active.configuration, { sourceLanguage, targetLanguage });
        this.notifyConfiguration(active);
        return this.persistTranslationLanguages(sourceLanguage, targetLanguage);
      },
      onModelChange: async (model, sourceLanguage, targetLanguage) => {
        const generation = ++active.modelSelectionGeneration;
        active.modelSelectionPendingGeneration = generation;
        active.modelSelectionTarget = model;
        this.notifyConfiguration(active);
        try {
          const result = this.modelIsInstalled(model)
            ? await this.dependencies.modelManager.select({
                familyId: model.familyId,
                kind: 'catalog_model',
                modelId: model.modelId,
                runtimeId: model.runtimeId,
              })
            : null;
          if (!this.isCurrentModelSelection(active, generation)) {
            this.reconcilePersistedModelSelection(active, true);
            if (this.finishModelSelection(active, generation)) this.notifyConfiguration(active);
            return false;
          }
          if (result?.committed === false) {
            this.reconcilePersistedModelSelection(active, true);
            this.finishModelSelection(active, generation);
            this.notifyConfiguration(active);
            return false;
          }
          Object.assign(active.configuration, { model, sourceLanguage, targetLanguage });
          this.finishModelSelection(active, generation);
          this.notifyConfiguration(active);
          return true;
        } catch (error) {
          this.reconcilePersistedModelSelection(active, true);
          if (this.finishModelSelection(active, generation)) this.notifyConfiguration(active);
          throw error;
        }
      },
      onCancelPackInstall: () => this.dependencies.modelManager.cancel(),
      onInstallPack: async (model, sourceLanguage, targetLanguage) => {
        const requirement = this.installRequirement(model, sourceLanguage, targetLanguage);
        if (requirement.kind !== 'pack') {
          throw new Error('This translation direction does not have a downloadable pack.');
        }
        const selection = {
          familyId: model.familyId,
          kind: 'catalog_model' as const,
          modelId: model.modelId,
          runtimeId: model.runtimeId,
        };
        const generation = ++active.modelSelectionGeneration;
        active.modelSelectionPendingGeneration = generation;
        active.modelSelectionTarget = model;
        this.notifyConfiguration(active);
        try {
          await this.dependencies.modelManager.installAndWait(selection, requirement.artifactIds);
          if (!this.isCurrentModelSelection(active, generation)) {
            if (this.finishModelSelection(active, generation)) this.notifyConfiguration(active);
            return false;
          }
          const result = await this.dependencies.modelManager.select(selection);
          const current = this.isCurrentModelSelection(active, generation);
          const finished = this.finishModelSelection(active, generation);
          if (!current || !result.committed) {
            this.reconcilePersistedModelSelection(active, true);
            if (finished) this.notifyConfiguration(active);
            return false;
          }
          Object.assign(active.configuration, { model, sourceLanguage, targetLanguage });
          this.notifyConfiguration(active);
          return true;
        } catch (error) {
          this.reconcilePersistedModelSelection(active, true);
          if (this.finishModelSelection(active, generation)) this.notifyConfiguration(active);
          throw error;
        }
      },
      translationInstallRequirement: (model, sourceLanguage, targetLanguage) =>
        this.installRequirement(model, sourceLanguage, targetLanguage),
      onReadAloud: this.dependencies.onReadAloud,
      getStyle: () => this.dependencies.getSettings().translationStyle,
      getStyleInstruction: () => this.dependencies.getSettings().translationStyleInstruction,
      onStyleChange: (style, instruction) => this.persistTranslationStyle(style, instruction),
      onTranslateCurrent: (sourceLanguage, targetLanguage, styleInstruction) => {
        if (active.modelSelectionPendingGeneration !== null) return;
        this.begin(
          active.editor,
          this.snapshotFromCurrentEditor(active),
          sourceLanguage,
          targetLanguage,
          styleInstruction,
        );
      },
      onRestart: (source, target, styleInstruction) => {
        if (active.modelSelectionPendingGeneration !== null) return;
        void this.persistTranslationLanguages(source, target);
        this.begin(
          active.editor,
          this.snapshotFromCurrentEditor(active),
          source,
          target,
          styleInstruction,
        );
      },
    });
    this.activeModal = modal;
    modal.open();
  }
  private clearActive(): void {
    const active = this.active;
    this.active = null;
    active?.configurationListeners.clear();
    active?.release();
    this.dependencies.setDetachedStatus?.(null, () => {});
  }
  private persistTranslationLanguages(
    sourceLanguage: TranslationLanguage,
    targetLanguage: TranslationLanguage,
  ): Promise<void> {
    return this.dependencies.saveSettings({
      ...this.dependencies.getSettings(),
      translationSourceLanguage: sourceLanguage,
      translationTargetLanguage: targetLanguage,
    });
  }
  private persistTranslationStyle(
    translationStyle: TranslationStyle,
    translationStyleInstruction: string,
  ): Promise<void> {
    return this.dependencies.saveSettings({
      ...this.dependencies.getSettings(),
      translationStyle,
      translationStyleInstruction: normalizeTranslationStyleInstruction(
        translationStyleInstruction,
      ),
    });
  }
  private snapshotFromCurrentEditor(active: ActiveTranslation): TranslationSnapshot {
    const source =
      active.snapshot.kind === 'note'
        ? active.editor.getValue()
        : active.editor.getRange(active.snapshot.from, active.snapshot.to);
    return {
      ...active.snapshot,
      source,
      ...(active.snapshot.kind === 'note' ? { to: endPosition(source) } : {}),
    };
  }
  private modelIsInstalled(model: CatalogModelRecord): boolean {
    return this.dependencies.modelManager
      .getState()
      .installedModels.some((installed) =>
        matchesModelTriple(installed, model.runtimeId, model.familyId, model.modelId),
      );
  }
  private installRequirement(
    model: CatalogModelRecord,
    sourceLanguage: TranslationLanguage,
    targetLanguage: TranslationLanguage,
  ) {
    const installed =
      this.dependencies.modelManager
        .getState()
        .installedModels.find((candidate) =>
          matchesModelTriple(candidate, model.runtimeId, model.familyId, model.modelId),
        ) ?? null;
    return translationInstallRequirement(model, installed, sourceLanguage, targetLanguage);
  }
  private async runTranslation(
    source: string,
    model: CatalogModelRecord | null,
    sourceLanguage: TranslationLanguage,
    targetLanguage: TranslationLanguage,
    styleInstruction: string,
    options: TranslationJobRunOptions,
  ): Promise<TranslationJobResult> {
    if (model === null) return { kind: 'missing_model' };
    const state = this.dependencies.modelManager.getState();
    const installed = findInstalledTranslationModel(
      { models: state.catalog.models, installedModels: state.installedModels },
      sourceLanguage,
      targetLanguage,
      model,
    );
    if (installed === null) return { kind: 'missing_model' };
    const segments = segmentMarkdownForTranslation(source, {
      protectedMarkerMode: protectedMarkerModeForTranslation(
        model.familyId,
        sourceLanguage,
        targetLanguage,
      ),
    });
    const texts = translatableTexts(segments);
    if (texts.length === 0) return { kind: 'translated', sourceUnitsKept: 0, text: source };
    try {
      const adapter = TRANSLATION_ADAPTERS[`${model.runtimeId}:${model.familyId}`];
      if (adapter === undefined)
        throw new Error(`No translation adapter is available for ${model.modelId}.`);
      const translations = await adapter({
        installed,
        model,
        options,
        settings: this.dependencies.getSettings(),
        sidecarConnection: this.dependencies.sidecarConnection,
        sourceLanguage,
        ...(model.familyId === 'tencent_hy_mt' && styleInstruction.length > 0
          ? { styleInstruction }
          : {}),
        targetLanguage,
        texts,
      });
      const rebuilt = rebuildTranslatedMarkdown(segments, translations);
      if (rebuilt.sourceUnitsKept > 0)
        this.dependencies.logger.warn(
          'translation',
          `kept ${rebuilt.sourceUnitsKept} unit(s) in the source language after structure validation`,
        );
      return { kind: 'translated', ...rebuilt };
    } catch (error) {
      if (
        !(error instanceof TranslationCancelledError) &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        this.dependencies.logger.error('translation', 'local translation failed', error);
      throw error;
    }
  }
}

function selectedTranslationModel(
  state: ReturnType<ModelInstallManager['getState']>,
  settings: PluginSettings,
): CatalogModelRecord | null {
  const selection = state.selectedTranslationModel ?? settings.selectedTranslationModel;
  if (selection?.kind !== 'catalog_model') return null;
  return (
    state.catalog.models.find(
      (model) =>
        model.task === 'translation' &&
        model.runtimeId === selection.runtimeId &&
        model.familyId === selection.familyId &&
        model.modelId === selection.modelId,
    ) ?? null
  );
}
function sameTranslationModel(
  left: CatalogModelRecord | null,
  right: CatalogModelRecord | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      matchesModelTriple(right, left.runtimeId, left.familyId, left.modelId))
  );
}

function createTranslationId(): string {
  return (
    window.crypto?.randomUUID?.() ??
    `translation-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
function endPosition(text: string): EditorPosition {
  const lines = text.split('\n');
  return { line: lines.length - 1, ch: lines.at(-1)?.length ?? 0 };
}
