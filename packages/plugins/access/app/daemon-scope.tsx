/**
 * WHICH MACHINE AN ACCESS VIEW IS ABOUT, AND HOW IT READS IT. A half is built once per machine against that machine's
 * own client (`@ferretry/app` records the machine of every client it hands out), so a view built here can only reach
 * the machine it was built for. Every daemon call goes through that client by route key — no fetch, no store.
 */
import { daemonOfClient, type PairedDaemon, usePairedDaemons } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import type { PairingClient } from './features/settings/add-device-api.ts';
import { routeRequestClient } from './lib/route-request.ts';
import { type DaemonConnectionRecord, daemonConnection } from './shell-pairing.ts';

/** Access's own routes with parameters, as written in its manifest, for `routeRequestClient` to match literal paths. */
export const ACCESS_ROUTE_KEYS: readonly string[] = manifest.actions.routes.map(declared => declared.key);

/** Today's `request(path, schema, init)` over this machine's Access client. */
export const pairingClientOf = (client: Pick<PluginClient, 'call'>): PairingClient =>
  routeRequestClient(client, ACCESS_ROUTE_KEYS);

/** A paired daemon as the pairing views take it. */
export const connectionRecord = (paired: PairedDaemon): DaemonConnectionRecord => ({
  ...daemonConnection({
    daemonId: paired.daemon,
    baseUrl: paired.address,
    deviceId: paired.deviceId,
    daemonName: paired.machine,
  }),
  ...(paired.label === undefined ? {} : { label: paired.label }),
  pairedAt: paired.pairedAt,
  lastSelectedAt: paired.lastSelectedAt,
});

/** The machine `client` talks to, as a connection record; `undefined` for a client the shell did not make. */
export function useMachineOf(client: PluginClient): DaemonConnectionRecord | undefined {
  const id = daemonOfClient(client);
  const paired = usePairedDaemons().find(candidate => candidate.daemon === id);
  return paired === undefined ? undefined : connectionRecord(paired);
}
