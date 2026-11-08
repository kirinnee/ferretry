/**
 * THE DEVICE'S AGENDA, over every machine (shell contract S2, m9): ONE agenda client and store shared by every machine's
 * runtime, each call routed to the client of the machine it is for. The Inbox counts and deals every machine's items
 * from it, a machine's own pages read the same store, so an answer still inside its undo window survives a navigation
 * from the Inbox to that machine's ask page — and each machine is read once, whichever view asks.
 *
 * One fleet is made per app half (`../index.ts`) and handed to its views and its device view by construction; it keeps
 * no state beyond that per-half holder (a WeakMap keyed by it, one per bundle).
 */

import { type AgendaCall, DaemonResponseError } from './agenda-call.ts';
import { DaemonAgendaClient } from './agenda-client.ts';
import { type AgendaRuntime, createAgendaRuntime, type RuntimeClient } from './agenda-runtime.ts';
import { DaemonAgendaStore } from './agenda-store.ts';
import type { DaemonFleetStore, FleetMachine, FleetSnapshot } from './ferret-store.ts';
import type { DaemonConnection, DaemonId } from './machine.ts';

/** What a call to a machine this device holds no client for answers. */
const UNREACHABLE: AgendaCall = {
  call: async () => {
    throw new DaemonResponseError(0, 'This machine is not reachable from this device right now.');
  },
};

export class AgendaFleet {
  readonly #clients = new Map<DaemonId, AgendaCall>();
  readonly #runtimes = new WeakMap<object, AgendaRuntime>();
  /** The one agenda client every machine's runtime counts and answers through. */
  readonly agenda = new DaemonAgendaClient(new DaemonAgendaStore(), daemon => this.#clientFor(daemon));

  /**
   * The ONE runtime of a machine's client: its pages, its panels, the Inbox and the device view share it. The shell
   * hands the same client object for the connection's life, so a reconnect keeps the runtime; a new client for the
   * same machine (it was paired again) takes over its calls, and that machine's old items are dropped.
   */
  runtimeOf(client: RuntimeClient): AgendaRuntime {
    const known = this.#runtimes.get(client);
    if (known !== undefined) return known;
    const runtime = createAgendaRuntime(client, this.agenda);
    this.#runtimes.set(client, runtime);
    const id = runtime.connection.daemonId;
    // A new client for a machine already known is a new pairing: what the old one read is not this one's.
    if (this.#clients.has(id)) this.agenda.clearDaemon(id);
    this.#clients.set(id, client);
    return runtime;
  }

  #clientFor(daemon: DaemonConnection): AgendaCall {
    return this.#clients.get(daemon.daemonId) ?? UNREACHABLE;
  }
}

/** The fleet held for a holder object (the half's own), made on first use. */
const FLEETS = new WeakMap<object, AgendaFleet>();
export const fleetIn = (holder: object): AgendaFleet => {
  const known = FLEETS.get(holder);
  if (known !== undefined) return known;
  const fleet = new AgendaFleet();
  FLEETS.set(holder, fleet);
  return fleet;
};

/**
 * Several machines' ferret stores read as one store: what the Inbox subscribes to. The snapshot is the same object
 * while no machine's moved, so the Inbox re-renders only when one did.
 */
export function mergedFleet(stores: readonly DaemonFleetStore[]): DaemonFleetStore {
  let parts: readonly FleetSnapshot[] = [];
  let merged: FleetSnapshot = { daemons: new Map() };
  return {
    subscribe: listener => {
      const stops = stores.map(store => store.subscribe(listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    getSnapshot: () => {
      const next = stores.map(store => store.getSnapshot());
      if (next.length === parts.length && next.every((snapshot, i) => snapshot === parts[i])) return merged;
      parts = next;
      const daemons = new Map<DaemonId, FleetMachine>();
      for (const snapshot of next) for (const [id, machine] of snapshot.daemons) daemons.set(id, machine);
      merged = { daemons };
      return merged;
    },
  };
}
