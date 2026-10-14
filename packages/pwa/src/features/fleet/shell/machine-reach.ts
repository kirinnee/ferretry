/**
 * Whether a paired machine answers, and what it says about itself (docs/design/account-model.md §4.2).
 *
 * The switcher's "Online / Offline" and "n runtimes / Not set up yet" come from ONE read,
 * `GET /v1/fleet/machine`, made through the app's client pool so it rides the same carrier as every
 * other call. There is no separate ping: an answer is the proof it is awake. A machine that answers
 * with a refusal (an older daemon with no account model, a limit on this device) is reachable, and is
 * shown as such with the reason, rather than being called offline.
 */

import type { FleetCredentialStatusWord, FleetMachineView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { readFleetMachine } from '../catalog-api.ts';
import type { FleetClient } from '../fleet-client.ts';

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

/**
 * What a row shows: the machine's answer, or LOCKED — it wants a passkey before it says anything, and its
 * prompt waits until it is on screen. Locked is the gate's fact, never the read's.
 */
export type ShownReach = MachineReach | { readonly kind: 'locked' };

/** The status line under a machine's name wherever machines are listed. */
export const shownReachSummary = (reach: ShownReach): string =>
  reach.kind === 'locked' ? 'Locked · Open it to unlock' : machineReachSummary(reach);

const REACH_WORDS: Readonly<Record<ShownReach['kind'], FleetCredentialStatusWord>> = {
  checking: 'checking',
  offline: 'needs_sign_in',
  locked: 'refresh_due',
  online: 'ready',
  unreadable: 'ready',
};

/** The status mark a machine wears: the account model's four shapes, reused for reachability. */
export const reachWord = (reach: ShownReach): FleetCredentialStatusWord => REACH_WORDS[reach.kind];

const REACH_LABELS: Readonly<Record<ShownReach['kind'], string>> = {
  checking: 'Checking',
  offline: 'Offline',
  locked: 'Locked',
  online: 'Online',
  unreadable: 'Online',
};

export const reachLabel = (reach: ShownReach): string => REACH_LABELS[reach.kind];
