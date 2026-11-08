import type { DecideAnswer } from '@ferretry/kernel/contract';

/**
 * Whether an automatic resume may spend (W2-a, RULING #27 Q5: "auto-resume fails closed: no answer = no resume, no
 * spend"). Runtimes owns the answer and gives it on Ferrets' `auto-resume.decide`; Ferrets only consumes it. The hook
 * alone cannot prove it (with no taker the kernel answers allow), so Ferrets reads how each taker answered
 * (`decideAnswered`, the pattern helper admission uses with Packs) and goes on only on Runtimes' OWN yes.
 */

/** The plugin whose own `allowed` on `auto-resume.decide` lets an automatic resume spend (Runtimes' manifest id). */
export const AUTO_RESUME_ANSWERER = 'runtimes';

/** Why nothing was resumed when Runtimes gave no answer of its own: absent, failed, hung, threw or answered garbage. */
export const NO_AUTO_RESUME_ANSWER =
  'Runtimes did not answer whether this may run, so nothing was resumed and nothing was spent';

/** The longest reason kept from a taker's refusal: it lands in the ferret's journal and the machine's summary. */
const REASON_LIMIT = 200;

export type AutoResumeVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

/**
 * The verdict from the kernel's answer. ONLY `allow === true` overall, with Runtimes itself listed `allowed`, is a yes.
 * Runtimes' own no is a no with its reason; a no from a taker asked before Runtimes stands with its reason. Everything
 * else (no Runtimes, a skeleton or failed Runtimes, a hang past the kernel's bound, a throw, garbage, a yes from any
 * other plugin) is a no with {@link NO_AUTO_RESUME_ANSWER}: never an allow.
 */
export function autoResumeVerdict(answer: DecideAnswer): AutoResumeVerdict {
  const runtimes = answer.answers.find(entry => entry.plugin === AUTO_RESUME_ANSWERER);
  if (answer.decision.allow === true && runtimes?.outcome === 'allowed') return { allow: true };
  // The kernel's walk stops at the first no, so the last taker listed is the one that said it: its OWN refusal keeps its
  // reason; a no the kernel made for it (failed, hung, threw, garbage) is said in Ferrets' own words.
  const refusal = answer.decision.allow === false ? answer.decision : undefined;
  const refusedOwn = refusal !== undefined && answer.answers.at(-1)?.outcome === 'refused';
  if (refusedOwn && typeof refusal.reason === 'string' && refusal.reason.trim() !== '')
    return { allow: false, reason: refusal.reason.trim().slice(0, REASON_LIMIT) };
  return { allow: false, reason: NO_AUTO_RESUME_ANSWER };
}
