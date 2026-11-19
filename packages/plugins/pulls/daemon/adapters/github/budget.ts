import type { GitAccountId, GitApiHeaders } from '@ferretry/plugin-git-accounts/contract';
import { BUDGET_PAUSE_FRACTION, type RateBudgetView, type RateResource } from '../../../contract/index.ts';

/** What GitHub gives an OAuth user token per hour. A higher `remaining` seen in a window raises the estimate. */
const ASSUMED_HOURLY_LIMIT = 5000;
const HOUR_MS = 3_600_000;
/** With no usable reset time (a `429` with no headers), wait this long. */
const BLIND_PAUSE_MS = 60_000;

/**
 * How long GitHub asked a caller to wait, from `Retry-After` (delta seconds or an HTTP date), or `undefined` when it did
 * not say or said nothing usable. Never longer than an hour: a broken header is not a longer wait.
 */
function retryAfterMs(text: string | undefined, now: number): number | undefined {
  if (text === undefined) return undefined;
  const wait = /^\d{1,9}$/u.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(wait) && wait > 0 ? Math.min(wait, HOUR_MS) : undefined;
}

interface Bucket {
  remaining: number;
  limit: number;
  resetMs: number;
  pausedUntilMs: number | undefined;
}

/**
 * The rate budget per account and resource. Below 10 % of the hourly allowance, polling pauses until the allowance
 * resets. The seam hands on `X-RateLimit-Remaining` and `-Reset` but not `-Limit`, so the allowance is the OAuth
 * default (5,000) or the highest `remaining` seen in the window, whichever is larger.
 */
export class RateBudget {
  readonly #buckets = new Map<string, Bucket>();

  constructor(private readonly nowMs: () => number) {}

  /**
   * Learns from one answer's headers. A status of 429, or a 403 with nothing left, pauses even if the headers are odd.
   * The SECONDARY limit shows as a 403 or 429 with a healthy `Remaining`: it pauses for as long as `Retry-After` says
   * (a minute when it does not say), because GitHub answers every further call with the same refusal and a longer ban.
   * `limited` is the caller's reading of GitHub's own words (a rate or abuse limit): a 403 that is only a permission
   * refusal, with neither `Retry-After` nor those words, pauses nothing.
   */
  observe(
    account: GitAccountId,
    resource: RateResource,
    headers: GitApiHeaders,
    status: number,
    limited = false,
  ): void {
    const now = this.nowMs();
    const key = `${account}:${resource}`;
    this.#learn(key, headers, status, now);
    const asked =
      status === 403 || status === 429 || status === 503 ? retryAfterMs(headers.retryAfter, now) : undefined;
    const refused = status === 429 || (status === 403 && limited);
    const wait = asked ?? (refused && this.#buckets.get(key)?.pausedUntilMs === undefined ? BLIND_PAUSE_MS : undefined);
    if (wait === undefined) return;
    const bucket = this.#buckets.get(key);
    const until = Math.max(now + wait, bucket?.pausedUntilMs ?? 0);
    this.#buckets.set(key, {
      remaining: bucket?.remaining ?? 0,
      limit: bucket?.limit ?? ASSUMED_HOURLY_LIMIT,
      resetMs: Math.max(bucket?.resetMs ?? 0, until),
      pausedUntilMs: until,
    });
  }

  #learn(key: string, headers: GitApiHeaders, status: number, now: number): void {
    const remaining = Number(headers.rateLimitRemaining);
    const resetMs = Number(headers.rateLimitReset) * 1000;
    const known =
      headers.rateLimitRemaining !== undefined &&
      headers.rateLimitReset !== undefined &&
      Number.isInteger(remaining) &&
      remaining >= 0 &&
      Number.isFinite(resetMs);
    const before = this.#buckets.get(key);
    // A `Retry-After` says how long better than the window's reset does: `observe` pauses by it.
    const told = headers.retryAfter !== undefined;
    if (!known) {
      if ((status === 429 || status === 403) && !told)
        this.#buckets.set(key, {
          remaining: 0,
          limit: before?.limit ?? ASSUMED_HOURLY_LIMIT,
          resetMs: now + BLIND_PAUSE_MS,
          pausedUntilMs: Math.max(now + BLIND_PAUSE_MS, before?.pausedUntilMs ?? 0),
        });
      return;
    }
    // A reset further away than an hour is a broken header, not a longer wait.
    const reset = Math.min(resetMs, now + HOUR_MS);
    const sameWindow = before !== undefined && before.resetMs === reset;
    const limit = Math.max(ASSUMED_HOURLY_LIMIT, sameWindow ? before.limit : 0, remaining);
    const low = remaining < limit * BUDGET_PAUSE_FRACTION || (status === 429 && !told);
    this.#buckets.set(key, {
      remaining,
      limit,
      resetMs: reset,
      pausedUntilMs: low && reset > now ? reset : undefined,
    });
  }

  /** The instant (ms) polling resumes, or `undefined` when it may go on. A passed reset ends the pause. */
  pausedUntil(account: GitAccountId, resource: RateResource): number | undefined {
    const bucket = this.#buckets.get(`${account}:${resource}`);
    if (bucket?.pausedUntilMs === undefined) return undefined;
    return bucket.pausedUntilMs > this.nowMs() ? bucket.pausedUntilMs : undefined;
  }

  /** Every bucket seen, as a screen shows it. */
  snapshot(): readonly RateBudgetView[] {
    const out: RateBudgetView[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [account, resource] = key.split(':') as [GitAccountId, RateResource];
      const paused = this.pausedUntil(account, resource);
      out.push({
        account,
        resource,
        remaining: bucket.remaining,
        limit: bucket.limit,
        resetsAt: new Date(bucket.resetMs).toISOString(),
        ...(paused === undefined ? {} : { pausedUntil: new Date(paused).toISOString() }),
      });
    }
    return out;
  }
}
