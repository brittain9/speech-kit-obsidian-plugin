import { Setting } from 'obsidian';

import type { ModelPickerOptions } from '../models/manage-models-modal';
import type { ModelInstallManager, ModelManagerState } from '../models/model-install-manager';
import { type CatalogModelRecord, matchesModelTriple } from '../models/model-management-types';
import { t } from '../shared/i18n';
import {
  isSupportedTranslationPair,
  isTranslationLanguage,
  resolveTranslationLanguages,
  resolveTranslationTarget,
  type TranslationLanguage,
  translationLanguageLabel,
  translationSourcesFor,
  translationTargetsFor,
} from '../translation/languages';
import { renderModelSummaryRow } from './model-summary-row';
import {
  isTranslationStyle,
  normalizeTranslationStyle,
  normalizeTranslationStyleInstruction,
  type PluginSettings,
  TRANSLATION_STYLE_INSTRUCTION_MAX_CHARS,
  type TranslationStyle,
} from './plugin-settings';
import { addTextAreaSetting } from './setting-helpers';
import { captureSettingsFocus, restoreSettingsFocus } from './settings-tab-lifecycle';

export interface TranslationSettingsDependencies {
  getSettings: () => PluginSettings;
  manager: ModelInstallManager;
  openModelPicker: (options?: ModelPickerOptions) => Promise<void>;
  openSelectedModelDetails?: () => void;
  persistLanguages: (
    sourceLanguage: TranslationLanguage,
    targetLanguage: TranslationLanguage,
  ) => Promise<void>;
  persistStyle?: (style: TranslationStyle, instruction: string) => Promise<void>;
}

export function translationSettingsFingerprint(
  state: Pick<
    ModelManagerState,
    'catalog' | 'installedModels' | 'selectedTranslationModel' | 'loadStatus'
  >,
): string {
  const models = translationModels(state);
  const installed = models.filter((model) =>
    state.installedModels.some((candidate) =>
      matchesModelTriple(candidate, model.runtimeId, model.familyId, model.modelId),
    ),
  );
  const selected = state.selectedTranslationModel;
  return [
    state.catalog.catalogVersion,
    state.loadStatus,
    ...models.map((model) => model.modelId),
    '|',
    ...installed.map((model) => model.modelId),
    '|',
    selected?.runtimeId ?? '',
    selected?.familyId ?? '',
    selected?.kind === 'catalog_model' ? selected.modelId : '',
  ].join(':');
}

export function renderTranslationSettings(
  container: HTMLDivElement,
  dependencies: TranslationSettingsDependencies,
): () => void {
  let disposed = false;
  let fingerprint = translationSettingsFingerprint(dependencies.manager.getState());

  const render = (): void => {
    if (disposed) return;
    container.empty();
    const state = dependencies.manager.getState();
    const selectedModel = selectedTranslationCatalogModel(state);

    const settings = dependencies.getSettings();
    const pair = resolveTranslationLanguages(
      settings.dictationLanguage,
      settings.translationSourceLanguage,
      settings.translationTargetLanguage,
      selectedModel,
    );

    new Setting(container)
      .setName(t('settings.translation.source.name'))
      .setDesc(t('settings.translation.source.desc'))
      .addDropdown((dropdown) => {
        for (const language of translationSourcesFor(selectedModel)) {
          dropdown.addOption(language, translationLanguageLabel(language));
        }
        dropdown.setValue(pair.sourceLanguage);
        dropdown.onChange(async (value) => {
          if (!isTranslationLanguage(value)) return;
          if (!translationSourcesFor(selectedModel).includes(value)) return;
          const targetLanguage = resolveTranslationTarget(
            value,
            pair.targetLanguage,
            selectedModel,
          );
          await dependencies.persistLanguages(value, targetLanguage);
          render();
        });
      });

    new Setting(container)
      .setName(t('settings.translation.target.name'))
      .setDesc(t('settings.translation.target.desc'))
      .addDropdown((dropdown) => {
        for (const language of translationTargetsFor(pair.sourceLanguage, selectedModel)) {
          dropdown.addOption(language, translationLanguageLabel(language));
        }
        dropdown.setValue(pair.targetLanguage);
        dropdown.onChange(async (value) => {
          if (!isTranslationLanguage(value)) return;
          if (!isSupportedTranslationPair(pair.sourceLanguage, value, selectedModel)) return;
          await dependencies.persistLanguages(pair.sourceLanguage, value);
          render();
        });
      });

    if (selectedModel?.familyId === 'tencent_hy_mt') {
      new Setting(container)
        .setName(t('settings.translation.style.name'))
        .setDesc(t('settings.translation.style.desc'))
        .addDropdown((dropdown) => {
          dropdown
            .addOption('default', t('settings.translation.style.default'))
            .addOption('formal', t('settings.translation.style.formal'))
            .addOption('casual', t('settings.translation.style.casual'))
            .addOption('custom', t('settings.translation.style.custom'))
            .setValue(settings.translationStyle)
            .onChange(async (value) => {
              if (!isTranslationStyle(value)) return;
              await dependencies.persistStyle?.(
                value,
                dependencies.getSettings().translationStyleInstruction,
              );
              render();
            });
        });

      if (settings.translationStyle === 'custom') {
        addTextAreaSetting(container, {
          name: t('settings.translation.styleInstruction.name'),
          desc: t('settings.translation.styleInstruction.desc'),
          rows: 3,
          value: settings.translationStyleInstruction,
          onElement: (element) => {
            element.maxLength = TRANSLATION_STYLE_INSTRUCTION_MAX_CHARS;
          },
          onChange: (value) => {
            void dependencies.persistStyle?.(
              normalizeTranslationStyle(dependencies.getSettings().translationStyle),
              normalizeTranslationStyleInstruction(value),
            );
          },
        });
      }
    }
  };

  render();
  const unsubscribe = dependencies.manager.subscribe(() => {
    const nextFingerprint = translationSettingsFingerprint(dependencies.manager.getState());
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;
    render();
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}

/** Renders the active translation model in the shared Models settings group. */
export function renderTranslationModelSetting(
  container: HTMLDivElement,
  dependencies: TranslationSettingsDependencies,
): () => void {
  let disposed = false;
  let fingerprint = translationSettingsFingerprint(dependencies.manager.getState());

  const render = (): void => {
    if (disposed) return;
    const focus = captureSettingsFocus(container);
    container.empty();
    const state = dependencies.manager.getState();
    const selectedModel = selectedTranslationCatalogModel(state);
    const installedRecord =
      selectedModel === null
        ? null
        : (state.installedModels.find((candidate) =>
            matchesModelTriple(
              candidate,
              selectedModel.runtimeId,
              selectedModel.familyId,
              selectedModel.modelId,
            ),
          ) ?? null);

    const selection = state.selectedTranslationModel;
    const status =
      selection === null || installedRecord !== null
        ? null
        : state.loadStatus === 'ready'
          ? { modifier: 'missing', text: t('settings.model.notInstalled') }
          : state.loadStatus === 'error'
            ? { modifier: 'unavailable', text: t('settings.model.unavailable') }
            : { modifier: 'checking', text: t('settings.model.checking') };
    renderModelSummaryRow(container, {
      taskLabel: t('settings.model.task.translation'),
      modelName:
        selectedModel?.displayName ??
        (selection?.kind === 'catalog_model'
          ? selection.modelId
          : t('settings.translation.model.unavailable')),
      icon: 'languages',
      streaming: false,
      status,
      onOpen: () => {
        void dependencies.openModelPicker({ initialTask: 'translation' });
      },
      actions:
        selectedModel !== null && dependencies.openSelectedModelDetails !== undefined
          ? [
              {
                label: t('settings.model.details'),
                onSelect: dependencies.openSelectedModelDetails,
              },
            ]
          : [],
    });
    restoreSettingsFocus(container, focus);
  };

  render();
  const unsubscribe = dependencies.manager.subscribe(() => {
    const nextFingerprint = translationSettingsFingerprint(dependencies.manager.getState());
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;
    render();
  });
  return () => {
    disposed = true;
    unsubscribe();
  };
}

function translationModels(state: Pick<ModelManagerState, 'catalog'>): CatalogModelRecord[] {
  return state.catalog.models.filter((model) => model.task === 'translation');
}

function selectedTranslationCatalogModel(
  state: Pick<ModelManagerState, 'catalog' | 'selectedTranslationModel'>,
): CatalogModelRecord | null {
  const selected = state.selectedTranslationModel;
  if (selected?.kind !== 'catalog_model') return null;
  return (
    state.catalog.models.find(
      (model) =>
        model.task === 'translation' &&
        matchesModelTriple(model, selected.runtimeId, selected.familyId, selected.modelId),
    ) ?? null
  );
}
