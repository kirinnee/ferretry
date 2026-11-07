import type { AppComponent, PanelProps, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type Surfaces = {
  readonly screens: Record<string, AppComponent<ScreenProps>>;
  readonly panels: Record<string, AppComponent<PanelProps>>;
  readonly settings: Record<string, AppComponent<SettingsProps>>;
};

/**
 * The view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), so
 * the registry generator, which only inspects this module, never loads React.
 */
const loadSurfaces = (): Promise<Record<string, unknown>> => import(`./views/${'surfaces'}.tsx`);

/**
 * Agenda's app half: the `agenda` page and the page a buzz opens (`agenda-ask`), one ferret's agenda beside its chat
 * (`ferret-agenda`) and the `agenda` Settings tab. Every surface reads and answers through the one generated client,
 * over one runtime built for the daemon (`views/surfaces.tsx`). The ask page offers the `agenda.conversation` slot
 * (contract/slots.ts) where the ferret's conversation goes.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    let surfaces: Promise<Surfaces> | undefined;
    const surfacesOf = (): Promise<Surfaces> => {
      surfaces ??= loadSurfaces().then(module => (module.createSurfaces as (client: PluginClient) => Surfaces)(client));
      return surfaces;
    };
    const screen = (id: 'agenda' | 'agenda-ask') =>
      lazyComponent<ScreenProps>(async () => (await surfacesOf()).screens[id] as AppComponent<ScreenProps>);
    return {
      screens: { agenda: screen('agenda'), 'agenda-ask': screen('agenda-ask') },
      panels: {
        'ferret-agenda': lazyComponent<PanelProps>(
          async () => (await surfacesOf()).panels['ferret-agenda'] as AppComponent<PanelProps>,
        ),
      },
      settings: {
        agenda: lazyComponent<SettingsProps>(
          async () => (await surfacesOf()).settings.agenda as AppComponent<SettingsProps>,
        ),
      },
    };
  },
});
