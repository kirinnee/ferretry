/**
 * WHAT THE MACHINE'S HEALTH READ SAYS (`GET /v1/health`), read as a pure value.
 *
 * Every machine this app pairs with is the same release, so no feature is looked up before it is used.
 * The read is kept for the disk-pressure note below. `use-daemon-health.ts` is the hook that makes it.
 */

import { describeDiskSaturation, type IoPressureView } from '@ferretry/protocol';
import { type HealthView } from '@ferretry/app';

export type DaemonHealthRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly health: HealthView }
  | { readonly kind: 'failed' };

/**
 * THE DISK PRESSURE TO TELL THE OWNER ABOUT, or `undefined` when there is none worth saying.
 *
 * A machine whose disk is saturated is slow, and a slow machine is the one whose next health read times
 * out — so a failed or unfinished read keeps what the last answer said instead of clearing it, and the
 * owner keeps being told "slow, not dead" through exactly the stretch when the machine cannot speak for
 * itself. An answer that arrived settles it either way: saturated, or not.
 */
export const diskPressureOf = (
  read: DaemonHealthRead,
  previous: IoPressureView | undefined,
): IoPressureView | undefined => {
  if (read.kind !== 'read') return previous;
  return read.health.io?.saturated === true ? read.health.io : undefined;
};

/** The sentence a person is told, capitalised for the start of a line: "Disk is saturated (…) — the daemon is slow, not dead". */
export const diskPressureSentence = (io: IoPressureView): string => {
  const sentence = describeDiskSaturation(io);
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
};
