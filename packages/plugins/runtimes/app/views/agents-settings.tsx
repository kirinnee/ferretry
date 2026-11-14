import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { AgentsTab } from '../features/fleet/machine/agents-tab.tsx';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

/** Settings › Agents: permissions, what agents may control, auto-resume, agenda mode, conversations. */
export const createAgentsSettings = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <AgentsTab {...props} />);
