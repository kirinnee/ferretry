import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { PackSettingsSurface } from '../features/pack/pack-settings.tsx';
import type { PacksClient } from '../lib/client.ts';
import { useConfigFiles } from '../ui.ts';

/** Settings › Pack mode: the switch, who decides, the limits, the probe, Jev's cap and the routing prompt. */
export const createSettings = (client: PacksClient): AppComponent<SettingsProps> =>
  function PackSettings() {
    return <PackSettingsSurface client={client} configFiles={useConfigFiles()} />;
  };
