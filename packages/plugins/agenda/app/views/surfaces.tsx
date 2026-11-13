/**
 * EVERY SURFACE AGENDA DRAWS, built once per daemon from the generated client: that machine's runtime (its ferrets,
 * the device's one agenda client) and the four views over it. Loaded on first use by `../index.ts`.
 */

import type { AppComponent, PanelProps, PluginClient, ScreenProps, SettingsProps } from '@ferretry/kernel/manifest';
import { AgendaFleet, fleetIn } from '../lib/agenda-fleet.ts';
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

/** `holder` is the half's own: every machine's surfaces built with it share one fleet (alone, a fleet of its own). */
export const createSurfaces = (client: PluginClient, holder?: object): AgendaSurfaces => {
  const fleet = holder === undefined ? new AgendaFleet() : fleetIn(holder);
  const runtime = fleet.runtimeOf(client);
  return {
    screens: { agenda: createAgendaScreen(runtime, fleet), 'agenda-ask': createAgendaAskScreen(runtime, fleet) },
    panels: { 'ferret-agenda': createAgendaPanel(runtime), 'ferret-agenda-mode': createAgendaModePanel(runtime) },
    settings: { agenda: createAgendaSettings(runtime) },
  };
};
