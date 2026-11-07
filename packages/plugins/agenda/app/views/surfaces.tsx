/**
 * EVERY SURFACE AGENDA DRAWS, built once per daemon from the generated client: the half's one runtime (the agenda
 * client, the ferrets) and the four views over it. Loaded on first use by `../index.ts`.
 */

import type { AppComponent, PanelProps, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { createAgendaRuntime } from '../lib/agenda-runtime.ts';
import { createAgendaAskScreen } from './agenda-ask-screen.tsx';
import { createAgendaModePanel } from './agenda-mode-panel.tsx';
import { createAgendaPanel } from './agenda-panel.tsx';
import { createAgendaScreen } from './agenda-screen.tsx';
import { createAgendaSettings } from './agenda-settings.tsx';

export interface AgendaSurfaces {
  readonly screens: { readonly agenda: AppComponent<ScreenProps>; readonly 'agenda-ask': AppComponent<ScreenProps> };
  readonly panels: {
    readonly 'ferret-agenda': AppComponent<PanelProps>;
    readonly 'ferret-agenda-mode': AppComponent<PanelProps>;
  };
  readonly settings: { readonly agenda: AppComponent<SettingsProps> };
}

export const createSurfaces = (client: PluginClient): AgendaSurfaces => {
  const runtime = createAgendaRuntime(client);
  return {
    screens: { agenda: createAgendaScreen(runtime), 'agenda-ask': createAgendaAskScreen(runtime) },
    panels: { 'ferret-agenda': createAgendaPanel(runtime), 'ferret-agenda-mode': createAgendaModePanel(runtime) },
    settings: { agenda: createAgendaSettings(runtime) },
  };
};
