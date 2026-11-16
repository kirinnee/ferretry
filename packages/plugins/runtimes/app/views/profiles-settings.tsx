import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { ProfilesTab } from '../features/fleet/profiles/profiles-tab.tsx';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

/** Settings › Profiles: the layered setups a runtime uses. */
export const createProfilesSettings = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <ProfilesTab {...props} />);
