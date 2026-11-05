import {
  type FollowsPairingDeps,
  type FollowsPairingDevices,
  type FollowsPairingJournal,
  type FollowsPairingOutcome,
  type FollowsPairingSpec,
  repairCapabilityFromPairing,
} from './follows-pairing.ts';

/**
 * SHARING FOR AN OLD FULL DEVICE, once (docs/grants.md, "Capability eight was added: `sharing`"; owner decision
 * 2026-10-31: catalog sharing must start without a command at the machine).
 *
 * The rule — which devices, which refusals, how it is recorded — lives in `follows-pairing.ts` and is shared with the
 * Voice repair. THIS FILE OWNS ONLY WHAT IS SPECIFIC TO SHARING:
 *
 * - the seven capabilities that existed before it, NAMED. "Every capability but Sharing" is not the same sentence
 *   once a ninth capability exists: it would then demand `voice` too, which an upgrading device never had, and this
 *   repair would silently stop firing. Pinning the set keeps a pre-Sharing device repairable by a build that has
 *   `voice`; the Voice repair then runs after it (`voice-follows-pairing.ts`).
 * - the instant Sharing shipped, and the actor its repair is recorded under.
 */
export const SHARING_REPAIR_ACTOR = 'daemon:sharing-follows-pairing';

/** When the `sharing` capability shipped (#1171, released in v4.177.0): changes from here on saw it. */
export const SHARING_RELEASED_AT = '2026-10-31T15:54:08.000Z';

/** The most journal this repair reads. Past it, nothing is repaired: a widening never rests on a guess. */
export const SHARING_REPAIR_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The capabilities that existed before Sharing, and so the ones an old full device held. Named, and never derived
 * from `DAEMON_CAPABILITIES`, which grows.
 */
export const CAPABILITIES_BEFORE_SHARING = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
] as const;

const SHARING_SPEC: FollowsPairingSpec = {
  capability: 'sharing',
  heldBefore: CAPABILITIES_BEFORE_SHARING,
  actor: SHARING_REPAIR_ACTOR,
  releasedAt: SHARING_RELEASED_AT,
  journalMaxBytes: SHARING_REPAIR_JOURNAL_MAX_BYTES,
};

export type SharingRepairDevices = FollowsPairingDevices;
export type SharingRepairJournal = FollowsPairingJournal;
export type SharingRepairDeps = FollowsPairingDeps;
export type SharingRepairOutcome = FollowsPairingOutcome;

/**
 * Turns Sharing on for every old full device nobody decided about, recording each change. Run once at boot, after
 * pairing opens and before devices are served, and BEFORE the Voice repair.
 */
export async function repairSharingFromPairing(deps: SharingRepairDeps): Promise<SharingRepairOutcome> {
  return await repairCapabilityFromPairing(SHARING_SPEC, deps);
}
