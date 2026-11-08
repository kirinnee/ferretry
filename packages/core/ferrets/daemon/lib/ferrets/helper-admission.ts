import { ApiError, type DecideAnswer, type HookDecision } from '@ferretry/kernel/contract';
import type { StartDecideInput } from '../../../contract/index.ts';

/**
 * The definite admission of a helper: a start (or a resume) of a ferret with a parent or `role: helper`. Today's
 * `pack.admit` was mandatory for such a child. RULING #43: Packs owns that answer and gives it through the kernel's
 * existing `start.decide`; Ferrets only consumes it. `start.decide` alone cannot prove it (with no taker it answers
 * allow), so Ferrets asks the kernel how each taker answered (`decideAnswered`) and admits a child only when Packs
 * ITSELF said yes. Nothing is bound around the hook table: a daemon without a live Packs admits no child.
 */

/** The plugin whose own `allowed` on `start.decide` is a helper's admission (Packs' manifest id). */
export const HELPER_ADMISSION_ANSWERER = 'packs';

/** Whether a start or resume needs the helper admission: it has a parent, or it is a helper. */
function needsHelperAdmission(input: Pick<StartDecideInput, 'parent' | 'role'>): boolean {
  return input.parent !== undefined || input.role === 'helper';
}

/** No answer from Packs: no helper is started, and nothing is launched (5.0's fail-closed sentence, unchanged). */
export function unboundHelperAdmission(): ApiError {
  return new ApiError(
    503,
    'Packs helper admission is not bound, so no helper is started',
    'helper_admission_unavailable',
  );
}

/**
 * What a start or resume is answered from `start.decide`'s answer. A start that needs no helper admission gets the
 * decision as it is. A child gets it only when Packs answered for itself: its own yes (the decision then stands, a
 * later taker's no included) or its own no (that no IS the decision, with Packs' reason). A no from a taker asked
 * before Packs stands as it is. Anything else (Packs absent, skeleton, failed, timed out, threw, or answered something
 * that is not a decision) is `unanswered`: never an allow.
 */
export function helperDecision(input: StartDecideInput, answer: DecideAnswer): HookDecision | 'unanswered' {
  if (!needsHelperAdmission(input)) return answer.decision;
  const packs = answer.answers.find(entry => entry.plugin === HELPER_ADMISSION_ANSWERER);
  if (packs?.outcome === 'allowed' || packs?.outcome === 'refused') return answer.decision;
  if (packs === undefined && !answer.decision.allow) return answer.decision;
  return 'unanswered';
}
