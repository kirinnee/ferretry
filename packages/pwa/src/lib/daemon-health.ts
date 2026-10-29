/**
 * WHAT THE MACHINE SAYS IT CAN DO (`GET /v1/health` › `features`), read as a pure value.
 *
 * The app deploys from `main` the moment a change merges and a machine changes only after the release
 * cut and `fy daemon update`, so a new app routinely talks to an older daemon. A change that raises a
 * limit or adds a request field therefore reads the machine's feature list first and keeps the older
 * behaviour when the name is absent (`packages/protocol/src/lib/daemon-features.ts`,
 * `docs/standards/architecture/index.md` § 'The app ships before the daemon').
 *
 * A read that has not finished, or that failed, offers NOTHING and says nothing: the app cannot tell
 * an old machine from a slow one, so it keeps the older behaviour without telling anyone to update.
 * `use-daemon-health.ts` is the hook that makes the read.
 */

import {
  type DaemonFeature,
  describeDiskSaturation,
  type HealthView,
  hasFeature,
  type IoPressureView,
} from '@ferretry/protocol';

export type DaemonHealthRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'read'; readonly health: HealthView }
  | { readonly kind: 'failed' };

/** `true` only when the machine answered and listed the feature. */
export const machineOffers = (read: DaemonHealthRead, feature: DaemonFeature): boolean =>
  read.kind === 'read' && hasFeature(read.health, feature);

/** `true` when the machine answered and did NOT list the feature — the one case worth telling an owner to update. */
export const machineLacks = (read: DaemonHealthRead, feature: DaemonFeature): boolean =>
  read.kind === 'read' && !hasFeature(read.health, feature);

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
