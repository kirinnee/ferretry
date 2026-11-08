/** The `layout` Settings tab: the layout in use, its changes for every device, and this device's own. */

import { useDeviceLayout } from '@ferretry/app';
import type { PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { LayoutSettings } from '../features/layout/layout-settings.tsx';
import { layoutsClient } from '../lib/layouts-client.ts';

export function createLayoutSettings(client: PluginClient) {
  const layouts = layoutsClient(client);
  return function LayoutSettingsTab(_props: SettingsProps) {
    const device = useDeviceLayout();
    return <LayoutSettings client={layouts} {...(device === undefined ? {} : { device })} />;
  };
}
