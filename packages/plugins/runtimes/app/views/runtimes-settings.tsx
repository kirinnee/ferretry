import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { RuntimesTab } from '../features/fleet/runtimes/runtimes-tab.tsx';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { machineSettingsView } from './machine-settings-host.tsx';

/** Settings › Runtimes: the default runtime, each runtime and its page, Add runtime. */
export const createRuntimesSettings = (client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  machineSettingsView(client, props => <RuntimesTab {...props} />);
