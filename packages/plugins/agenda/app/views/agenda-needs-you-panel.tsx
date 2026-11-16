/**
 * THE NEEDS YOU PANEL (`shell.navPanels['needs-you']`, S4): the ferrets that wait on the owner, under the nav entries.
 * It is the DEVICE's, drawn once with no daemon and no client, so it lists every machine this plugin may run on
 * (`useEveryDaemon`) and reads each one's ferrets through that machine's own runtime. A locked machine is not read.
 * The shell says which form it is drawn in (`useNavForm`): the full group in a column, an icon per ferret in a rail.
 */

import { useEveryDaemon, useNavForm, useOptionalRouter } from '@ferretry/app';
import { useCallback, useMemo } from 'react';
import {
  NeedsYouGroup,
  type NeedsYouMachine,
  NeedsYouRail,
  type NeedsYouRow,
  needsYouAcross,
} from '../features/agenda/agenda-nav.tsx';
import { useInboxMachines } from '../hooks/use-agenda-inbox.ts';
import { type AgendaFleet, fleetIn, mergedFleet } from '../lib/agenda-fleet.ts';

/** The panel over the half's fleet (`holder`, the half's own): its machines' runtimes are the half's. */
export function agendaNeedsYouPanel(holder: object) {
  const fleet = fleetIn(holder);
  return function AgendaNeedsYouPanel() {
    return <NeedsYou fleet={fleet} />;
  };
}

function NeedsYou({ fleet }: { readonly fleet: AgendaFleet }) {
  const reach = useEveryDaemon();
  const form = useNavForm();
  const router = useOptionalRouter();
  const open = useMemo(() => reach.filter(row => !row.locked), [reach]);
  const runtimes = useMemo(() => open.map(row => fleet.runtimeOf(row.client)), [fleet, open]);
  const store = useMemo(() => mergedFleet(runtimes.map(runtime => runtime.ferrets)), [runtimes]);
  const pairings = useMemo(
    () => runtimes.map((runtime, i) => ({ connection: runtime.connection, name: open[i]?.machine ?? runtime.name })),
    [runtimes, open],
  );
  const machines = useInboxMachines(store, pairings);
  const rows = useMemo(
    () =>
      needsYouAcross(
        machines.map(
          (machine): NeedsYouMachine => ({
            daemonId: machine.connection.daemonId,
            name: machine.name,
            sessions: machine.sessions,
          }),
        ),
      ),
    [machines],
  );
  const route = router?.route;
  const isActive = useCallback(
    (row: NeedsYouRow): boolean =>
      route?.kind === 'screen' &&
      route.screen.plugin === 'agenda' &&
      route.screen.id === 'agenda-ask' &&
      route.daemon === row.daemonId &&
      route.params.ferret === row.view.config.id,
    [route],
  );
  const onNavigate = useCallback((to: string) => router?.navigate(to), [router]);
  return form === 'rail' ? (
    <NeedsYouRail isActive={isActive} onNavigate={onNavigate} rows={rows} />
  ) : (
    <NeedsYouGroup isActive={isActive} onNavigate={onNavigate} rows={rows} />
  );
}
