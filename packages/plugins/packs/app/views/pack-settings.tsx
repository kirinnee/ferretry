import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { PackSettingsSurface } from '../features/pack/pack-settings.tsx';
import type { PacksClient } from '../lib/client.ts';
import { useConfigFiles } from '../ui.ts';

/** What the page says while the shell gives it no configuration-file port to read and save `packs.yaml` through. */
export const NO_CONFIG_FILES =
  'Pack mode’s settings are saved in config/packs.yaml, and this page cannot read or save that file yet. Edit it by hand meanwhile; the daemon applies it, and holds a change that loosens a limit until you confirm it.';

/** Settings › Pack mode: the switch, who decides, the limits, the probe, Jev's cap and the routing prompt. */
export const createSettings = (client: PacksClient): AppComponent<SettingsProps> =>
  function PackSettings() {
    const configFiles = useConfigFiles();
    if (configFiles === undefined) return <p className="text-sm">{NO_CONFIG_FILES}</p>;
    return <PackSettingsSurface client={client} configFiles={configFiles} />;
  };
