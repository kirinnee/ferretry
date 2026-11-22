import { ApiError, jsonResponse, type PlainApiResponse } from '@ferretry/kernel/contract';
import { coverAct, markProofClaimed } from './claimed-standings.ts';
import type { OwnerOnlyCall } from './owner-only.ts';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from './policy.ts';
import { isFerretCall } from './standing.ts';

/** An open loosening act: `end` closes it (always, in a `finally`). */
export interface LooseningAct {
  /** Whether a governed caller's proof covers the act (`false` at the machine, where nothing is claimed). */
  readonly covered: boolean;
  end(): void;
}

/** The act could not open: what the caller is answered, before anything was written. */
export interface LooseningActRefused {
  readonly refused: PlainApiResponse;
}

/**
 * ONE request that writes several owners' files as ONE act — the first-run import and the clone — confirmed by ONE
 * passkey proof (docs/config-files.md rule 4, docs/grants.md).
 *
 * Gate's config judge spends a proof on the first loosening it lets through, so a request that writes two loosening
 * files (an import's settings, then Runtimes' set with a new instructions item) was held part-way: the first owner's
 * file landed and the rest was thrown. This claims the proof UP FRONT, before the act writes anything, and while the
 * act is open every loosening of THIS request rides on that one claim; `end` closes it, so nothing the request spawns
 * later rides on it.
 *
 * - A ferret is refused outright (an agent never confirms a loosening).
 * - Somebody at the machine (`governed: false`) claims nothing: the judge lets their loosening through anyway.
 * - A governed caller without a fresh proof PROVED FOR `loosen-config` that already existed at admission (a proof for
 *   another act, or for none, is not one) is answered
 *   `403 grant_step_up_required` with the `loosen-config` act BEFORE anything is written, so the carrier asks for the
 *   passkey and sends the same request again. An unlock alone is never a fresh proof.
 *
 * Fail closed: a governed standing with no claim function is refused. One proof is one act: an act that then fails has
 * used the proof up, as {@link claimOwnerOnly}'s does.
 */
export function openLooseningAct(call: OwnerOnlyCall, act: string): LooseningAct | LooseningActRefused {
  if (isFerretCall(call)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
  if (call.governance?.governed !== true) return { covered: false, end: () => undefined };
  const claim = call.claimFreshStepUp;
  // The NAMED proof: a passkey proved for another act (or for none) never confirms an import (Access takes a stamped proof
  // only for the act it names; an unstamped claim would take any).
  if (claim?.(STEP_UP_ACTS.loosenConfig) !== true)
    return {
      refused: jsonResponse(
        {
          error: `to ${act} from this device, confirm with a passkey: it changes settings that need your OK, and one passkey covers all of it`,
          code: STEP_UP_REQUIRED_CODE,
          demand: { capability: 'fleet', axis: 'configure', act: STEP_UP_ACTS.loosenConfig },
        } satisfies StepUpRequiredBody,
        403,
      ),
    };
  markProofClaimed(claim);
  return { covered: true, end: coverAct(claim) };
}
