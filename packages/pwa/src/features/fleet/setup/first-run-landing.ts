/**
 * Where a machine that is NOT set up sends the person: straight into its full-screen first run
 * (docs/design/account-model.md §4.3; the approved usability proposal).
 *
 * Starting a daemon imports nothing, so a fresh machine has no runtime until somebody chooses. The app
 * asks on the screen rather than leaving a button to be found: right after pairing succeeds it opens
 * "Set up ‹machine›" (`/d/<id>/setup`), a screen of its own outside Settings. Pairing another phone to
 * a machine that is already set up skips it, and Settings keeps a "Finish setting up" banner for a
 * machine whose setup was left for later.
 *
 * ONE READ, AND IT FAILS OPEN. The machine's own `GET /v1/fleet/machine` decides; a machine that could
 * not answer, or answered with a refusal, lands where it always did — its sessions — because a guess
 * that sent a working machine into setup would be worse than a first run Settings still offers.
 */

import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { daemonMachineSetupPath, daemonHomePath } from '../../../lib/pages/routes.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { readMachineReach } from '../shell/machine-reach.ts';

/** Where a browser that just paired with `connection` goes next. Never throws. */
export const landingAfterPairing = async (
  connection: DaemonConnectionRecord,
  createClient: FleetClientFactory,
): Promise<string> => {
  const reach = await readMachineReach(() => createClient(connection));
  return reach.kind === 'online' && reach.machine.setUp === false
    ? daemonMachineSetupPath(connection.daemonId)
    : daemonHomePath(connection.daemonId);
};
