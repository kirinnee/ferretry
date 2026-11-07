import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import type { LiveRuntimesClient, RuntimesClient } from './lib/client.ts';
import { lazyComponent } from './lazy.ts';

type SettingsView = 'runtimes-settings' | 'profiles-settings' | 'model-sets-settings';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`).
 */
const loadView = (name: SettingsView | 'runtime-picker'): Promise<Record<string, unknown>> =>
  import(`./views/${name}.tsx`);

/** A Settings tab: its module exports `create…(client)`, called once the tab is first drawn. */
const settingsView = (name: SettingsView, factory: string, client: LiveRuntimesClient): AppComponent<SettingsProps> =>
  lazyComponent<SettingsProps>(async () =>
    ((await loadView(name))[factory] as (client: LiveRuntimesClient) => AppComponent<SettingsProps>)(client),
  );

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
      runtimes: settingsView('runtimes-settings', 'createRuntimesSettings', client),
      profiles: settingsView('profiles-settings', 'createProfilesSettings', client),
      'model-sets': settingsView('model-sets-settings', 'createModelSetsSettings', client),
    },
    panels: { 'runtime-picker': pickerView(client) },
  }),
});
