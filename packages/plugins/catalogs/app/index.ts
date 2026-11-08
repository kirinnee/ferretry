import type { AppComponent, PluginClient, ScreenProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type Factory = 'createSharingScreen' | 'createJoinScreen' | 'createSharedScreen';

/**
 * The views module (React), loaded on first use. The specifier is a Vite dynamic-import path, which keeps this module
 * free of React so the registry generator can load it before the app shell is in place.
 */
const loadViews = (): Promise<Record<string, unknown>> => import('./views/catalogs-views.tsx');

const screenOf = (factory: Factory, client: PluginClient): AppComponent<ScreenProps> =>
  lazyComponent<ScreenProps>(async () =>
    ((await loadViews())[factory] as (client: PluginClient) => AppComponent<ScreenProps>)(client),
  );

/**
 * Catalogs' app half (§2.3): the `sharing` page (Subscriptions, My catalogs, People), the `join` page a share link
 * lands on, and `shared`, what is shared with this browser. Every call to a daemon rides the half's own client by the
 * route keys Catalogs' manifest declares; a publisher this browser is not paired with is reached only through the
 * shell's member transport (`@ferretry/app` `MemberCarriers`), and fails closed while the shell offers none.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    screens: {
      sharing: screenOf('createSharingScreen', client),
      join: screenOf('createJoinScreen', client),
      shared: screenOf('createSharedScreen', client),
    },
    panels: {},
    settings: {},
    renderers: {},
  }),
});
