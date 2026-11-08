import type { AppComponent, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * keeps this module free of React so the registry generator can load it before the app shell is in place.
 */
const loadView = (name: 'shells-settings'): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

const settingsOf = (client: PluginClient): AppComponent<SettingsProps> =>
  lazyComponent<SettingsProps>(async () =>
    (
      (await loadView('shells-settings'))['createShellsSettings'] as (
        client: PluginClient,
      ) => AppComponent<SettingsProps>
    )(client),
  );

/**
 * Shells' app half: the `shells` Settings tab, where the owner sees whether nix is on the machine, the shells and their
 * build state, and adds, re-locks, builds and removes one. Every call goes through Shells' own routes by key; a write
 * that a governed device must step up for meets the passkey seam the app shell mounts. The view is React and loads on
 * first use (`./lazy.ts`).
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    screens: {},
    panels: {},
    settings: { shells: settingsOf(client) },
    renderers: {},
  }),
});
