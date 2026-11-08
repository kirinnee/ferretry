import { ApiError, type HookDecision } from '@ferretry/kernel/contract';
import type { StartDecideInput } from '../../../contract/index.ts';

/**
 * The definite admission of a helper: a start (or a resume) of a ferret with a parent or `role: helper`. Today's
 * `pack.admit` was mandatory for such a child, and `start.decide` cannot stand in for it: with no taker it answers
 * allow, so it never proves that Packs admitted the child. Ferrets asks THIS first, then `start.decide`.
 *
 * It is a seam Ferrets' daemon half is built with (`ferretsDaemon({ helperAdmission })`), not a hook yet: which side
 * binds it in a real daemon (a Ferrets-offered hook only Packs may take, or the composition root) is still to be
 * decided. GAP(provenance): until it is bound, every daemon is built with `UNBOUND_HELPER_ADMISSION`.
 *
 * A `no` refuses the start with its reason (and its code, read through Ferrets' closed list, as a `start.decide` no
 * is); a throw is the start's own failure, so an admission that cannot answer starts nothing.
 */
export interface HelperAdmission {
  admit(input: StartDecideInput): Promise<HookDecision>;
}

/** Whether a start or resume needs the helper admission: it has a parent, or it is a helper. */
export function needsHelperAdmission(input: Pick<StartDecideInput, 'parent' | 'role'>): boolean {
  return input.parent !== undefined || input.role === 'helper';
}

/** Fail closed, exactly as 5.0 did with nothing to bind: no helper is started, and nothing is launched. */
export const UNBOUND_HELPER_ADMISSION: HelperAdmission = Object.freeze({
  admit: async (): Promise<HookDecision> => {
    throw new ApiError(
      503,
      'Packs helper admission is not bound, so no helper is started',
      'helper_admission_unavailable',
    );
  },
});
