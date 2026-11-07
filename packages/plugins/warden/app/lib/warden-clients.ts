/**
 * The factories a Warden view provides: the client of the daemon the view is on is the one this half was handed, and
 * any other paired daemon's comes from the shell (`useDaemonClients('warden')`).
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import type { DaemonConnection } from './machine.ts';
import { wardenClientOf } from './warden-client.ts';
import type { DaemonReach, WardenClientFactory } from './warden-client-context.tsx';

/** The Warden's client on any paired daemon: this half's own for the daemon it was built for, the shell's otherwise. */
export const daemonReach =
  (
    home: DaemonConnection,
    client: PluginClient,
    otherDaemon: (daemonId: string) => Promise<PluginClient>,
  ): DaemonReach =>
  async connection =>
    connection.daemonId === home.daemonId ? client : await otherDaemon(connection.daemonId);

export const wardenClientFactory =
  (reach: DaemonReach): WardenClientFactory =>
  async connection =>
    wardenClientOf(await reach(connection));

/** The Warden's client of the one daemon a panel is built for: a panel reads no other daemon. */
export const homeClientFactory =
  (client: PluginClient): WardenClientFactory =>
  async () =>
    wardenClientOf(client);
