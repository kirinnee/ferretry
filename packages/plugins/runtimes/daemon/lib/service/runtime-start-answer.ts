/**
 * Runtimes' answer to Ferrets' `runtime.start`: which harness and login a start that NAMES a runtime launches with.
 *
 * A runtime is one login plus one profile (R2), so a ferret started on `rt` spends `rt`'s login. Ferrets only copies the
 * request's fields onto the record; without this answer `fy new --runtime rt` and the app's new-ferret launched with no
 * login at all, signed out. This is the same `resolve` the auto-resume question uses, so a runtime that cannot serve a
 * launch now (unknown, switched off, login missing or needing sign-in, profile missing) is refused here with one plain
 * sentence naming it and the way forward, never launched signed out.
 *
 * Pure apart from the seam it is handed.
 */
import type { RuntimeStartResolution } from '@ferretry/core-ferrets/contract';
import { RuntimeIdSchema, type RuntimesApi } from '../../../contract/index.ts';

export interface RuntimeStartAnswerDeps {
  readonly resolve: RuntimesApi['resolve'];
}

const REMEDY = 'run `fy runtimes` to see what can start, or fix it in Runtimes';

export function runtimeStartAnswer(deps: RuntimeStartAnswerDeps): (runtime: string) => Promise<RuntimeStartResolution> {
  return async runtime => {
    const id = RuntimeIdSchema.safeParse(runtime);
    if (!id.success) return { ok: false, sentence: `${JSON.stringify(runtime)} is not a runtime name; ${REMEDY}` };
    const resolved = await deps.resolve(id.data);
    if (!resolved.ok)
      return { ok: false, sentence: `runtime ${id.data} was not started: ${resolved.sentence}; ${REMEDY}` };
    return { ok: true, harness: resolved.runtime.harness, login: resolved.runtime.login };
  };
}
