import { ApiError, type HookDecision } from '@ferretry/kernel/contract';
import type { StartDecideInput } from '../../../contract/index.ts';

/**
 * The definite admission of a helper: a start (or a resume) of a ferret with a parent or `role: helper`. Today's
 * `pack.admit` was mandatory for such a child, and `start.decide` cannot stand in for it: with no taker it answers
 * allow, so it never proves that Packs admitted the child. Ferrets asks THIS first, then `start.decide`.
 *
 * It is a seam Ferrets' daemon half is built with (`ferretsDaemon({ helperAdmission })`), not a hook yet: which side
 * binds it in a real daemon (a Ferrets-offered hook only Packs may take, or the composition root) is still to be
 * decided. GAP(provenance): until it is bound, every daemon is built without one and answers `unboundHelperAdmission`.
 *
 * A bound admission is never trusted raw: `askHelperAdmission` treats it exactly as the kernel treats a `start.decide`
 * taker (bounded, `allow === true` only, a string reason and code only, a throw or a hang is a no).
 */
export interface HelperAdmission {
  admit(input: StartDecideInput): Promise<HookDecision>;
}

/** Whether a start or resume needs the helper admission: it has a parent, or it is a helper. */
export function needsHelperAdmission(input: Pick<StartDecideInput, 'parent' | 'role'>): boolean {
  return input.parent !== undefined || input.role === 'helper';
}

/** Fail closed, exactly as 5.0 did with nothing to bind: no helper is started, and nothing is launched. */
export function unboundHelperAdmission(): ApiError {
  return new ApiError(
    503,
    'Packs helper admission is not bound, so no helper is started',
    'helper_admission_unavailable',
  );
}

/** The bound an admission answers within, and the clock that keeps it (the kernel's, so a test drives it). */
export interface AdmissionBound {
  /** The kernel's own bound for the `start.decide` it stands beside (`StartDecide.timeoutMs`). */
  readonly timeoutMs: number;
  /** Runs `fn` after `ms`; the answer is a cancel. */
  readonly after: (ms: number, fn: () => void) => () => void;
}

/** Who answers the admission, in the kernel's sentences (`<plugin> did not answer in time.`). */
const ANSWERER = 'Packs';

/** The kernel's sentences for a decide taker that cannot say yes (`kernel/host/hooks.ts` `decide`), for Packs. */
export const HELPER_ADMISSION_SENTENCES = Object.freeze({
  timeout: `${ANSWERER} did not answer in time.`,
  threw: `${ANSWERER} failed while deciding.`,
  refused: `${ANSWERER} refused.`,
});

/**
 * Asks a bound admission, copying the kernel's `decide` handling for one taker: the call is bounded by `timeoutMs`; a
 * timeout or a throw is a no with its fixed sentence; only `allow === true` admits; a no keeps its reason only when it
 * is a string and its code only when it is a string (the service then reads the code through Ferrets' closed list,
 * `refusedBy`); anything else is a no with the fixed sentence. A hang therefore cannot hold a start, nor a resume's
 * per-ferret queue (so a `stop` behind it still runs).
 */
export async function askHelperAdmission(
  seam: HelperAdmission,
  input: StartDecideInput,
  bound: AdmissionBound,
): Promise<HookDecision> {
  let cancel = (): void => {};
  const deadline = new Promise<'timeout'>(resolve => {
    cancel = bound.after(bound.timeoutMs, () => resolve('timeout'));
  });
  let answer: { readonly value: unknown } | 'timeout' | 'threw';
  try {
    answer = await Promise.race([
      Promise.resolve()
        .then(() => seam.admit(input))
        .then((value: unknown) => ({ value })),
      deadline,
    ]);
  } catch {
    answer = 'threw';
  } finally {
    cancel();
  }
  if (answer === 'timeout') return { allow: false, reason: HELPER_ADMISSION_SENTENCES.timeout };
  if (answer === 'threw') return { allow: false, reason: HELPER_ADMISSION_SENTENCES.threw };
  const decision = answer.value as { readonly allow?: unknown; readonly reason?: unknown; readonly code?: unknown };
  if (decision !== null && typeof decision === 'object' && decision.allow === true) return { allow: true };
  const refusal = decision !== null && typeof decision === 'object' && decision.allow === false;
  const reason = refusal && typeof decision.reason === 'string' ? decision.reason : HELPER_ADMISSION_SENTENCES.refused;
  return refusal && typeof decision.code === 'string'
    ? { allow: false, reason, code: decision.code }
    : { allow: false, reason };
}
