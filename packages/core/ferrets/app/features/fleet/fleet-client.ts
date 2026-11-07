/**
 * The one client shape every account-model surface talks to a machine through.
 *
 * A fleet belongs to a MACHINE, and this browser can be paired to several, so nothing is cached at
 * module scope: every call takes a connection-bound client, and a surface is handed a factory that
 * makes one for the machine it is showing.
 */

import type { IFyApiClient } from '@ferretry/protocol';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';

/**
 * The client capability the fleet surfaces use: requests, and — where the client offers it — moving a
 * session to another runtime, which removing a runtime offers for the ferrets still on it. A client
 * without `migrate` simply does not offer that move.
 */
export type FleetClient = Pick<IFyApiClient, 'request'> & Partial<Pick<IFyApiClient, 'migrate'>>;

/** Makes a client bound to one paired machine. */
export type FleetClientFactory = (connection: DaemonConnection) => Promise<FleetClient>;
