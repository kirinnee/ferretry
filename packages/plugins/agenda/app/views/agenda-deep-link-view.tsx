/**
 * THE CARD A LINK OPENS (`<app>/#agenda/<id>?session=<sid>&machine=<daemon id>`, printed by `fy plan approve` and
 * `fy account factor add`): Agenda's DEVICE VIEW (shell contract S3, MA2). The shell takes the declared `#agenda/…`
 * fragment off the address before anything draws and hands it to this one view — the only taker, so the per-machine
 * halves never race for it — and this view, over every machine (`useEveryDaemon`), opens the ask on the machine that
 * runs its session: the one the link names when it is paired, else the one whose session list holds it.
 *
 * - A machine that has not been read yet, or is paired and has no row yet (a cold open), makes the link wait; a LOCKED machine is read as "not this one" (R3 n4), so a
 *   link from an older `fy` never waits on a machine that is not on screen, and nothing prompts.
 * - A link no machine runs, a link that names no session, and a link still waiting after two minutes are dropped.
 * - Nothing in the link reaches a daemon: it only picks which page opens.
 */

import { type DaemonReach, type DeviceViewProps, useDevicePaired, useEveryDaemon, useFragment } from '@ferretry/app';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  type AgendaDeepLink,
  agendaDeepLinkFromHash,
  inboxTargetPath,
  machineForAgendaLink,
} from '../lib/agenda-inbox.ts';
import { type AgendaFleet, fleetIn } from '../lib/agenda-fleet.ts';
import type { FleetSnapshot } from '../lib/ferret-store.ts';
import { type DaemonId, daemonId } from '../lib/machine.ts';

/** The fragment key Agenda declares. */
export const AGENDA_FRAGMENT_KEY = 'agenda';
/** How long a link may wait for a machine that might run its session. */
export const AGENDA_LINK_WAIT_MS = 120_000;

const NO_ROWS: readonly DaemonReach[] = [];
const NO_PAIRED: readonly string[] = [];

interface LinkMachine {
  readonly daemonId: DaemonId;
  readonly sessionIds: readonly string[] | null;
}

/**
 * Every PAIRED machine's session ids (`null` until read), live; a locked machine lists none. A paired machine with no
 * row yet (still connecting, or its inventory not read) is `null` too: the link waits for it, as v4 did for every
 * paired machine — a cold open has no row at all while the link is already taken.
 */
function useLinkMachines(
  fleet: AgendaFleet,
  paired: readonly string[],
  rows: readonly DaemonReach[],
): readonly LinkMachine[] {
  const sources = useMemo(
    () =>
      paired.map(daemon => {
        const row = rows.find(candidate => candidate.daemon === daemon);
        return {
          daemon,
          row,
          ferrets: row === undefined || row.locked ? undefined : fleet.runtimeOf(row.client).ferrets,
        };
      }),
    [fleet, paired, rows],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = sources.map(source => source.ferrets?.subscribe(listener));
      return () => {
        for (const stop of stops) stop?.();
      };
    },
    [sources],
  );
  const held = useRef<{
    readonly snapshots: readonly (FleetSnapshot | undefined)[];
    readonly machines: readonly LinkMachine[];
  }>({ snapshots: [], machines: [] });
  const read = useCallback((): readonly LinkMachine[] => {
    const snapshots = sources.map(source => source.ferrets?.getSnapshot());
    const last = held.current;
    if (last.snapshots.length === snapshots.length && last.snapshots.every((snapshot, i) => snapshot === snapshots[i]))
      if (last.machines.length === sources.length) return last.machines;
    const machines = sources.map(({ daemon, row }, i): LinkMachine => {
      const id = daemonId(daemon);
      if (row === undefined) return { daemonId: id, sessionIds: null };
      if (row.locked) return { daemonId: id, sessionIds: [] };
      const sessions = snapshots[i]?.daemons.get(id)?.sessions ?? null;
      return { daemonId: id, sessionIds: sessions === null ? null : sessions.map(session => session.config.id) };
    });
    held.current = { snapshots, machines };
    return machines;
  }, [sources]);
  return useSyncExternalStore(subscribe, read, read);
}

/** The device view over the half's fleet (`holder`, the half's own): its machines' runtimes are the half's. */
export function agendaDeepLinkView(holder: object) {
  const fleet = fleetIn(holder);
  return function AgendaDeepLinkView(props: DeviceViewProps) {
    return <DeepLink fleet={fleet} {...props} />;
  };
}

function DeepLink({ navigate, fleet }: DeviceViewProps & { readonly fleet: AgendaFleet }) {
  const rows = useEveryDaemon();
  const pairedList = useDevicePaired().daemons;
  const { arrival, take } = useFragment(AGENDA_FRAGMENT_KEY);
  const [link, setLink] = useState<AgendaDeepLink | null>(null);
  useEffect(() => {
    if (arrival === 0) return;
    const taken = take();
    if (taken === undefined) return;
    const parsed = agendaDeepLinkFromHash(taken);
    // A link that names no session cannot pick a machine: it is dropped here.
    setLink(parsed?.sessionId === undefined ? null : parsed);
  }, [arrival, take]);
  useEffect(() => {
    if (link === null) return;
    const timer = setTimeout(() => setLink(null), AGENDA_LINK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [link]);
  // The machines are read only while a link waits: with none, opening the app reads nothing for it.
  const paired = useMemo(
    () => (link === null ? NO_PAIRED : pairedList.map(daemon => daemon.daemon)),
    [link, pairedList],
  );
  const machines = useLinkMachines(fleet, paired, link === null ? NO_ROWS : rows);
  useEffect(() => {
    if (link === null || link.sessionId === undefined) return;
    // A link that names a paired machine opens there once its row exists (the plugin is on and allowed there), not
    // before: a machine still connecting is waited for, never called "not this one".
    const named = machines.find(machine => machine.daemonId === link.machine);
    if (named !== undefined && !rows.some(row => row.daemon === named.daemonId)) return;
    const found = machineForAgendaLink(link, machines);
    if (found === 'wait') return;
    setLink(null);
    if (found !== undefined) navigate(inboxTargetPath(found, link.sessionId, link.id));
  }, [link, machines, rows, navigate]);
  return null;
}
