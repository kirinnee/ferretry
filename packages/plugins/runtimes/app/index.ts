import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import type { RuntimesClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'runtimes-settings' | 'profiles-settings' | 'model-sets-settings' | 'runtime-picker';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

const settingsView = (name: ViewName): AppComponent<SettingsProps> =>
  lazyComponent<SettingsProps>(async () => (await loadView(name)).default as AppComponent<SettingsProps>);

const pickerView = (client: RuntimesClient): AppComponent<PanelProps> =>
  lazyComponent<PanelProps>(async () =>
    ((await loadView('runtime-picker')).createRuntimePicker as (client: RuntimesClient) => AppComponent<PanelProps>)(
      client,
    ),
  );

/**
 * Runtimes' app half: the three Settings tabs (`runtimes`, `profiles`, `model-sets`) and the runtime picker above the
 * composer. The views are React and load on first use (`./lazy.ts`), so this module imports no React and stays
 * loadable by the registry generator before the app shell, which owns React, is in place.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: {
      runtimes: settingsView('runtimes-settings'),
      profiles: settingsView('profiles-settings'),
      'model-sets': settingsView('model-sets-settings'),
    },
    panels: { 'runtime-picker': pickerView(client) },
  }),
});
