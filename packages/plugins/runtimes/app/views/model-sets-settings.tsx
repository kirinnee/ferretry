import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { ModelSetsTab } from '../features/fleet/components/model-sets-tab.tsx';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

/** Settings › Model sets: the model sets a profile can layer in. */
export const createModelSetsSettings = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <ModelSetsTab {...props} />);
