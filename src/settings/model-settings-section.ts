import { isCancellingPhase, type ModelInstallManager } from '../models/model-install-manager';
import { updateInstallProgressElement } from '../models/model-install-progress';
import { type CurrentModelStatus, deriveCurrentModelDisplay } from '../models/model-row-state';
import { t } from '../shared/i18n';
import { renderActiveInstallCard } from './install-progress-row';
import { renderModelSummaryRow } from './model-summary-row';
import { captureSettingsFocus, restoreSettingsFocus } from './settings-tab-lifecycle';

// ---------------------------------------------------------------------------
// Map model status to a localized availability indicator.
// ---------------------------------------------------------------------------

function getModelStatusIndicator(status: CurrentModelStatus): {
  modifier: 'ready' | 'missing' | 'neutral';
  text: string;
} {
  switch (status) {
    case 'installed':
      return { modifier: 'ready', text: t('models.current.installed') };
    case 'not_installed':
      return { modifier: 'missing', text: t('settings.model.notInstalled') };
    case 'external_validated':
      return { modifier: 'ready', text: t('settings.model.validatedExternal') };
    case 'external_file':
      return { modifier: 'neutral', text: t('settings.model.external') };
    case 'checking':
      return { modifier: 'neutral', text: t('settings.model.checking') };
    case 'unavailable':
      return { modifier: 'neutral', text: t('settings.model.unavailable') };
    case 'not_selected':
      return { modifier: 'neutral', text: t('settings.model.noModelSelected') };
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ModelSectionCallbacks {
  onManageModels: () => void;
  onExternalFile: () => void;
  onModelInfo: (() => void) | null;
}

/**
 * Renders the model section of the settings tab using the new
 * ModelInstallManager as the state source.
 *
 * Returns a dispose function that unsubscribes from manager state changes.
 * Call it when the settings tab is hidden or re-rendered.
 */
export function renderModelSection(
  container: HTMLDivElement,
  manager: ModelInstallManager,
  callbacks: ModelSectionCallbacks,
): () => void {
  let installProgressEl: HTMLDivElement | null = null;

  function render(): void {
    const focus = captureSettingsFocus(container);
    container.empty();
    installProgressEl = null;

    const state = manager.getState();
    const currentModel = deriveCurrentModelDisplay(state);

    const caps = state.selectedModelCapabilities;
    const actions = [
      ...(callbacks.onModelInfo !== null && state.selectedModel?.kind === 'catalog_model'
        ? [{ label: t('settings.model.details'), onSelect: callbacks.onModelInfo }]
        : []),
      { label: t('settings.model.useExternalFile'), onSelect: callbacks.onExternalFile },
    ];
    renderModelSummaryRow(container, {
      taskLabel: t('settings.model.task.stt'),
      modelName: currentModel.displayName,
      icon: 'mic',
      streaming: caps.status === 'ready' && caps.capabilities.family.supportsStreaming,
      status:
        state.selectedModel?.kind === 'external_file' &&
        caps.status === 'unavailable' &&
        caps.reason === 'missing'
          ? { modifier: 'missing', text: t('settings.model.externalMissing') }
          : getModelStatusIndicator(
              currentModel.status === 'not_installed' && state.loadStatus !== 'ready'
                ? state.loadStatus === 'error'
                  ? 'unavailable'
                  : 'checking'
                : currentModel.status,
            ),
      detail: currentModel.status === 'not_installed' ? '' : currentModel.detail,
      onOpen: callbacks.onManageModels,
      actions,
    });

    // --- Install progress panel ---
    const { activeInstall } = state;
    if (activeInstall !== null) {
      const progressState = {
        ...activeInstall.installUpdate,
        isCancelling: isCancellingPhase(activeInstall.phase),
      };
      const activeInstallDisplayName =
        state.catalog.models.find(
          (m) =>
            m.runtimeId === activeInstall.installUpdate.runtimeId &&
            m.familyId === activeInstall.installUpdate.familyId &&
            m.modelId === activeInstall.installUpdate.modelId,
        )?.displayName ?? activeInstall.installUpdate.modelId;

      const isCancelling = isCancellingPhase(activeInstall.phase);
      const { progressEl } = renderActiveInstallCard(container, {
        isCancelling,
        name: t('settings.install.installingNamed', { name: activeInstallDisplayName }),
        onCancel: () => {
          void manager.cancel();
        },
        progressState,
      });
      installProgressEl = progressEl;
    }

    restoreSettingsFocus(container, focus);
  }

  function handleStateChange(): void {
    const state = manager.getState();
    const { activeInstall } = state;

    // If progress element is present and install is still active, do a fast
    // in-place update instead of a full re-render.
    if (activeInstall !== null && installProgressEl !== null) {
      updateInstallProgressElement(installProgressEl, {
        ...activeInstall.installUpdate,
        isCancelling: isCancellingPhase(activeInstall.phase),
      });
      return;
    }

    render();
  }

  render();
  return manager.subscribe(handleStateChange);
}
