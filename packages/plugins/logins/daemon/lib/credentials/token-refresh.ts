/**
 * What a Codex Check now needs from the refresh path: the port that drives the harness down its non-inference
 * authenticated path, the single-flight that keeps two checks of one login from racing, and the closed-set reading of
 * a refresh's failure output.
 *
 * Today's `token-refresh.ts` also held the fleet-identity renewal planner and service; those renew the shared stores
 * of runtime accounts and belong to Runtimes, so only the part Logins' status reads is here.
 *
 * Pure but for the port.
 */
import type { HarnessKind } from '../shared/harness.ts';

/**
 * The home whose credential a renewal rotates.
 *
 * Carries no material and no wrapper. The home is what decides *which* credential the harness
 * renews, and it comes from the manifest — never parsed back out of a wrapper's text or a name.
 */
export interface FleetTokenRefreshTarget {
  readonly accountId: string;
  readonly kind: HarnessKind;
  /** Absolute harness configuration directory. */
  readonly home: string;
}

/**
 * Whether the credential has renewed itself yet.
 *
 * A **stop condition**, not a result. One of the two harnesses is a server that never exits on its
 * own, so something has to say when its work is done; asking the credential is better than sleeping
 * for a guessed interval. The port is given this so it can stop early, and it has nowhere to put the
 * answer: judging the outcome stays with the service that owns the read.
 */
export type FleetTokenRefreshSettled = () => Promise<boolean>;

/**
 * What running the renewal path did — and, pointedly, not whether it worked.
 *
 * There is no `ok` member and no exit code, because neither means anything here. `ran` says only that
 * the harness was given its chance. Whether a credential is now usable is decided by re-reading the
 * credential, which is the one source that cannot be fooled by a call that succeeded for an unrelated
 * reason.
 */
export type FleetTokenRefreshAttempt =
  | {
      readonly outcome: 'ran';
      /**
       * What the harness's output said about a failure, as closed-set words only. Absent when the path
       * reads no output (Claude) — never evidence of success, which is read from the credential.
       */
      readonly evidence?: CodexRefreshEvidence;
    }
  | { readonly outcome: 'unavailable'; readonly reason: string }
  | { readonly outcome: 'error'; readonly reason: string };

/** Driving one harness down its non-inference authenticated path. The only impure side of this. */
export interface FleetTokenRefreshPort {
  refresh(target: FleetTokenRefreshTarget, settled: FleetTokenRefreshSettled): Promise<FleetTokenRefreshAttempt>;
}

/**
 * One piece of work per key at a time, and every caller asking during it gets ITS answer.
 *
 * The primitive both renewals stand on: the identity renewal above, and the account model's
 * per-credential refresh (design §9.2), where a launch that is due and a person's **Check now** must
 * never both spend one single-use Codex refresh token. Joined rather than queued, because a second
 * refresh straight after the first would spend the token the first just minted.
 *
 * The lookup and the registration happen with no `await` between them, so an interleaving caller
 * cannot arrive after the miss and before the entry exists. In-process only — see the module note.
 */
export class SingleFlight<T> {
  readonly #inFlight = new Map<string, Promise<T>>();

  async run(key: string, work: () => Promise<T>): Promise<T> {
    const joined = this.#inFlight.get(key);
    if (joined !== undefined) return await joined;
    const attempt = work().finally(() => this.#inFlight.delete(key));
    this.#inFlight.set(key, attempt);
    return await attempt;
  }

  /** Whether work for this key is running now: what makes a status read "Checking". */
  busy(key: string): boolean {
    return this.#inFlight.has(key);
  }
}

/**
 * The words a failed Codex refresh names itself by (codex-rs `RefreshTokenFailedReason`, VERIFIED by
 * reading). A closed set, because the only thing taken from a harness's output is which of these it
 * said — never the text around them.
 */
export const CODEX_REFRESH_FAILURE_CODES = [
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant',
] as const;
export type CodexRefreshFailureCode = (typeof CODEX_REFRESH_FAILURE_CODES)[number];

/** What a refresh's output said about why it failed, reduced to closed-set facts. */
export interface CodexRefreshEvidence {
  readonly codes: readonly CodexRefreshFailureCode[];
  /** A refresh line carried an HTTP `401`. */
  readonly unauthorized: boolean;
}

export const NO_CODEX_REFRESH_EVIDENCE: CodexRefreshEvidence = { codes: [], unauthorized: false };

/**
 * What a failed refresh means for the login.
 *
 * - `expired` — the refresh token outlived its lifetime: sign in again.
 * - `revoked` — it was spent elsewhere (`reused`) or withdrawn (`invalidated`): sign in again.
 * - `rejected` — `invalid_grant` or a `401` with no more specific word: sign in again.
 * - `transient` — anything else (offline, a 5xx, a timeout, nothing said): the login is NOT judged,
 *   and the last known status stands with its age.
 */
export type CodexRefreshFailure = 'expired' | 'revoked' | 'rejected' | 'transient';

/** Scan harness output for the closed set above. Pure; the text is never retained or returned. */
export function scanCodexRefreshEvidence(text: string): CodexRefreshEvidence {
  const lower = text.toLowerCase();
  const codes = CODEX_REFRESH_FAILURE_CODES.filter(code => lower.includes(code));
  const unauthorized = lower
    .split('\n')
    .some(line => line.includes('refresh') && /(?:^|[^0-9])401(?:[^0-9]|$)/u.test(line));
  return { codes, unauthorized };
}

/** Merge two scans, so evidence split across streams or chunks is one answer. */
export function mergeCodexRefreshEvidence(
  left: CodexRefreshEvidence,
  right: CodexRefreshEvidence,
): CodexRefreshEvidence {
  return {
    codes: CODEX_REFRESH_FAILURE_CODES.filter(code => left.codes.includes(code) || right.codes.includes(code)),
    unauthorized: left.unauthorized || right.unauthorized,
  };
}

/** The table, most specific word first. Only an unmistakable word condemns a login. */
export function classifyCodexRefreshFailure(evidence: CodexRefreshEvidence): CodexRefreshFailure {
  if (evidence.codes.includes('refresh_token_expired')) return 'expired';
  if (evidence.codes.includes('refresh_token_reused') || evidence.codes.includes('refresh_token_invalidated')) {
    return 'revoked';
  }
  if (evidence.codes.includes('invalid_grant') || evidence.unauthorized) return 'rejected';
  return 'transient';
}
