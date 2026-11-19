import { forSubject } from '@ferretry/app';
import type { AppComponent, PanelProps, PluginClient, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * keeps this module free of React so the registry generator can load it before the app shell is in place.
 */
const loadView = (name: 'layout-settings' | 'layout-step'): Promise<Record<string, unknown>> =>
  import(`./views/${name}.tsx`);

/** A component built by the view's factory with the plugin client, once the view has loaded. */
const viewOf = <Props>(
  name: 'layout-settings' | 'layout-step',
  factory: string,
  client: PluginClient,
): AppComponent<Props> =>
  lazyComponent<Props>(async () =>
    ((await loadView(name))[factory] as (client: PluginClient) => AppComponent<Props>)(client),
  );

/**
 * Layouts' app half: the `layout` Settings tab. It shows the layout in use with your changes applied and changes it as
 * data through Layouts' own routes (sidebar side, navigation, panels, density, theme) for every device, or keeps a
 * change on this device only, which is the app's saved data and has no route. The view is React and loads on first use
 * (`./lazy.ts`). It also draws the first-run `layouts.layout` step (a client step: this device's navigation side and
 * density, written to this device only).
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    panels: {
      'onboarding-step': forSubject('layouts.layout', viewOf<PanelProps>('layout-step', 'createLayoutStep', client)),
    },
    settings: { layout: viewOf<SettingsProps>('layout-settings', 'createLayoutSettings', client) },
  }),
});
