import type { ConfigWriteJudgement } from '@ferretry/kernel/contract';
import { CAPABILITIES, isFerretCall } from '../../../contract/index.ts';

/** The file whose own capability is `warden`; every other config file is the fleet's (today's `configFileCapability`). */
const WARDEN_FILE = 'warden.yaml';

/** The calls whose one fresh proof a loosening already spent: a second loosening in the same call holds. */
const spent = new WeakSet<object>();

/**
 * Gate's judge of a plugin's OWN loosening config write (`Admission.judgeConfigWrite`, today's held-loosening rule,
 * `PUT /v1/config/file`): a loosening is put into effect only when THIS CALL could confirm it in the same act;
 * otherwise it is written and HELD for the owner, the tighter version in effect. An absent or throwing judge holds it
 * too (the kernel's side).
 *
 * The caller must be a person (an agent, a warden and a job never confirm), hold the `configure` grant of the file's
 * own capability and the fleet's `use` grant, and then either be at this machine (`governance.governed === false`:
 * the admin token that arrived on the host) or hold a step-up proved for the act, which this loosening spends (one
 * proof, one loosening). Anything undetermined (no standing, no grant standing, a missing spend) holds.
 */
export function judgeLooseningWrite(input: ConfigWriteJudgement): 'apply' | 'hold' {
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
  if (spent.has(standing) || standing.presentation?.freshStepUp !== true || standing.spendFreshStepUp === undefined)
    return 'hold';
  spent.add(standing);
  standing.spendFreshStepUp();
  return 'apply';
}
