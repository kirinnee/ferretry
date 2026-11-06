import { CAPABILITIES_BEFORE_SHARING, SHARING_REPAIR_ACTOR } from './sharing-follows-pairing.ts';
import {
  type FollowsPairingDeps,
  type FollowsPairingOutcome,
  type FollowsPairingSpec,
  repairCapabilityFromPairing,
} from './follows-pairing.ts';

/**
 * VOICE FOR AN OLD FULL DEVICE, once (docs/grants.md, "Capability nine was added: `voice`"; owner decision D5 (a),
 * docs/design/voice-modes.md §10: existing devices get voice once, only those already holding every other capability).
 *
 * Exactly Sharing's repair (`sharing-follows-pairing.ts`) for the ninth capability; the rule is shared in
 * `follows-pairing.ts`. What is specific to Voice:
 *
 * - a device qualifies only when it holds the EIGHT capabilities before Voice — Sharing included — fully on;
 * - it RUNS AFTER the Sharing repair in the same boot, so a device from before Sharing ends with both. The Sharing
 *   repair's own journal record names the device at a time after Voice shipped; it is the daemon's, not a person's
 *   decision, so it is an ignored actor here and does not stop the Voice repair.
 */
export const VOICE_REPAIR_ACTOR = 'daemon:voice-follows-pairing';

/**
 * When the `voice` capability's work began, the earliest instant a journal record could have been made knowing it.
 *
 * AN EARLY BOUND IS THE SAFE ERROR: a record between this and the real release only withholds Voice from that device,
 * which the owner turns on with `fy device grant <device> voice --use --configure`; a late bound could widen a device
 * somebody had already decided about. Tighten it to the release instant when the first build that carries `voice` is
 * cut, as Sharing's was.
 */
export const VOICE_RELEASED_AT = '2026-11-05T00:00:00.000Z';

/** The most journal this repair reads. Past it, nothing is repaired: a widening never rests on a guess. */
export const VOICE_REPAIR_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/** The capabilities that existed before Voice: the seven before Sharing, then Sharing. Named, never derived. */
export const CAPABILITIES_BEFORE_VOICE = [...CAPABILITIES_BEFORE_SHARING, 'sharing'] as const;

const VOICE_SPEC: FollowsPairingSpec = {
  capability: 'voice',
  heldBefore: CAPABILITIES_BEFORE_VOICE,
  actor: VOICE_REPAIR_ACTOR,
  releasedAt: VOICE_RELEASED_AT,
  ignoredActors: [SHARING_REPAIR_ACTOR],
  journalMaxBytes: VOICE_REPAIR_JOURNAL_MAX_BYTES,
};

export type VoiceRepairDeps = FollowsPairingDeps;
export type VoiceRepairOutcome = FollowsPairingOutcome;

/**
 * Turns Voice on for every old full device nobody decided about, recording each change. Run once at boot, after the
 * Sharing repair: the daemon's `start` runs them in that order.
 */
export async function repairVoiceFromPairing(deps: VoiceRepairDeps): Promise<VoiceRepairOutcome> {
  return await repairCapabilityFromPairing(VOICE_SPEC, deps);
}
