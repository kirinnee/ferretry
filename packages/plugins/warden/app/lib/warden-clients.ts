/**
 * The factories a Warden view provides: the client of the daemon the view is on is the one this half was handed, and
 * any other paired daemon's is the Warden's own row there (`useEveryDaemon` in `@ferretry/app`).
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import type { DaemonConnection } from './machine.ts';
import { wardenClientOf } from './warden-client.ts';
import type { DaemonReach, WardenClientFactory } from './warden-client-context.tsx';

/** What a read of a machine with no Warden row says: not paired here, not connected yet, or the Warden is off there. */
const NO_REACH_SENTENCE = 'This device cannot reach the Warden on that machine yet.';

/** The Warden's client on any paired daemon: this half's own for the daemon it was built for, its row's otherwise. */
export const daemonReach =
  (home: DaemonConnection, client: PluginClient, others: ReadonlyMap<string, PluginClient>): DaemonReach =>
  async connection => {
    if (connection.daemonId === home.daemonId) return client;
    const other = others.get(connection.daemonId);
    if (other === undefined) throw new Error(NO_REACH_SENTENCE);
    return other;
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
