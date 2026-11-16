import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { useMemo } from 'react';
import { PackSettingsSurface } from '../features/pack/pack-settings.tsx';
import type { PacksClient } from '../lib/client.ts';
import { createConfigFiles } from '../lib/config-files-client.ts';

/** Settings › Pack mode: the switch, who decides, the limits, the probe, Jev's cap and the routing prompt. */
export const createSettings = (client: PacksClient): AppComponent<SettingsProps> =>
  function PackSettings() {
    const configFiles = useMemo(() => createConfigFiles(client), []);
    return <PackSettingsSurface client={client} configFiles={configFiles} />;
  };
