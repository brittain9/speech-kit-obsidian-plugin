import type { PluginSettings } from './plugin-settings';

/** A serialized settings mutation applied to the latest committed snapshot. */
export type SettingsMutation = (settings: Readonly<PluginSettings>) => PluginSettings;

/** Shared facade used by settings surfaces that must not construct whole snapshots. */
export interface SettingsMutationFacade {
  mutateSettings: (mutation: SettingsMutation) => Promise<void>;
}
