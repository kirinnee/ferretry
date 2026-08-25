import { canServeModel, type CoreAccount, servableModels } from './inventory.ts';

export type DisplayModelSource = 'harness' | 'requested' | 'account-default' | 'unknown';

/**
 * What resolving one request for a model came to: a model, or the reason the account cannot serve
 * the one that was asked for.
 *
 * A UNION RATHER THAN A FALLBACK, and that is the entire point of the type. This resolution used to
 * be total by DROPPING an unservable request and answering with the account's default, which meant
 * every caller got a model back and none of them could tell that it was not the one asked for. The
 * model then went onto the launch argv, onto the session document and into every surface reading it,
 * so somebody who named a model got a session running a different one at a different price, in a
 * different context window, and was told nothing. Making the refusal a VALUE the compiler forces
 * every caller to answer is what stops a future call site quietly reintroducing the substitution.
 */
export type ResolvedModel =
  | { readonly kind: 'resolved'; readonly model: string; readonly source: DisplayModelSource }
  | {
      readonly kind: 'unservable';
      /** Exactly what the caller asked for, so a refusal quotes the request rather than paraphrasing it. */
      readonly requested: string;
      /** Why this account cannot serve it, what it does serve, and what to do about it. */
      readonly reason: string;
    };

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
};

/**
 * Why this account cannot serve the model somebody named — three different sentences, because they
 * send a reader to three different places.
 *
 * A model the account DECLARES unavailable already carries the operator's own reason, and that reason
 * is the most useful sentence this daemon will ever have about it: "this subscription tier does not
 * include Haiku" answers the question, where "not served" starts an investigation. A model the
 * account never mentions is a different situation with a different remedy — declare it, or name one
 * of the ones that are there — so the list of what IS served travels with both.
 */
const unservableReason = (account: CoreAccount, requested: string): string => {
  const servable = servableModels(account).map(model => model.id);
  const named = JSON.stringify(requested);
  if (servable.length === 0) return `account ${account.agent} serves no model at all, so it cannot serve ${named}`;
  const alternatives = `It serves ${servable.join(', ')} — name one of those`;
  // Not `available === false`: after the manifest's own checks, "carries a reason" and "is declared
  // unavailable" are the same fact, and reading the reason is what makes this total without a branch
  // that could print an empty why.
  const declared = account.models.find(model => model.id === requested);
  if (declared !== undefined && !declared.available)
    return `account ${account.agent} cannot serve model ${named}: ${declared.unavailableReason}. ${alternatives}, or take ${named} back into service in the fleet configuration`;
  return `account ${account.agent} does not serve model ${named}. ${alternatives}, or declare ${named} on the account in the fleet configuration`;
};

/**
 * The model a session will actually run, or the refusal that says why the request cannot be met.
 *
 * Precedence: what the harness reported about itself, then the requested model, then the account's
 * declared default. The source instead kept a table of wrapper-name regexes to undo aliases the
 * provider silently remapped, which is why a pane running one model could be listed as another. An
 * account that declares what it serves makes the table unnecessary.
 *
 * AN OBSERVED MODEL IS NOT A REQUEST, so it is answered before the servability check and never
 * refused: it is what the harness says it is running, and a report about a live session is ground
 * truth rather than something this daemon is entitled to argue with.
 */
export function resolveDisplayModel(
  account: CoreAccount,
  requestedModel?: string,
  observedModel?: string,
): ResolvedModel {
  const observed = trimmed(observedModel);
  if (observed !== undefined) return { kind: 'resolved', model: observed, source: 'harness' };
  const requested = trimmed(requestedModel);
  if (requested !== undefined)
    return canServeModel(account, requested)
      ? { kind: 'resolved', model: requested, source: 'requested' }
      : { kind: 'unservable', requested, reason: unservableReason(account, requested) };
  const fallback = account.available ? trimmed(account.defaultModel ?? undefined) : undefined;
  if (fallback !== undefined) return { kind: 'resolved', model: fallback, source: 'account-default' };
  return { kind: 'resolved', model: 'unknown', source: 'unknown' };
}

/**
 * How long a launch request is held open for the harness to paint its first prompt before the
 * launch is answered as backgrounded.
 *
 * Never failed, only backgrounded and resolved later — a slow provider is not a broken one. The
 * source recognised the slow accounts by matching their wrapper names against a regex, so renaming
 * an account silently halved its launch window; the slow set is declared here and keyed by the
 * stable account id.
 */
export interface StartWaitPolicy {
  readonly baseMs: number;
  readonly slowMs: number;
  readonly ceilingMs: number;
  /** Accounts known to need the longer window, by stable id. */
  readonly slowAccountIds: readonly string[];
}

export const defaultStartWaitPolicy: StartWaitPolicy = {
  baseMs: 45_000,
  slowMs: 90_000,
  ceilingMs: 90_000,
  slowAccountIds: [],
};

export function startWaitMs(policy: StartWaitPolicy, accountId: string): number {
  const slow = policy.slowAccountIds.includes(accountId);
  const wanted = slow ? Math.max(policy.baseMs, policy.slowMs) : policy.baseMs;
  return Math.max(0, Math.min(policy.ceilingMs, wanted));
}
