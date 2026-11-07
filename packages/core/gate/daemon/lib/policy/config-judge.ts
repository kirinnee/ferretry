import type { ConfigWriteJudgement } from '@ferretry/kernel/contract';

/**
 * Gate's judge of a plugin's OWN loosening config write (`Admission.judgeConfigWrite`, today's held-loosening rule): a
 * loosening is put into effect only when THIS CALL may confirm it; otherwise it is written and HELD for the owner, the
 * tighter version in effect. An absent or throwing judge holds it too (the kernel's side).
 *
 * Today a call may confirm only at this machine (`governance.governed === false`) or, through the config route, with a
 * passkey proved for that act; an agent, a warden and a job never may. The judgement the kernel hands Gate carries
 * the call's `actor` alone, which cannot tell the owner at this machine from a remote device (`owner-viewer` is both,
 * and the admin token is honoured off this host too). So every loosening is HELD for the owner — the tighter reading,
 * never a looser one — until the kernel hands the judge the call's standing (raised with the lead).
 */
export function judgeLooseningWrite(_input: ConfigWriteJudgement): 'apply' | 'hold' {
  return 'hold';
}
