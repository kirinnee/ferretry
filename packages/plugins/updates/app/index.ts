import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'updates-settings' | 'behind-panel';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/**
 * Updates' app half: its Settings tab (how this daemon was installed, whether it is behind, the update and the
 * automatic-install switch) and the `behind` notice on the daemon-status panel.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: {
      updates: lazyComponent<SettingsProps>(async () => {
        const view = await loadView('updates-settings');
        return (view.createSettings as (client: unknown) => AppComponent<SettingsProps>)(client);
      }),
    },
    panels: {
      behind: lazyComponent<PanelProps>(async () => {
        const view = await loadView('behind-panel');
        return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
      }),
    },
  }),
});
