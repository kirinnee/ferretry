/**
 * Runtimes' answer to Ferrets' `runtime.start`: which harness and login a launch spends, and whether that login may be
 * spent now.
 *
 * A runtime is one login plus one profile (R2), so a ferret started on `rt` spends `rt`'s login. `resolve` is the same
 * `api.resolve` the auto-resume question uses, so a runtime that cannot serve a launch now (unknown, switched off, login
 * missing or needing sign-in, profile missing) is refused with one plain sentence naming it and the way forward, never
 * launched signed out.
 *
 * `login` is the ONE check of whether a login may be spent: switched off, or over its spend budget, is a plain sentence
 * naming the login and why. A runtime's login passes through it too, so a login is refused the same way whether it was
 * named directly (`--login`) or reached through a runtime, and on every path that launches (start, resume, a move's target).
 *
 * Pure apart from the seams it is handed.
 */
import type { LoginStartResolution, RuntimeStartResolution, RuntimeStartSource } from '@ferretry/core-ferrets/contract';
import type { LoginView, LoginsApi } from '@ferretry/plugin-logins/contract';
import { RuntimeIdSchema, type RuntimesApi } from '../../../contract/index.ts';

export interface RuntimeStartAnswerDeps {
  readonly resolve: RuntimesApi['resolve'];
  readonly logins: Pick<LoginsApi, 'list'>;
}

const REMEDY = 'run `fy runtimes` to see what can start, or fix it in Runtimes';

/** Why `login` cannot be spent now, in one sentence; `undefined` when it can. */
function whyNot(login: LoginView): string | undefined {
  if (login.disabled !== undefined) {
    const { reason, until } = login.disabled;
    return `login ${login.id} is switched off${reason === undefined ? '' : ` (${reason})`}${until === undefined ? '' : ` until ${until}`}`;
  }
  const held = [login.budget?.daily, login.budget?.weekly].flatMap((period, index) =>
    period === undefined || period.level === 'ok' ? [] : [{ period, name: index === 0 ? 'daily' : 'weekly' }],
  );
  const worst = held.find(entry => entry.period.level === 'over_hard') ?? held[0];
  if (worst === undefined) return undefined;
  const { period, name } = worst;
  const hard = period.level === 'over_hard';
  const limit = hard ? period.hard : period.trigger;
  return `login ${login.id} is over its ${name} budget on this machine${limit === undefined ? '' : ` (its $${limit.toFixed(2)} ${hard ? 'hard limit' : 'trigger'})`} until ${period.resetsAt}`;
}

export function runtimeStartAnswer(deps: RuntimeStartAnswerDeps): RuntimeStartSource {
  const login = async (name: string): Promise<LoginStartResolution> => {
    const listed = await deps.logins.list().catch(() => undefined);
    if (listed === undefined)
      return { ok: false, sentence: `login ${name} could not be checked, so the ferret was not started` };
    const found = listed.logins.find(entry => entry.id === name);
    if (found === undefined) return { ok: false, sentence: `login ${name} does not exist on this machine` };
    const reason = whyNot(found);
    return reason === undefined ? { ok: true } : { ok: false, sentence: reason };
  };
  const resolve = async (runtime: string): Promise<RuntimeStartResolution> => {
    const id = RuntimeIdSchema.safeParse(runtime);
    if (!id.success) return { ok: false, sentence: `${JSON.stringify(runtime)} is not a runtime name; ${REMEDY}` };
    const resolved = await deps.resolve(id.data);
    if (!resolved.ok)
      return { ok: false, sentence: `runtime ${id.data} was not started: ${resolved.sentence}; ${REMEDY}` };
    const spendable = await login(resolved.runtime.login);
    if (!spendable.ok)
      return { ok: false, sentence: `runtime ${id.data} was not started: ${spendable.sentence}; ${REMEDY}` };
    return { ok: true, harness: resolved.runtime.harness, login: resolved.runtime.login };
  };
  return { login, resolve };
}
