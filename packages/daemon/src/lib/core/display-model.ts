import { canServeModel, type CoreAccount } from './inventory.ts';

export type DisplayModelSource = 'harness' | 'requested' | 'account-default' | 'unknown';

export interface DisplayModel {
  readonly model: string;
  readonly source: DisplayModelSource;
}

const trimmed = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
};

/**
 * The model a session is actually running, for display.
 *
 * Precedence: what the harness reported about itself, then the requested model *if this account can
 * serve it*, then the account's declared default. The source instead kept a table of wrapper-name
 * regexes to undo aliases the provider silently remapped, which is why a pane running one model
 * could be listed as another. An account that declares what it serves makes the table unnecessary,
 * and a requested model the account does not serve is reported as the default it will really get.
 */
export function resolveDisplayModel(
  account: CoreAccount,
  requestedModel?: string,
  observedModel?: string,
): DisplayModel {
  const observed = trimmed(observedModel);
  if (observed !== undefined) return { model: observed, source: 'harness' };
  const requested = trimmed(requestedModel);
  if (requested !== undefined && canServeModel(account, requested)) return { model: requested, source: 'requested' };
  const fallback = account.available ? trimmed(account.defaultModel ?? undefined) : undefined;
  if (fallback !== undefined) return { model: fallback, source: 'account-default' };
  return { model: 'unknown', source: 'unknown' };
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
