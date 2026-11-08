import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';
import type { PacksClient } from './lib/client.ts';

type ViewName = 'pack-settings' | 'helpers-panel' | 'pack-call-panel';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/**
 * Packs' app half: Settings › Pack mode (the switch, who decides, the limits, the probe and the routing prompt),
 * the helpers panel beside a ferret (its own Pack mode switch, and the helpers it started) and the Pack card drawn
 * beside a transcript row (`conversation.row`, Conversation's slot). The views are React and
 * load on first use (`./lazy.ts`), so this module imports no React and stays loadable by the registry generator before the
 * app shell, which owns React, is in place.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const packs: PacksClient = client;
    return {
      settings: {
        pack: lazyComponent<SettingsProps>(async () =>
          ((await loadView('pack-settings')).createSettings as (client: PacksClient) => AppComponent<SettingsProps>)(
            packs,
          ),
        ),
      },
      panels: {
        helpers: lazyComponent<PanelProps>(async () =>
          ((await loadView('helpers-panel')).createPanel as (client: PacksClient) => AppComponent<PanelProps>)(packs),
        ),
        'pack-call': lazyComponent<PanelProps>(async () =>
          ((await loadView('pack-call-panel')).createPanel as (client: PacksClient) => AppComponent<PanelProps>)(packs),
        ),
      },
    };
  },
});
