/** The `layout` Settings tab: the layout in use, its changes for every device, and this device's own. */

import { useAbsentPanels, useDeviceLayout, useNavCatalog } from '@ferretry/app';
import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { LayoutSettings } from '../features/layout/layout-settings.tsx';
import { layoutsClient, type LayoutsClient } from '../lib/layouts-client.ts';
import type { DeviceLayout } from '@ferretry/app';

/** Inside the shell: the installed navigation set is the fixed list the tab reorders and hides from. */
function InShell({ client, device }: { readonly client: LayoutsClient; readonly device: DeviceLayout }) {
  return (
    <LayoutSettings
      client={client}
      device={device}
      navCatalog={useNavCatalog()}
      absentPanels={useAbsentPanels('ferret.side')}
    />
  );
}

export function createLayoutSettings(client: PluginClient) {
  const layouts = layoutsClient(client);
  return function LayoutSettingsTab(_props: SettingsProps) {
    const device = useDeviceLayout();
    // No device layout means no shell (a harness): there is no installed set to list, and the hook would refuse.
    return device === undefined ? <LayoutSettings client={layouts} /> : <InShell client={layouts} device={device} />;
  };
}
