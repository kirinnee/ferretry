/**
 * Warden account failover — the pure selection and hysteresis engine.
 *
 * Wardens run as ephemeral sessions on accounts, and accounts fail: rate limits,
 * expired credentials, a provider refusing traffic. This module owns choosing
 * WHICH configured account the next warden spawn uses, and the per-account
 * strike and demotion bookkeeping that decides what "healthy" means.
 *
 * The hysteresis doctrine is: corroborate at the SOURCE of a signal, damp at the
 * CONSUMER. The usage feed already re-probes before reporting a limit or an auth
 * failure, so feed-corroborated evidence demotes in one strike; a raw local
 * launch failure needs `failureThreshold` consecutive strikes. Demotion is
 * always a cooldown, never a latch — recovery is automatic and positive feed
 * evidence clears a demotion early.
 *
 * Pure: no IO, no clock reads, no globals.
 */

import { accountHealthProblem, confirmedUsableAccount, usableAccount } from '../usage/account-health.ts';
import type { WardenFailoverPolicy, WardenSelectionReason } from './provenance.ts';
import { instantMs, isoFromMs } from './time.ts';

/** One configured account the warden may run on. */
export interface WardenAccount {
  readonly agent: string;
  readonly model?: string;
}

export interface WardenFailoverConfig {
  readonly policy: WardenFailoverPolicy;
  /** Consecutive uncorroborated failures before an account is demoted. */
  readonly failureThreshold: number;
  /** How long a demotion lasts. */
  readonly cooldownMinutes: number;
}

export const DEFAULT_WARDEN_FAILOVER: WardenFailoverConfig = {
  policy: 'fallback',
  failureThreshold: 3,
  cooldownMinutes: 30,
};

/** The account-health facts the selector reads from the usage feed. */
export interface WardenAccountHealth {
  readonly agent: string;
  readonly authOk?: boolean;
  readonly atLimit?: boolean;
  readonly unavailable?: boolean;
  readonly unavailableReason?: string;
  /** Epoch milliseconds the provider said to retry after. */
  readonly retryAt?: number;
}

export interface WardenStrike {
  readonly count: number;
  readonly lastAt: string;
  readonly lastReason: string;
}

export interface WardenLastSelection {
  readonly agent: string;
  readonly policy: WardenFailoverPolicy;
  readonly at: string;
  readonly reason: WardenSelectionReason;
}

/** Durable per-account failover bookkeeping. Persisted so a daemon restart can
 *  neither amnesty a demotion nor reset a strike count. */
export interface WardenFailoverState {
  /** Round-robin cursor: index INTO THE CONFIGURED LIST of the last selection.
   *  Scanning starts after it, so turn order stays stable as eligibility
   *  fluctuates. */
  readonly rrCursor?: number;
  /** Consecutive uncorroborated failures, with the last evidence. */
  readonly strikes?: Readonly<Record<string, WardenStrike>>;
  /** Demotion expiry. Absent or past means eligible again — that IS the
   *  fail-back under the fallback policy; there is no separate mechanism. */
  readonly demotedUntil?: Readonly<Record<string, string>>;
  readonly lastSelection?: WardenLastSelection;
  /** Set while EVERY configured account is ineligible, cleared on the next
   *  successful selection, so the caller can edge-trigger an exhaustion event. */
  readonly exhaustedSince?: string;
}

export interface WardenSelectionInput {
  readonly accounts: readonly (WardenAccount | string)[];
  readonly failover?: Partial<WardenFailoverConfig>;
  /** Accounts actually installed on this host right now. */
  readonly installedAgents: readonly string[];
  readonly usage: readonly WardenAccountHealth[];
  readonly state: WardenFailoverState;
  readonly nowMs: number;
}

export type WardenSelection =
  | {
      readonly exhausted: false;
      readonly account: WardenAccount;
      /** State carrying the new cursor and last selection, exhaustion cleared. */
      readonly state: WardenFailoverState;
      readonly reason: WardenSelectionReason;
      /** Why each skipped account was skipped. */
      readonly skipped: Readonly<Record<string, string>>;
    }
  | {
      readonly exhausted: true;
      readonly state: WardenFailoverState;
      readonly reasons: Readonly<Record<string, string>>;
    };

/** The failover knobs with defaults applied. */
export function effectiveFailoverConfig(failover?: Partial<WardenFailoverConfig>): WardenFailoverConfig {
  return { ...DEFAULT_WARDEN_FAILOVER, ...failover };
}

/** The effective ordered account list: string shorthand expanded, blanks
 *  dropped, deduped by name keeping the FIRST occurrence and its model. */
export function normalizeWardenAccounts(entries: readonly (WardenAccount | string)[]): readonly WardenAccount[] {
  const accounts: WardenAccount[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidate = typeof entry === 'string' ? { agent: entry } : entry;
    const agent = candidate.agent?.trim();
    if (agent === undefined || agent === '' || seen.has(agent)) continue;
    seen.add(agent);
    accounts.push({ agent, ...(candidate.model === undefined ? {} : { model: candidate.model }) });
  }
  return accounts;
}

/** Is this account currently demoted? */
export function isDemoted(state: WardenFailoverState, agent: string, nowMs: number): boolean {
  const until = instantMs(state.demotedUntil?.[agent]);
  return until !== undefined && until > nowMs;
}

/**
 * Why an account is ineligible right now, or `undefined` when it is eligible.
 *
 * Loose usability on purpose: a warden spawn is cheap and backstopped by the
 * launch preflight, so an account the feed has not scored (a freshly added one,
 * a feed outage) must stay reachable.
 */
export function ineligibilityReason(
  account: WardenAccount,
  input: Pick<WardenSelectionInput, 'installedAgents' | 'usage' | 'state' | 'nowMs'>,
): string | undefined {
  // An EMPTY inventory is not evidence against anyone: it means the inventory
  // is unreadable, and skipping every account on that basis would disable
  // supervision exactly when the feed is blind too. Only a non-empty listing
  // that omits the account condemns it.
  if (input.installedAgents.length > 0 && !input.installedAgents.includes(account.agent)) {
    return 'not installed on this host';
  }
  // The classification is the usage module's — one table, so a condition it learns to recognise can
  // never be one the warden silently keeps accepting. Only the wording is warden's own.
  const health = input.usage.find(item => item.agent === account.agent);
  switch (accountHealthProblem(health)) {
    case 'auth':
      return 'credentials rejected (usage feed)';
    case 'unavailable': {
      const cause = health?.unavailableReason?.replaceAll('_', ' ') ?? 'provider';
      const retry = health?.retryAt === undefined ? '' : `; retry after ${isoFromMs(health.retryAt)}`;
      return `provider unavailable: ${cause}${retry} (usage feed)`;
    }
    case 'at-limit':
      return 'at its usage limit (usage feed)';
    default:
      break;
  }
  const demotedUntil = input.state.demotedUntil?.[account.agent];
  if (isDemoted(input.state, account.agent, input.nowMs)) return `demoted until ${demotedUntil}`;
  return undefined;
}

/**
 * Pick the account for the NEXT warden spawn. Eligibility is recomputed every
 * call, so fail-back is automatic: the moment a preferred account leaves
 * demotion, the fallback policy returns to it.
 */
export function selectWardenAccount(input: WardenSelectionInput): WardenSelection {
  const accounts = normalizeWardenAccounts(input.accounts);
  const { policy } = effectiveFailoverConfig(input.failover);
  const reasons: Record<string, string> = {};
  const eligible: { readonly index: number; readonly account: WardenAccount }[] = [];

  for (const [index, account] of accounts.entries()) {
    const reason = ineligibilityReason(account, input);
    if (reason === undefined) eligible.push({ index, account });
    else reasons[account.agent] = reason;
  }

  const first = eligible[0];
  if (first === undefined) {
    return {
      exhausted: true,
      reasons,
      state: { ...input.state, exhaustedSince: input.state.exhaustedSince ?? isoFromMs(input.nowMs) },
    };
  }

  const chosen =
    (policy === 'round_robin' ? nextRotation(accounts.length, eligible, input.state.rrCursor) : undefined) ?? first;
  const { index, account } = chosen;
  const reason: WardenSelectionReason = policy === 'round_robin' ? 'rotation' : index === 0 ? 'preferred' : 'failover';

  const { exhaustedSince: _cleared, ...carried } = input.state;
  return {
    exhausted: false,
    account,
    state: {
      ...carried,
      ...(policy === 'round_robin' ? { rrCursor: index } : {}),
      lastSelection: { agent: account.agent, policy, at: isoFromMs(input.nowMs), reason },
    },
    reason,
    skipped: reasons,
  };
}

/** Scan the FULL configured list starting after the cursor, wrapping, and take
 *  the first eligible entry. Anchoring on configured positions rather than the
 *  eligible sublist keeps every account's turn stable as others drop out. */
function nextRotation<T extends { readonly index: number }>(
  total: number,
  eligible: readonly T[],
  cursor: number | undefined,
): T | undefined {
  const byIndex = new Map(eligible.map(entry => [entry.index, entry]));
  const from = typeof cursor === 'number' && Number.isFinite(cursor) ? Math.trunc(cursor) : -1;
  return Array.from({ length: total }, (_unused, step) => (((from + step + 1) % total) + total) % total)
    .map(index => byIndex.get(index))
    .find(entry => entry !== undefined);
}

/** Evidence classes a spawn failure can carry. `quota`, `auth` and `provider`
 *  are corroborated at the source and demote in ONE strike; `generic` is raw
 *  and needs `failureThreshold` consecutive strikes. */
export type WardenFailureKind = 'quota' | 'auth' | 'provider' | 'generic';

/** Classify a launch failure by its message. The launch preflight throws
 *  distinctive wording for each corroborated class; anything else is generic. */
export function classifyWardenFailure(message: string): WardenFailureKind {
  if (/at its usage limit/i.test(message)) return 'quota';
  if (/credentials were rejected|auth failure/i.test(message)) return 'auth';
  if (/provider is unavailable|provider unavailable/i.test(message)) return 'provider';
  return 'generic';
}

export interface WardenFailureRecord {
  readonly state: WardenFailoverState;
  /** True when this failure crossed the threshold and demoted the account. */
  readonly demoted: boolean;
  readonly strikes: number;
}

/** Record a spawn failure against the ACCOUNT, never against the target
 *  session. Punishing the target is what starved suspect sessions one by one. */
export function recordWardenFailure(
  state: WardenFailoverState,
  agent: string,
  kind: WardenFailureKind,
  reason: string,
  nowMs: number,
  failover?: Partial<WardenFailoverConfig>,
): WardenFailureRecord {
  const { failureThreshold, cooldownMinutes } = effectiveFailoverConfig(failover);
  const at = isoFromMs(nowMs);
  const count = (state.strikes?.[agent]?.count ?? 0) + 1;
  const threshold = Math.max(1, Math.floor(failureThreshold));
  const demoted = kind !== 'generic' || count >= threshold;
  const next: WardenFailoverState = {
    ...state,
    strikes: { ...state.strikes, [agent]: { count, lastAt: at, lastReason: reason } },
    ...(demoted
      ? {
          demotedUntil: {
            ...state.demotedUntil,
            [agent]: isoFromMs(nowMs + Math.max(0, cooldownMinutes) * 60_000),
          },
        }
      : {}),
  };
  return { state: next, demoted, strikes: count };
}

/** A successful spawn clears the account's strikes and any demotion — it
 *  evidently works. */
export function recordWardenSuccess(state: WardenFailoverState, agent: string): WardenFailoverState {
  if (state.strikes?.[agent] === undefined && state.demotedUntil?.[agent] === undefined) return state;
  const strikes = { ...state.strikes };
  const demotedUntil = { ...state.demotedUntil };
  delete strikes[agent];
  delete demotedUntil[agent];
  return { ...state, strikes, demotedUntil };
}

export interface WardenRestoration {
  readonly agent: string;
  readonly how: 'feed' | 'cooldown';
}

/**
 * Clear demotions the usage feed positively contradicts, and prune demotions
 * whose cooldown has elapsed.
 *
 * A confirmed-healthy account is restored immediately, so a quota window that
 * resets early never waits out an unrelated cooldown timer. Expired demotions
 * are already inert; pruning them keeps the state and the status honest.
 */
export function reconcileDemotions(
  state: WardenFailoverState,
  usage: readonly WardenAccountHealth[],
  nowMs: number,
): { readonly state: WardenFailoverState; readonly restored: readonly WardenRestoration[] } {
  const demoted = Object.entries(state.demotedUntil ?? {});
  if (demoted.length === 0) return { state, restored: [] };

  const health = new Map(usage.map(item => [item.agent, item]));
  const restored: WardenRestoration[] = [];
  const demotedUntil = { ...state.demotedUntil };
  const strikes = { ...state.strikes };

  for (const [agent, until] of demoted) {
    const account = health.get(agent);
    if (confirmedUsableAccount(account) && usableAccount(account)) {
      delete demotedUntil[agent];
      delete strikes[agent];
      restored.push({ agent, how: 'feed' });
      continue;
    }
    const expiry = instantMs(until);
    if (expiry === undefined || expiry <= nowMs) {
      delete demotedUntil[agent];
      // The strike count goes with the demotion it produced. `failureThreshold`
      // means "consecutive failures before a demotion", and a served cooldown
      // IS the punishment — leaving the count at the threshold would put the
      // account one failure from re-demotion forever, quietly turning every
      // threshold above one into a one-strike rule after the first offence.
      delete strikes[agent];
      restored.push({ agent, how: 'cooldown' });
    }
  }

  return restored.length === 0 ? { state, restored } : { state: { ...state, demotedUntil, strikes }, restored };
}
