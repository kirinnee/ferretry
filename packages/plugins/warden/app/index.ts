import type { AppComponent, PanelProps, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'warden-screen' | 'warden-settings' | 'warden-dashboard';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * keeps this module free of React so the registry generator can load it before the app shell is in place.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/** A component built by the view's factory with the plugin client, once the view has loaded. */
const viewOf = <Props>(name: ViewName, factory: string, client: PluginClient): AppComponent<Props> =>
  lazyComponent<Props>(async () =>
    ((await loadView(name))[factory] as (client: PluginClient) => AppComponent<Props>)(client),
  );

/**
 * Warden's app half: the `warden` page (live status, flags, verdicts, the report dialog, action statistics, "leave it
 * alone" and "investigate"), the `warden` Settings tab, and the ferrets dashboard's pack-health strip and recent
 * verdicts (`daemon.status` panels). "Ask the Warden" is the manifest's `ask-warden` ferret action. The views are React
 * and load on first use (`./lazy.ts`).
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    screens: { warden: viewOf<ScreenProps>('warden-screen', 'createWardenScreen', client) },
    panels: {
      'warden-strip': viewOf<PanelProps>('warden-dashboard', 'createWardenStripPanel', client),
      'warden-verdicts': viewOf<PanelProps>('warden-dashboard', 'createWardenVerdictsPanel', client),
    },
    settings: { warden: viewOf<SettingsProps>('warden-settings', 'createWardenSettings', client) },
  }),
});
