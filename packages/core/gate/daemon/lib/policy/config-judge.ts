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
 * the admin token that arrived on the host) or hold a passkey proof that already existed when its call was admitted,
 * which this loosening CLAIMS at judge time (claimed once). A proof made AFTER the admission is never taken, by the
 * call or by work it spawns, however long after: the loosening is then held and that proof stays for its own act.
 * The claim is atomic (Access's `claimFresh`), so the admission snapshot's
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
 * Whether the call in progress may put a `${secret:NAME}` reference its edit adds into effect
 * (`ConfigPort.writeAsCaller`, NN2): the SAME rule `PUT /v1/config/file` applies to an add (Appendix D G129, G131) and
 * to any other loosening — the host admin where the request ARRIVED on the host (`governance.governed === false`,
 * decided from the carrier, so a relayed loopback is governed), or a governed device that holds the file's
 * `configure` capability and the fleet's `use` AND a passkey that already existed when its call was admitted
 * (`loosen-config`), which the add CLAIMS once (claimed once, bounded by the admission instant: a passkey proved after
 * it is never taken by the call or its continuations, even after a lock and an unlock). The unlock alone is not
 * enough. When the owner asks a step-up per act
 * (`stepUpOnActions`, G79) the step-up that admitted the configure decision is spent by the add, so one step-up buys
 * one act. A ferret, a warden, a job (no standing) and anything undetermined hold. The question is SYNCHRONOUS (a
 * kernel judge that cannot answer in time is not a thing: there is nothing to time out), and it is asked of the LIVE
 * standing (`GateAdmission.judgeConfigWrite`), so a device revoked or locked since admission holds.
 */
export function judgeOwnerSecretAdd(input: ConfigWriteJudgement): 'apply' | 'hold' {
  return judgeConfirmingCaller(input, true);
}

export function judgeLooseningWrite(input: ConfigWriteJudgement): 'apply' | 'hold' {
  return judgeConfirmingCaller(input, input.secretAdd === true);
}

function judgeConfirmingCaller(input: ConfigWriteJudgement, secretAdd: boolean): 'apply' | 'hold' {
  if (input.actor === 'ferret' || input.actor === 'warden') return 'hold';
  const standing = input.standing;
  if (standing === undefined) return 'hold';
  if (isFerretCall(standing) || standing.wardenRemedy !== undefined) return 'hold';
  const governance = standing.governance;
  if (governance === undefined) return 'hold';
  const capability = input.path === WARDEN_FILE ? CAPABILITIES.warden : CAPABILITIES.fleet;
  const configure = governance.decide({ capability, axis: 'configure' });
  if (!configure.allowed) return 'hold';
  if (!governance.decide({ capability: CAPABILITIES.fleet, axis: 'use' }).allowed) return 'hold';
  if (!governance.governed) return 'apply';
  if (!claimLooseningProof(standing)) return 'hold';
  // A secret add rides no route that spent the step-up at admission, so it spends it here (`G79`): one act, one step-up.
  if (secretAdd && configure.steppedUp === true) standing.spendStepUp?.();
  return 'apply';
}
