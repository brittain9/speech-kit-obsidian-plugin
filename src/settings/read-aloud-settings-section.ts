import type { SliderComponent } from 'obsidian';
import { Setting } from 'obsidian';

import {
  DICTATION_LANGUAGE_OPTIONS,
  type DictationLanguage,
  dictationLanguageLabel,
} from '../language/dictation-language';
import type { ModelPickerOptions } from '../models/manage-models-modal';
import type { ModelInstallManager, ModelManagerState } from '../models/model-install-manager';
import { matchesModelTriple } from '../models/model-management-types';
import { formatVoiceLabel } from '../shared/format-utils';
import { t } from '../shared/i18n';
import { resolveReadAloudVoiceId } from '../tts/read-aloud-selection';
import { renderModelSummaryRow } from './model-summary-row';
import { MAX_TTS_SPEED, MIN_TTS_SPEED, type PluginSettings } from './plugin-settings';
import { captureSettingsFocus, restoreSettingsFocus } from './settings-tab-lifecycle';

interface ReadAloudSettingsSectionDependencies {
  getSettings: () => PluginSettings;
  manager: ModelInstallManager;
  openSelectedModelDetails: () => void;
  openModelPicker: (options?: ModelPickerOptions) => Promise<void>;
  persistLanguage: (language: DictationLanguage) => Promise<void>;
  persistVoice: (voice: string | null) => Promise<void>;
}

export function configureReadAloudSpeedSlider(
  slider: SliderComponent,
  speed: number,
  persistSpeed: (speed: number) => Promise<void>,
): void {
  slider.setLimits(MIN_TTS_SPEED, MAX_TTS_SPEED, 0.05).setValue(speed);

  // Obsidian 1.13 shows values inline, but supported 1.11/1.12 hosts need this tooltip.
  const legacyTooltipSlider: { setDynamicTooltip(): SliderComponent } = slider;
  legacyTooltipSlider.setDynamicTooltip().onChange(persistSpeed);
}

export function readAloudControlsFingerprint(
  state: Pick<ModelManagerState, 'catalog' | 'installedModels' | 'selectedTtsModel' | 'loadStatus'>,
): string {
  const selection = state.selectedTtsModel;
  if (selection?.kind !== 'catalog_model') {
    return `${state.catalog.catalogVersion}:none`;
  }
  const catalogModel = state.catalog.models.find((model) =>
    matchesModelTriple(model, selection.runtimeId, selection.familyId, selection.modelId),
  );
  const installed = state.installedModels.find((model) =>
    matchesModelTriple(model, selection.runtimeId, selection.familyId, selection.modelId),
  );
  return [
    state.catalog.catalogVersion,
    selection.runtimeId,
    selection.familyId,
    selection.modelId,
    catalogModel === undefined ? 'unresolved' : 'resolved',
    state.loadStatus,
    installed === undefined ? 'missing' : 'installed',
    ...(installed?.installedVoiceIds ?? []),
  ].join(':');
}

export function renderTextToSpeechSettings(
  modelContainer: HTMLDivElement,
  readAloudContainer: HTMLDivElement,
  readAloudBefore: HTMLElement,
  dependencies: ReadAloudSettingsSectionDependencies,
): () => void {
  let fingerprint = readAloudControlsFingerprint(dependencies.manager.getState());
  let languageSettingEl: HTMLElement | null = null;
  let voiceSettingEl: HTMLElement | null = null;

  const render = (): void => {
    const focus = captureSettingsFocus(modelContainer);
    modelContainer.empty();
    if (languageSettingEl !== null) readAloudContainer.removeChild(languageSettingEl);
    if (voiceSettingEl !== null) readAloudContainer.removeChild(voiceSettingEl);
    const settings = dependencies.getSettings();
    const state = dependencies.manager.getState();
    const selection = settings.selectedTtsModel;
    const catalogModel =
      selection?.kind === 'catalog_model'
        ? (state.catalog.models.find((model) =>
            matchesModelTriple(model, selection.runtimeId, selection.familyId, selection.modelId),
          ) ?? null)
        : null;

    const installed =
      catalogModel === null
        ? null
        : (state.installedModels.find((model) =>
            matchesModelTriple(
              model,
              catalogModel.runtimeId,
              catalogModel.familyId,
              catalogModel.modelId,
            ),
          ) ?? null);
    const status =
      selection === null
        ? { modifier: 'neutral' as const, text: t('settings.model.noModelSelected') }
        : installed !== null
          ? { modifier: 'ready' as const, text: t('models.current.installed') }
          : state.loadStatus === 'ready'
            ? { modifier: 'missing' as const, text: t('settings.model.notInstalled') }
            : state.loadStatus === 'error'
              ? { modifier: 'neutral' as const, text: t('settings.model.unavailable') }
              : { modifier: 'neutral' as const, text: t('settings.model.checking') };
    renderModelSummaryRow(modelContainer, {
      taskLabel: t('settings.model.task.tts'),
      modelName:
        catalogModel?.displayName ??
        (selection?.kind === 'catalog_model'
          ? selection.modelId
          : t('settings.model.noModelSelected')),
      icon: 'volume-2',
      streaming: false,
      status,
      onOpen: () => {
        void dependencies.openModelPicker({ initialTask: 'tts' });
      },
      actions:
        catalogModel === null
          ? []
          : [
              {
                label: t('settings.model.details'),
                onSelect: dependencies.openSelectedModelDetails,
              },
            ],
    });
    restoreSettingsFocus(modelContainer, focus);
    const installedVoices = installed?.installedVoiceIds ?? [];
    const languageSetting = new Setting(readAloudContainer)
      .setName(t('settings.readAloud.language'))
      .setDesc(t('settings.readAloud.languageDesc'))
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', t('settings.readAloud.modelDefault'));
        if (catalogModel !== null) {
          for (const option of DICTATION_LANGUAGE_OPTIONS) {
            if (option.value === 'auto' || !catalogModel.languageTags.includes(option.value)) {
              continue;
            }
            dropdown.addOption(option.value, dictationLanguageLabel(option.value));
          }
          if (
            settings.readAloudLanguage !== 'auto' &&
            !catalogModel.languageTags.includes(settings.readAloudLanguage)
          ) {
            dropdown.addOption(
              settings.readAloudLanguage,
              t('settings.dictationLanguage.unsupported', {
                language: dictationLanguageLabel(settings.readAloudLanguage),
              }),
            );
          }
        }
        dropdown.setValue(settings.readAloudLanguage);
        dropdown.setDisabled(catalogModel === null);
        dropdown.onChange(async (language) => {
          const option = DICTATION_LANGUAGE_OPTIONS.find(({ value }) => value === language);
          if (option === undefined) return;
          await dependencies.persistLanguage(option.value);
        });
      });
    languageSettingEl = languageSetting.settingEl;
    readAloudContainer.insertBefore(languageSettingEl, readAloudBefore);

    const voiceSetting = new Setting(readAloudContainer)
      .setName(t('settings.readAloud.voice'))
      .setDesc(t('settings.readAloud.voiceDesc'))
      .addDropdown((dropdown) => {
        if (installedVoices.length === 0) {
          dropdown.addOption('', t('settings.readAloud.noVoices'));
        }
        for (const voice of installedVoices) {
          dropdown.addOption(voice, formatVoiceLabel(voice));
        }
        dropdown.setValue(
          resolveReadAloudVoiceId(settings.selectedTtsVoice, catalogModel?.defaultVoice) ?? '',
        );
        dropdown.setDisabled(installedVoices.length === 0);
        dropdown.onChange(async (voice) => {
          await dependencies.persistVoice(voice.length === 0 ? null : voice);
        });
      });
    voiceSettingEl = voiceSetting.settingEl;
    readAloudContainer.insertBefore(voiceSettingEl, readAloudBefore);
  };

  render();
  return dependencies.manager.subscribe(() => {
    const nextFingerprint = readAloudControlsFingerprint(dependencies.manager.getState());
    if (nextFingerprint === fingerprint) return;
    fingerprint = nextFingerprint;
    render();
  });
}
