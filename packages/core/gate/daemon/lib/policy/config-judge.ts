import type { CallStanding, ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { proofClaimed } from '../../../contract/claimed-standings.ts';
import { CAPABILITIES, isFerretCall } from '../../../contract/index.ts';

/** The file whose own capability is `warden`; every other config file is the fleet's (today's `configFileCapability`). */
const WARDEN_FILE = 'warden.yaml';

/**
 * The proofs a loosening already spent, keyed by the standing AND its claim function: a second loosening on the same
 * call holds, whichever object (the standing, or a `{ ...standing }` copy sharing its one claim) carries it.
 */
const spent = new WeakSet<object>();

/**
 * Gate's judge of a plugin's OWN loosening config write (`Admission.judgeConfigWrite`, today's held-loosening rule,
 * `PUT /v1/config/file`): a loosening is put into effect only when THIS CALL could confirm it in the same act;
 * otherwise it is written and HELD for the owner, the tighter version in effect. An absent or throwing judge holds it
 * too (the kernel's side).
 *
 * The caller must be a person (an agent, a warden and a job never confirm), hold the `configure` grant of the file's
 * own capability and the fleet's `use` grant, and then either be at this machine (`governance.governed === false`:
 * the admin token that arrived on the host) or hold a step-up proved for the act, which this loosening CLAIMS at
 * judge time (one proof, one act). The claim is atomic (Access's `claimFresh`), so the admission snapshot's
 * `freshStepUp` is never read: of two requests admitted on ONE proof — whatever their acts — exactly one takes it.
 * A standing whose proof an owner-only act (`claimOwnerOnly`) already claimed for THIS request is accepted without
 * a second claim, once: that claim is the act's own, and its loosening write rides on it.
 * Anything undetermined (no standing, no grant standing, a missing claim) holds.
 */
/**
 * Takes the call's one fresh passkey proof for a loosening, atomically: of two requests admitted on ONE proof exactly
 * one gets `true`. A standing that already used its proof (here, or an owner-only act) gets `false`; a standing
 * whose proof an owner-only act claimed for THIS request is accepted once without a second claim.
 */
export function claimLooseningProof(standing: CallStanding): boolean {
  if (spent.has(standing) || (standing.claimFreshStepUp !== undefined && spent.has(standing.claimFreshStepUp)))
    return false;
  if (!proofClaimed(standing.claimFreshStepUp) && standing.claimFreshStepUp?.() !== true) return false;
  spent.add(standing);
  if (standing.claimFreshStepUp !== undefined) spent.add(standing.claimFreshStepUp);
  return true;
}

/**
 * Whether the call in progress IS the owner, for a `${secret:NAME}` reference an edit adds (`ConfigPort.writeAsCaller`,
 * NN2): the host admin where the request ARRIVED on the host (`governance.governed === false`, decided from the carrier,
 * so a relayed loopback is governed), or a governed device whose grants hold the file's `configure` capability and the
 * fleet's `use` right now. The grant layer's `configure` decision already needs the device UNLOCKED (the passkey
 * unlock stands for the step-up), so a locked device is refused there. It claims NO step-up proof: this is not a
 * loosening to confirm, it is who is asking. A ferret, a warden, a job (no standing) and anything undetermined hold.
 */
export function judgeOwnerSecretAdd(input: ConfigWriteJudgement): 'apply' | 'hold' {
  if (input.actor === 'ferret' || input.actor === 'warden') return 'hold';
  const standing = input.standing;
  if (standing === undefined) return 'hold';
  if (isFerretCall(standing) || standing.wardenRemedy !== undefined) return 'hold';
  const governance = standing.governance;
  if (governance === undefined) return 'hold';
  const capability = input.path === WARDEN_FILE ? CAPABILITIES.warden : CAPABILITIES.fleet;
  if (!governance.decide({ capability, axis: 'configure' }).allowed) return 'hold';
  if (!governance.decide({ capability: CAPABILITIES.fleet, axis: 'use' }).allowed) return 'hold';
  return 'apply';
}

export function judgeLooseningWrite(input: ConfigWriteJudgement): 'apply' | 'hold' {
  if (input.secretAdd === true) return judgeOwnerSecretAdd(input);
  if (input.actor === 'ferret' || input.actor === 'warden') return 'hold';
  const standing = input.standing;
  if (standing === undefined) return 'hold';
  if (isFerretCall(standing) || standing.wardenRemedy !== undefined) return 'hold';
  const governance = standing.governance;
  if (governance === undefined) return 'hold';
  const capability = input.path === WARDEN_FILE ? CAPABILITIES.warden : CAPABILITIES.fleet;
  if (!governance.decide({ capability, axis: 'configure' }).allowed) return 'hold';
  if (!governance.decide({ capability: CAPABILITIES.fleet, axis: 'use' }).allowed) return 'hold';
  if (!governance.governed) return 'apply';
  return claimLooseningProof(standing) ? 'apply' : 'hold';
}
