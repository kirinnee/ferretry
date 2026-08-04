/**
 * The operator configuration for automatic quota failover.
 *
 * WHAT OPT-IN LOOKS LIKE HERE, and why. The capability is opted into PER ACCOUNT, by naming the
 * accounts that form one interchangeable pool. A session running on a pool account may be moved to
 * another pool account; a session on any other account is never touched. The alternative — a flag on
 * the session — was rejected for a concrete reason rather than a stylistic one: exhaustion is a
 * property of the ACCOUNT, the operator who provisions accounts is the only party who knows which of
 * them are substitutable for each other, and a per-session flag would have to be carried on the start
 * request, the CLI and the browser client before a single session could opt in. Per-session consent
 * on top of this is a real refinement and it is declared as a gap, not pretended.
 *
 * THE DEFAULT IS OFF, twice over: `enabled` is `false` and the pool is EMPTY. Either one alone stops
 * every move. A fresh daemon therefore cannot move a session on its own, and an operator who turns
 * the switch on without naming a pool still gets nothing — which the tick reports in those words
 * rather than silently doing nothing.
 *
 * TOLERANT ON READ. A stored document that no longer validates falls back to these defaults and SAYS
 * SO, because the defaults are the safe direction: a configuration this daemon cannot understand can
 * never authorise a migration.
 *
 * Pure: no IO, no clock, no globals.
 */

import { z } from 'zod';

/**
 * Floors applied when deriving milliseconds from configured minutes.
 *
 * Not redundant with the schema's `positive()`. A one-minute tick parses, and each tick reads the
 * fleet and the usage feed; the floor is what makes a mis-set small number cheap rather than a
 * self-inflicted load generator.
 */
export const MINIMUM_QUOTA_FAILOVER_INTERVAL_MS = 60_000;

export const QuotaFailoverConfigSchema = z
  .object({
    /** The master switch. `false` means the tick still runs and still reports, and moves nothing. */
    enabled: z.boolean().default(false),
    /**
     * The interchangeable pool, in preference order.
     *
     * Both halves of the decision at once: an account listed here may have its sessions moved AWAY
     * when it runs out, and may RECEIVE a session that ran out elsewhere. One list rather than two
     * because a pool whose members are not mutually substitutable is not a pool — and a target that
     * nobody would fail over from is a target nobody checked.
     */
    accounts: z.array(z.string().trim().min(1)).readonly().default([]),
    intervalMinutes: z.number().positive().default(5),
    /**
     * How old the usage reading may be and still be acted on.
     *
     * A migration destroys a pane. Acting on an hour-old snapshot is acting on a guess about the
     * present, so a snapshot older than this halts the tick with a stated reason instead.
     */
    maxSnapshotAgeMinutes: z.number().positive().default(15),
    /**
     * The ceiling a target's measured consumption must be BELOW.
     *
     * Not merely "not at its limit": an account at 97% is minutes from being the next exhausted one,
     * and migrating into it spends the preflight's admission to buy nothing.
     */
    headroomPercent: z.number().min(0).max(100).default(80),
    /**
     * How many times ONE session may be moved automatically, ever.
     *
     * The primary anti-loop guard, and deliberately a hard ceiling rather than a rate: a session that
     * has been moved once and is out of tokens again is a session whose workload does not fit the
     * pool, and moving it a third and fourth time hides that from the human instead of showing it.
     */
    maxMovesPerSession: z.number().int().nonnegative().default(1),
    /**
     * How long an account a session has already been on is barred from being its target again.
     *
     * The second anti-loop guard, and the one that stops two exhausted accounts ping-ponging a
     * session even if the ceiling above were raised.
     */
    revisitCooldownMinutes: z.number().nonnegative().default(360),
    /** How long a session is left alone after an attempt, whether it moved, was refused, or failed. */
    retryCooldownMinutes: z.number().nonnegative().default(15),
  })
  .strict();

export type QuotaFailoverConfig = z.output<typeof QuotaFailoverConfigSchema>;

/** The configuration a state home with no quota-failover document behaves as. */
export const defaultQuotaFailoverConfig: QuotaFailoverConfig = QuotaFailoverConfigSchema.parse({});

export interface StoredQuotaFailoverConfig {
  readonly config: QuotaFailoverConfig;
  /** Non-empty exactly when the stored document could not be used as written. */
  readonly warnings: readonly string[];
}

/**
 * The configuration a persisted document means.
 *
 * Absent — no document yet — is the normal first-boot situation and yields the defaults with no
 * warning. Anything present but invalid yields the defaults WITH a warning, and the defaults move
 * nothing, so a hand-edited document can only ever disable this feature rather than misdirect it.
 */
export function parseStoredQuotaFailoverConfig(value: unknown): StoredQuotaFailoverConfig {
  if (value === undefined || value === null) return { config: defaultQuotaFailoverConfig, warnings: [] };
  const parsed = QuotaFailoverConfigSchema.safeParse(value);
  if (parsed.success) return { config: parsed.data, warnings: [] };
  const issue = parsed.error.issues[0];
  const where =
    issue === undefined ? 'document' : issue.path.length === 0 ? 'document' : issue.path.map(String).join('.');
  const why = issue === undefined ? 'it is not a usable document' : issue.message;
  return {
    config: defaultQuotaFailoverConfig,
    warnings: [
      `the stored quota-failover configuration did not validate (${where}: ${why}); defaults are in effect and no session will be moved`,
    ],
  };
}

/** The tick cadence, floored. */
export function quotaFailoverIntervalMs(config: QuotaFailoverConfig): number {
  return Math.max(MINIMUM_QUOTA_FAILOVER_INTERVAL_MS, config.intervalMinutes * 60_000);
}

export function snapshotAgeCeilingMs(config: QuotaFailoverConfig): number {
  return Math.max(0, config.maxSnapshotAgeMinutes * 60_000);
}

export function revisitCooldownMs(config: QuotaFailoverConfig): number {
  return Math.max(0, config.revisitCooldownMinutes * 60_000);
}

export function retryCooldownMs(config: QuotaFailoverConfig): number {
  return Math.max(0, config.retryCooldownMinutes * 60_000);
}

/**
 * The effective pool: blanks dropped, deduplicated keeping the FIRST occurrence.
 *
 * Order is preference order and it is retained, because it is the tiebreak when two candidates are
 * measured equally spent — an operator who lists a preferred account first means it.
 */
export function quotaFailoverPool(config: QuotaFailoverConfig): readonly string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const entry of config.accounts) {
    const agent = entry.trim();
    if (agent === '' || seen.has(agent)) continue;
    seen.add(agent);
    pool.push(agent);
  }
  return pool;
}
