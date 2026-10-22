/**
 * ONE SESSION LIST ACROSS EVERY PAIRED MACHINE, as pure decisions.
 *
 * The reader asked to see "everything I need to respond to" without switching machines. So the list
 * (the desktop sessions bar and the phone's Sessions page) can show every paired machine at once:
 *
 *   1. NEEDS YOU, pinned at the top: every session on a machine this browser can reach that is parked
 *      on a person, the most urgent first and, within one urgency, the one that has waited longest.
 *      Each row names its machine, because nothing around it does.
 *   2. Then each machine under its own heading — a reach dot, its name, and for one that stopped
 *      answering "offline · last seen 5m" — and under it that machine's project groups.
 *
 * A NEEDS-YOU ROW MOVES UP; IT IS NOT REPEATED BELOW. Pinned means "this is where it is now": the same
 * agent twice in one column reads as two agents. The machine heading still counts it.
 *
 * AN OFFLINE MACHINE'S ROWS ARE WHAT IT LAST SAID, and are shown as exactly that: greyed under a
 * heading that says when. They never enter Needs you, which is a list of things the reader can act on
 * now, and a question on a machine nobody can reach is not one — its row keeps its badge in place.
 *
 * NOTHING HERE MIXES MACHINES' DATA. Every row keeps the `DaemonId` it was read from, a project group
 * is built from one machine's sessions and that machine's own registry, and the caller links each row
 * to its own machine's route — which is what makes the header, Info, Actions and composer follow it.
 */

import type { SessionView } from '@ferretry/protocol';
import {
  listedBeforeMode,
  listTallies,
  matchesMode,
  needsYou,
  type SessionsListFilter,
} from '../shell/sessions-bar-model.ts';
import type { ConnectionHealthState } from './connection-health.ts';
import type { DaemonId } from './daemon-connection.ts';
import { type FleetProject, groupByProject, type ModeCounts, type SessionGroup } from './fleet-grouping.ts';
import type { DaemonFleetSlice } from './fleet-store.ts';
import { reconcileMachineOrder } from './machine-order.ts';
import { type MachineOutage, machineOutage, unreachableOutage } from './machine-outage.ts';

/**
 * How one machine is reached right now, as its heading's dot says it.
 *
 *   online   it answered its last read;
 *   offline  the connection is recovering, or its list could not be read — its rows are its last word;
 *   locked   its reads wait for a passkey unlock, which only its own page asks for;
 *   reading  nothing has been read from it yet.
 */
export type ListReach = 'online' | 'offline' | 'locked' | 'reading';

/** One machine's reach, from the health model's fact and its own list read. */
export const machineReach = (health: ConnectionHealthState, slice: DaemonFleetSlice, locked: boolean): ListReach => {
  if (locked) return 'locked';
  if (health.kind === 'reconnecting' || slice.status === 'error') return 'offline';
  return slice.sessions === null ? 'reading' : 'online';
};

/**
 * How urgently a waiting session wants the reader: lower is sooner.
 *
 *   0  it asked something — a question, or a permission prompt on its screen;
 *   1  the daemon flagged it for a human;
 *   2  it is simply waiting for the reader's next message.
 */
export const needsYouUrgency = (view: SessionView): number => {
  const { state } = view;
  if (state.status === 'awaiting_question' || (state.pendingQuestion ?? null) !== null) return 0;
  if (state.turnState === 'needs-input') return 0;
  return (state.needsHuman ?? '') === '' ? 2 : 1;
};

/** When this session started waiting, as near as the daemon says: its last turn change, else its last activity. */
export const waitingSince = (view: SessionView): number => {
  const at = Date.parse(view.state.turnStateAt ?? view.state.lastActivityAt ?? view.config.updatedAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
};

/** One paired machine, as the caller read it: its slice, its registry, and its reach. */
export interface MachineSource {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly slice: DaemonFleetSlice;
  readonly projects: readonly FleetProject[];
  readonly reach: ListReach;
  /** Its connection health, so an offline heading can say why; absent reads as unmeasured. */
  readonly health?: ConnectionHealthState;
}

/** A session in the pinned group, carrying the machine it belongs to. */
export interface NeedsYouEntry {
  readonly daemonId: DaemonId;
  readonly machineName: string;
  readonly view: SessionView;
}

/** One machine's heading and its project groups. */
export interface MachineSection {
  readonly daemonId: DaemonId;
  readonly name: string;
  readonly reach: ListReach;
  /** The last good read, for "last seen"; `null` before one. */
  readonly readAt: number | null;
  /** Its sessions under the current filter, Needs you included. */
  readonly total: number;
  /** How many of them moved up into Needs you. */
  readonly needsYou: number;
  readonly groups: readonly SessionGroup[];
  /** Everything the machine listed, so a row's parent can be named though the filter hid it. */
  readonly sessions: readonly SessionView[];
  /** Why this machine's rows are not live — said in its own heading, never over the page. */
  readonly outage: MachineOutage | null;
  /**
   * Set while THIS machine's rows are this device's cached copy and its live read is still out, so
   * only its own heading says "Updating…". `null` once it answered, and for a machine that is down:
   * a retrying machine is said by its outage, not by a spinner that waits on it.
   */
  readonly cachedAt: number | null;
}

export interface AllMachinesView {
  readonly needsYou: readonly NeedsYouEntry[];
  readonly machines: readonly MachineSection[];
  /** What each mode segment would show, across every machine, under the stopped rule. */
  readonly counts: ModeCounts;
  /** How many stopped sessions ticking "Show stopped" would add, across every machine, under the mode chosen. */
  readonly hiddenStopped: number;
  /** Every session the list could show before the filter, across every machine. */
  readonly total: number;
  /** True once any machine has answered, so an all-unread list reads as loading. */
  readonly loaded: boolean;
}

export interface AllMachinesOptions {
  /** The sessions bar's controls. By default every kind, stopped sessions included. */
  readonly filter?: SessionsListFilter;
  /** The session on screen, which stays listed though stopped. It names its machine because ids collide. */
  readonly keep?: (daemonId: DaemonId, view: SessionView) => boolean;
  /** A screen's own narrowing (the dashboard's search and mode filter), applied first. */
  readonly select?: (sessions: readonly SessionView[]) => readonly SessionView[];
  /** Most recent first inside each project group: what the sessions bar wants, not the table. */
  readonly sortRows?: boolean;
}

const SHOW_EVERYTHING: SessionsListFilter = { mode: 'all', showStopped: true };

const everything = (sessions: readonly SessionView[]): readonly SessionView[] => sessions;

const UNMEASURED: ConnectionHealthState = { kind: 'unknown' };

/**
 * An offline machine's outage. Its reach already said "offline", so one is always produced: a machine
 * whose slice and health hold no failure to name still reads as unreachable, never as a bare heading.
 */
const sectionOutage = (machine: MachineSource): MachineOutage =>
  machineOutage(machine.name, machine.health ?? UNMEASURED, machine.slice, { immediate: true }) ??
  unreachableOutage(machine.name, machine.slice);

/** Can the reader act on this machine's rows now? Only a machine that answered. */
const actionable = (reach: ListReach): boolean => reach === 'online';

/**
 * The whole list in one pass. `machines` arrives in display order — the machine on screen first —
 * and that order is kept for the headings and breaks ties in Needs you.
 */
export const allMachinesView = (
  machines: readonly MachineSource[],
  { filter = SHOW_EVERYTHING, select = everything, keep, sortRows = false }: AllMachinesOptions = {},
): AllMachinesView => {
  const pinned: (NeedsYouEntry & { readonly order: number })[] = [];
  const sections: MachineSection[] = [];
  let counts: ModeCounts = { all: 0, auto: 0, interactive: 0 };
  let hiddenStopped = 0;
  let total = 0;
  let loaded = false;
  machines.forEach((machine, order) => {
    if (machine.slice.sessions !== null) loaded = true;
    const pool = select(machine.slice.sessions ?? []);
    total += pool.length;
    const kept = keep === undefined ? undefined : (view: SessionView): boolean => keep(machine.daemonId, view);
    const tallies = listTallies(pool, filter, kept);
    counts = {
      all: counts.all + tallies.counts.all,
      auto: counts.auto + tallies.counts.auto,
      interactive: counts.interactive + tallies.counts.interactive,
    };
    hiddenStopped += tallies.hiddenStopped;
    const shown = pool.filter(view => listedBeforeMode(view, filter, kept) && matchesMode(view, filter.mode));
    const moves = actionable(machine.reach) ? shown.filter(needsYou) : [];
    for (const view of moves) pinned.push({ daemonId: machine.daemonId, machineName: machine.name, view, order });
    const stays = moves.length === 0 ? shown : shown.filter(view => !needsYou(view));
    sections.push({
      daemonId: machine.daemonId,
      name: machine.name,
      reach: machine.reach,
      readAt: machine.slice.readAt ?? null,
      total: shown.length,
      needsYou: moves.length,
      groups: groupByProject(stays, machine.projects, sortRows),
      sessions: pool,
      outage: machine.reach === 'offline' ? sectionOutage(machine) : null,
      cachedAt: machine.reach === 'offline' ? null : (machine.slice.cachedAt ?? null),
    });
  });
  pinned.sort(
    (left, right) =>
      needsYouUrgency(left.view) - needsYouUrgency(right.view) ||
      waitingSince(left.view) - waitingSince(right.view) ||
      left.order - right.order ||
      left.view.config.id.localeCompare(right.view.config.id),
  );
  return {
    needsYou: pinned.map(({ order: _order, ...entry }) => entry),
    // A kind other than All shows only the machines it found something on; All shows every machine,
    // so an offline one is still said to be offline.
    machines: filter.mode === 'all' ? sections : sections.filter(section => section.total > 0),
    counts,
    hiddenStopped,
    total,
    loaded,
  };
};

/** A short age: `40s`, `5m`, `3h`, `2d`. */
export const shortAge = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/** What a machine heading says after the name, or nothing for one that is simply online. */
export const machineReachLabel = (section: Pick<MachineSection, 'reach' | 'readAt'>, now: number): string => {
  switch (section.reach) {
    case 'online':
      return '';
    case 'reading':
      return 'reading…';
    case 'locked':
      return 'locked · open it to unlock';
    case 'offline':
      return section.readAt === null ? 'offline' : `offline · last seen ${shortAge(now - section.readAt)}`;
  }
};

/**
 * The machines in the order the list shows them: the order they were paired in, oldest first.
 *
 * NEVER "THE ONE ON SCREEN FIRST". Opening a row on the second machine makes that machine the one on
 * screen; a list that then hoisted it would move every row under the reader's pointer, and the row they
 * just clicked would jump to the top. The order is a fact about the pairings alone, so it holds still
 * whichever machine is open — and it is not the registry's order either, which moves on every select.
 *
 * `saved` is the order the reader dragged them into on this device (`lib/machine-order.ts`): those
 * first, in that order, then any machine it has never seen, in pairing order. Every surface that lists
 * machines goes through here, so they cannot disagree.
 */
export const machineDisplayOrder = <T extends { readonly daemonId: DaemonId; readonly pairedAt: number }>(
  machines: readonly T[],
  saved: readonly string[] = [],
): readonly T[] => {
  const paired = [...machines].sort(
    (left, right) => left.pairedAt - right.pairedAt || left.daemonId.localeCompare(right.daemonId),
  );
  const byId = new Map(paired.map(machine => [machine.daemonId, machine] as const));
  return reconcileMachineOrder(
    paired.map(machine => machine.daemonId),
    saved,
  ).map(id => byId.get(id) as T);
};
