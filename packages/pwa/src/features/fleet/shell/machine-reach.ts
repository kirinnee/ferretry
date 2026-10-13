/**
 * Whether a paired machine answers, and what it says about itself (docs/design/account-model.md §4.2).
 *
 * The switcher's "Online / Offline" and "n runtimes / Not set up yet" come from ONE read,
 * `GET /v1/fleet/machine`, made through the app's client pool so it rides the same carrier as every
 * other call. There is no separate ping: an answer is the proof it is awake. A machine that answers
 * with a refusal (an older daemon with no account model, a limit on this device) is reachable, and is
 * shown as such with the reason, rather than being called offline.
 */

import type { FleetMachineView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { readFleetMachine } from '../catalog-api.ts';
import type { FleetClient } from '../fleet-api.ts';

export type MachineReach =
  | { readonly kind: 'checking' }
  | { readonly kind: 'online'; readonly machine: FleetMachineView }
  /** It answered, but not with its setup. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'offline' };

/** One read; never throws. */
export const readMachineReach = async (client: () => Promise<FleetClient>): Promise<MachineReach> => {
  try {
    return { kind: 'online', machine: await readFleetMachine(await client()) };
  } catch (error) {
    if (error instanceof FyHttpError)
      return {
        kind: 'unreadable',
        reason:
          error.status === 404
            ? 'This machine runs an older Ferretry that cannot show its setup here yet.'
            : `This machine answered but did not share its setup: ${error.message}`,
      };
    return { kind: 'offline' };
  }
};

/** The one-line summary under a machine's name on the Machines list. */
export const machineReachSummary = (reach: MachineReach): string => {
  switch (reach.kind) {
    case 'checking':
      return 'Checking';
    case 'offline':
      return 'Offline';
    case 'unreadable':
      return 'Online · Setup not shown';
    case 'online':
      return reach.machine.setUp
        ? `Online · ${reach.machine.runtimeCount} ${reach.machine.runtimeCount === 1 ? 'runtime' : 'runtimes'}`
        : 'Online · Not set up yet';
  }
};
