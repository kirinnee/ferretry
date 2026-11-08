/**
 * The factories a Warden view provides: the client of the daemon the view is on is the one this half was handed, and
 * any other paired daemon's is the Warden's own row there (`useEveryDaemon` in `@ferretry/app`).
 */

import type { NoReach } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import type { DaemonConnection } from './machine.ts';
import { wardenClientOf } from './warden-client.ts';
import type { DaemonReach, WardenClientFactory } from './warden-client-context.tsx';

/** What a read of a machine with no Warden row says: not paired here, not connected yet, or the Warden is off there. */
const NO_REACH_SENTENCE = 'This device cannot reach the Warden on that machine yet.';

/** How long a read of another machine waits for its row (connecting, or its plugin list being read). */
const ROW_WAIT_MS = 15_000;
const ROW_POLL_MS = 100;

/** The live row clients (a getter, so a wait sees a row that arrives), and the shell's reason a machine has none. */
export interface RowSource {
  readonly clients: () => ReadonlyMap<string, PluginClient>;
  readonly whyNone?: (daemon: string) => NoReach | undefined;
  readonly waitMs?: number;
}

const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The Warden's client on any paired daemon: this half's own for the daemon it was built for, its row's otherwise. A
 * machine that is still being reached or read is WAITED for (bounded); one that is off, paused or not paired says the
 * machine's own sentence at once.
 */
export const daemonReach =
  (home: DaemonConnection, client: PluginClient, others: ReadonlyMap<string, PluginClient> | RowSource): DaemonReach =>
  async connection => {
    if (connection.daemonId === home.daemonId) return client;
    const source: RowSource = 'clients' in others ? others : { clients: () => others };
    const deadline = Date.now() + (source.waitMs ?? ROW_WAIT_MS);
    for (;;) {
      const row = source.clients().get(connection.daemonId);
      if (row !== undefined) return row;
      const why = source.whyNone?.(connection.daemonId);
      if (why !== undefined && !why.waiting) throw new Error(why.line);
      if (why === undefined || Date.now() >= deadline) throw new Error(why?.line ?? NO_REACH_SENTENCE);
      await pause(ROW_POLL_MS);
    }
  };

export const wardenClientFactory =
  (reach: DaemonReach): WardenClientFactory =>
  async connection =>
    wardenClientOf(await reach(connection));

/** The Warden's client of the one daemon a panel is built for: a panel reads no other daemon. */
export const homeClientFactory =
  (client: PluginClient): WardenClientFactory =>
  async () =>
    wardenClientOf(client);
