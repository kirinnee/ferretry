import type { AppComponent, PanelProps, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'agenda-screen' | 'agenda-ask-screen' | 'agenda-panel' | 'agenda-settings';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/** A component built by the view's factory with the plugin client, once the view has loaded. */
const viewOf = <Props>(name: ViewName, factory: string, client: PluginClient): AppComponent<Props> =>
  lazyComponent<Props>(async () =>
    ((await loadView(name))[factory] as (client: PluginClient) => AppComponent<Props>)(client),
  );

/**
 * Agenda's app half: the `agenda` page and the page a buzz opens (`agenda-ask`), one ferret's agenda beside its chat
 * (`ferret-agenda`) and the `agenda` Settings tab. The views are React and load on first use (`./lazy.ts`), so this
 * module imports no React and stays loadable by the registry generator before the app shell, which owns React, is in
 * place.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    screens: {
      agenda: viewOf<ScreenProps>('agenda-screen', 'createAgendaScreen', client),
      'agenda-ask': viewOf<ScreenProps>('agenda-ask-screen', 'createAgendaAskScreen', client),
    },
    panels: { 'ferret-agenda': viewOf<PanelProps>('agenda-panel', 'createAgendaPanel', client) },
    settings: { agenda: viewOf<SettingsProps>('agenda-settings', 'createAgendaSettings', client) },
  }),
});
