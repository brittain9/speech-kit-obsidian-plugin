import type { LlmPreset } from '../llm/presets';
import { isRecord } from '../shared/type-guards';
import type {
  PersonalCorrectionRule,
  PersonalCorrectionRuleDiagnostic,
  PersonalCorrectionRuleOrderEntry,
} from './personal-correction-rules';
import { type PluginSettings, resolvePluginSettings } from './plugin-settings';
import type { SettingsMutation } from './settings-mutation';

export interface LlmPresetState {
  activePresetRef: string;
  userPresets: LlmPreset[];
}

export type LlmPresetStateMutation = (state: Readonly<LlmPresetState>) => LlmPresetState;

export interface PersonalCorrectionState {
  diagnostics: PersonalCorrectionRuleDiagnostic[];
  order: PersonalCorrectionRuleOrderEntry[];
  rules: PersonalCorrectionRule[];
}

export interface SettingsStateStoreDependencies {
  commit: (settings: PluginSettings, options: { persist: boolean }) => Promise<void>;
  getSettings: () => PluginSettings;
  loadData: () => Promise<unknown>;
  onExternalChange: () => void;
  warn: (message: string, error: unknown) => void;
}

export function readLlmPresetState(settings: PluginSettings): LlmPresetState {
  return {
    activePresetRef: settings.llmPostprocessActivePresetRef,
    userPresets: settings.llmPostprocessUserPresets,
  };
}

export function withLlmPresetState(
  settings: PluginSettings,
  state: LlmPresetState,
): PluginSettings {
  return {
    ...settings,
    llmPostprocessActivePresetRef: state.activePresetRef,
    llmPostprocessUserPresets: state.userPresets,
  };
}

export function readPersonalCorrectionState(settings: PluginSettings): PersonalCorrectionState {
  return {
    diagnostics: settings.personalCorrectionRuleDiagnostics,
    order: settings.personalCorrectionRuleOrder,
    rules: settings.personalCorrectionRules,
  };
}

export function withPersonalCorrectionState(
  settings: PluginSettings,
  state: PersonalCorrectionState,
): PluginSettings {
  return {
    ...settings,
    personalCorrectionRuleDiagnostics: state.diagnostics,
    personalCorrectionRuleOrder: state.order,
    personalCorrectionRules: state.rules,
  };
}

export function areLlmPresetStatesEqual(left: LlmPresetState, right: LlmPresetState): boolean {
  if (
    left.activePresetRef !== right.activePresetRef ||
    left.userPresets.length !== right.userPresets.length
  ) {
    return false;
  }

  return left.userPresets.every((preset, index) =>
    areLlmPresetsEqual(preset, right.userPresets[index]),
  );
}

export function arePersonalCorrectionStatesEqual(
  left: PersonalCorrectionState,
  right: PersonalCorrectionState,
): boolean {
  return fingerprint(left) === fingerprint(right);
}

/** Serializes all settings mutations, including correction-rule writes. */
export class SettingsStateStore {
  private operationTail: Promise<void> = Promise.resolve();
  private syncEpoch = 0;
  private synchronizedEpoch = -1;
  private syncInFlight: Promise<void> | null = null;

  constructor(private readonly dependencies: SettingsStateStoreDependencies) {}

  synchronize(): Promise<void> {
    if (this.syncInFlight !== null) return this.syncInFlight;

    const epoch = ++this.syncEpoch;
    const operation = this.enqueue(async () => {
      await this.synchronizeNow();
      this.synchronizedEpoch = epoch;
    });
    const tracked = operation.finally(() => {
      if (this.syncInFlight === tracked) this.syncInFlight = null;
    });
    this.syncInFlight = tracked;
    return tracked;
  }

  mutateLlmState(mutation: LlmPresetStateMutation): Promise<void> {
    const epoch = this.syncEpoch;
    const reuseSynchronization = this.syncInFlight !== null;
    return this.enqueue(async () => {
      await this.synchronizeBefore(epoch, reuseSynchronization);
      const currentSettings = this.dependencies.getSettings();
      const currentState = readLlmPresetState(currentSettings);
      const normalizedSettings = resolvePluginSettings(
        withLlmPresetState(currentSettings, mutation(currentState)),
      );
      const normalizedState = readLlmPresetState(normalizedSettings);
      if (areLlmPresetStatesEqual(currentState, normalizedState)) return;

      await this.dependencies.commit(withLlmPresetState(currentSettings, normalizedState), {
        persist: true,
      });
    });
  }

  mutateSettings(mutation: SettingsMutation): Promise<void> {
    const epoch = this.syncEpoch;
    const reuseSynchronization = this.syncInFlight !== null;
    return this.enqueue(async () => {
      await this.synchronizeBefore(epoch, reuseSynchronization);
      const nextSettings = resolvePluginSettings(mutation(this.dependencies.getSettings()));
      await this.dependencies.commit(nextSettings, { persist: true });
    });
  }

  commitPreservingSettings(nextSettings: PluginSettings): Promise<void> {
    const epoch = this.syncEpoch;
    const reuseSynchronization = this.syncInFlight !== null;
    return this.enqueue(async () => {
      await this.synchronizeBefore(epoch, reuseSynchronization);
      const currentSettings = this.dependencies.getSettings();
      const next = withPersonalCorrectionState(
        withLlmPresetState(nextSettings, readLlmPresetState(currentSettings)),
        readPersonalCorrectionState(currentSettings),
      );
      await this.dependencies.commit(next, { persist: true });
    });
  }

  commitPreservingSettingsIf(
    condition: (settings: Readonly<PluginSettings>) => boolean,
    createNextSettings: (settings: Readonly<PluginSettings>) => PluginSettings,
  ): Promise<boolean> {
    const epoch = this.syncEpoch;
    const reuseSynchronization = this.syncInFlight !== null;
    return this.enqueue(async () => {
      await this.synchronizeBefore(epoch, reuseSynchronization);
      const currentSettings = this.dependencies.getSettings();
      if (!condition(currentSettings)) return false;

      await this.dependencies.commit(
        withPersonalCorrectionState(
          withLlmPresetState(
            createNextSettings(currentSettings),
            readLlmPresetState(currentSettings),
          ),
          readPersonalCorrectionState(currentSettings),
        ),
        { persist: true },
      );
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async synchronizeBefore(epoch: number, reuseSynchronization: boolean): Promise<void> {
    if (!reuseSynchronization || this.synchronizedEpoch < epoch) await this.synchronizeNow();
  }

  private async synchronizeNow(): Promise<void> {
    try {
      const raw = await this.dependencies.loadData();
      if (!isRecord(raw)) throw new Error('Persisted plugin data is not an object');
      const persisted = resolvePluginSettings(raw);
      const currentSettings = this.dependencies.getSettings();
      const next = withPersonalCorrectionState(
        withLlmPresetState(currentSettings, readLlmPresetState(persisted)),
        readPersonalCorrectionState(persisted),
      );
      if (
        areLlmPresetStatesEqual(
          readLlmPresetState(currentSettings),
          readLlmPresetState(persisted),
        ) &&
        arePersonalCorrectionStatesEqual(
          readPersonalCorrectionState(currentSettings),
          readPersonalCorrectionState(persisted),
        )
      ) {
        return;
      }

      await this.dependencies.commit(next, { persist: false });
      this.dependencies.onExternalChange();
    } catch (error) {
      this.dependencies.warn('Failed to synchronize settings from data.json', error);
    }
  }
}

function fingerprint(state: PersonalCorrectionState): string {
  return JSON.stringify(state);
}

function areLlmPresetsEqual(left: LlmPreset, right: LlmPreset | undefined): boolean {
  return (
    right !== undefined &&
    left.id === right.id &&
    left.label === right.label &&
    left.description === right.description &&
    left.prompt === right.prompt &&
    left.timing === right.timing &&
    left.output === right.output &&
    left.overrides?.minWords === right.overrides?.minWords &&
    left.overrides?.temperature === right.overrides?.temperature &&
    left.overrides?.useNoteContext === right.overrides?.useNoteContext
  );
}
