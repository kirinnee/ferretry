/**
 * Where a machine that is NOT set up sends the person: straight into its first run
 * (docs/design/account-model.md §4.3).
 *
 * Starting a daemon imports nothing, so a fresh machine has no runtime until somebody chooses. The app
 * asks on the screen rather than leaving a button to be found: right after pairing succeeds, and
 * whenever Settings › Machines opens on a machine that is not set up (`machines-surface.tsx`).
 *
 * ONE READ, AND IT FAILS OPEN. The machine's own `GET /v1/fleet/machine` decides; a machine that could
 * not answer, or answered with a refusal, lands where it always did — its sessions — because a guess
 * that sent a working machine into setup would be worse than a first run the Machines page still offers.
 */

import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import type { DaemonId } from '../../../lib/daemon-connection.ts';
import { daemonSessionsPath, daemonSettingsPath } from '../../../lib/pages/routes.ts';
import { daemonDisplayName } from '../../settings/daemon-settings.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { readMachineReach } from '../shell/machine-reach.ts';
import { machineItemHash } from './settings-route.ts';

/** The first run's address on one machine: `/d/<id>/settings#machines/<name>/settings/setup`. */
export const firstRunPath = (daemonId: DaemonId, machineName: string): string =>
  `${daemonSettingsPath(daemonId)}${machineItemHash(machineName, 'settings', 'setup')}`;

/** Where a browser that just paired with `connection` goes next. Never throws. */
export const landingAfterPairing = async (
  connection: DaemonConnectionRecord,
  createClient: FleetClientFactory,
): Promise<string> => {
  const reach = await readMachineReach(() => createClient(connection));
  return reach.kind === 'online' && reach.machine.setUp === false
    ? firstRunPath(connection.daemonId, daemonDisplayName(connection))
    : daemonSessionsPath(connection.daemonId);
};
