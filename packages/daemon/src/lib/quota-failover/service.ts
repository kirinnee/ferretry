/**
 * The tick that closes the loop: notice an account is out of tokens, confirm somewhere else has
 * room, and move the session there THROUGH the migration gate.
 *
 * WHAT THIS SERVICE IS ALLOWED TO DECIDE: nothing. The plan is computed by a pure function over a
 * snapshot of the world, and everything here is carrying it out, recording what happened, and being
 * careful about the order of the two.
 *
 * THE ORDER OF THE TWO IS THE INTERESTING PART. The attempt is written to the ledger BEFORE the
 * migration is asked for, not after. If it were written after, a daemon that died mid-migration — and
 * a migration kills a terminal, so dying inside one is not exotic — would come back with a ledger
 * saying the session had never been attempted, and would attempt it again against an account it may
 * already be on. Writing first means the worst case is a move that happened and was recorded as
 * pending, which the outcome write then corrects; the ledger can over-count an attempt, never
 * under-count one. Over-counting costs one retry cooldown. Under-counting is the loop.
 *
 * MIGRATIONS ARE SEQUENTIAL, never concurrent. Each one destroys a terminal and relaunches an agent,
 * and a tick that moved four sessions at once would put four relaunches on the host simultaneously
 * during the exact minute the fleet is already degraded.
 *
 * ONE TICK AT A TIME. Runs are chained rather than allowed to overlap: two ticks would read the same
 * ledger before either wrote, and the second would re-spend a budget the first had already spent.
 *
 * Pure of IO: everything outside is a port. No clock reads, no globals.
 */

import type { AccountInventoryPort } from '../core/inventory.ts';
import type { UsageFeedPort } from '../usage/types.ts';
import { parseStoredQuotaFailoverConfig, type QuotaFailoverConfig, quotaFailoverIntervalMs } from './config.ts';
import {
  parseStoredQuotaFailoverState,
  pruneLedger,
  type QuotaFailoverState,
  recordAttempt,
  recordTick,
} from './ledger.ts';
import { planQuotaFailover, type QuotaFailoverMigration } from './plan.ts';
import type {
  QuotaFailoverClock,
  QuotaFailoverConfigStore,
  QuotaFailoverJournal,
  QuotaFailoverMigrator,
  QuotaFailoverRoster,
  QuotaFailoverStateStore,
} from './ports.ts';

/** The journal event a completed automatic move writes onto the session. */
export const QUOTA_FAILOVER_MOVED_EVENT = 'session.quota_failover_moved';
/** The journal event an attempted move that the migration refused writes onto the session. */
export const QUOTA_FAILOVER_REFUSED_EVENT = 'session.quota_failover_refused';
/** The journal event a session that is out of tokens with nowhere to go writes onto itself. */
export const QUOTA_FAILOVER_STRANDED_EVENT = 'session.quota_failover_stranded';

/** One session this tick moved. */
export interface QuotaFailoverMoved {
  readonly sessionId: string;
  readonly from: string;
  readonly to: string;
  readonly evidence: string;
}

/** One session this tick tried to move and could not. */
export interface QuotaFailoverFailure {
  readonly sessionId: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

/** One session that is out of tokens with no confirmed account to go to. */
export interface QuotaFailoverStrandedReport {
  readonly sessionId: string;
  readonly agent: string;
  readonly reasons: Readonly<Record<string, string>>;
}

/** What one completed tick did. Returned so the loop can publish it and a test can assert on it. */
export interface QuotaFailoverTickReport {
  readonly at: string;
  /** Set exactly when the tick declined to decide anything, with the reason. */
  readonly halted: string | undefined;
  /** Configuration problems worth telling an operator about, even on a tick that did nothing. */
  readonly warnings: readonly string[];
  readonly considered: number;
  readonly moved: readonly QuotaFailoverMoved[];
  readonly failed: readonly QuotaFailoverFailure[];
  readonly stranded: readonly QuotaFailoverStrandedReport[];
  /** Sessions left alone, and why. Bounded by the fleet size, so it is safe to carry in full. */
  readonly skipped: readonly { readonly sessionId: string; readonly reason: string }[];
}

/** The loop, as the composition root drives it. A port shape rather than this class, so the mount
 *  table in `src/lib` never has to name an adapter. */
export interface QuotaFailoverLoop {
  /** The configured cadence, read from the operator's document. */
  intervalMs(): Promise<number>;
  /** One tick, after every tick already queued. Never rejects — a background timer must not take a
   *  daemon down, and the failure is carried by the report instead. */
  run(): Promise<QuotaFailoverTickReport>;
}

export interface QuotaFailoverParts {
  readonly config: QuotaFailoverConfigStore;
  readonly state: QuotaFailoverStateStore;
  readonly roster: QuotaFailoverRoster;
  readonly accounts: AccountInventoryPort;
  /** The SAME daemon-wide cached feed every other consumer reads, so a failover can never act on a
   *  quota reading that disagrees with the one `/v1/usage` is serving. */
  readonly usage: UsageFeedPort;
  readonly migrator: QuotaFailoverMigrator;
  readonly journal: QuotaFailoverJournal;
  readonly clock: QuotaFailoverClock;
}

export class QuotaFailoverService implements QuotaFailoverLoop {
  /** The tail of the run chain. Always settled, never rejected. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly parts: QuotaFailoverParts) {}

  async intervalMs(): Promise<number> {
    const stored = await this.parts.config.read().catch(() => undefined);
    return quotaFailoverIntervalMs(parseStoredQuotaFailoverConfig(stored).config);
  }

  async run(): Promise<QuotaFailoverTickReport> {
    const queued = this.chain.then(async () => await this.tick());
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  private async tick(): Promise<QuotaFailoverTickReport> {
    const at = new Date(this.parts.clock.nowMs()).toISOString();
    // Settled rather than awaited bare: a configuration document this daemon cannot read at all is a
    // halt with a stated reason, not a rejection out of a background timer.
    const read = await this.parts.config.read().then(
      (value: unknown) => ({ ok: true as const, value }),
      (reason: unknown) => ({ ok: false as const, reason }),
    );
    if (!read.ok) return halted(at, `the quota-failover configuration could not be read: ${describe(read.reason)}`, []);
    const { config, warnings } = parseStoredQuotaFailoverConfig(read.value);
    // The disabled tick stops HERE, before the feed is touched. Reading the usage feed refreshes it,
    // and a switched-off subsystem must not be the reason a collector is probed every five minutes.
    if (!config.enabled) return halted(at, 'automatic quota failover is disabled (enabled=false)', warnings);
    return await this.decide(at, config, warnings).catch(reason => halted(at, describe(reason), warnings));
  }

  private async decide(
    at: string,
    config: QuotaFailoverConfig,
    warnings: readonly string[],
  ): Promise<QuotaFailoverTickReport> {
    const ledger = parseStoredQuotaFailoverState(await this.parts.state.read());
    if (ledger.kind === 'damaged') return halted(at, ledger.reason, warnings);
    const sessions = await this.parts.roster.sessions();
    const accounts = await this.parts.accounts.accounts();
    const usage = await this.parts.usage.accounts();
    const nowMs = this.parts.clock.nowMs();
    const plan = planQuotaFailover({
      config,
      state: ledger.state,
      sessions,
      accounts,
      usage,
      snapshotAt: this.parts.usage.snapshotAt(),
      nowMs,
    });
    if (plan.kind === 'halted') {
      // The ledger is still touched, so a halted tick is visible as a tick rather than as silence.
      await this.publish(recordTick(ledger.state, at, `halted: ${plan.reason}`));
      return halted(at, plan.reason, warnings);
    }

    let state = pruneLedger(ledger.state, new Set(sessions.map(session => session.id)));
    const moved: QuotaFailoverMoved[] = [];
    const failed: QuotaFailoverFailure[] = [];
    for (const migration of plan.migrations) {
      state = await this.attempt(migration, state, moved, failed);
    }
    for (const entry of plan.stranded) {
      await this.parts.journal
        .record(entry.sessionId, QUOTA_FAILOVER_STRANDED_EVENT, {
          agent: entry.agent,
          evidence: entry.evidence,
          rejected: entry.rejected,
        })
        .catch(() => undefined);
    }
    const report: QuotaFailoverTickReport = {
      at,
      halted: undefined,
      warnings,
      considered: sessions.length,
      moved,
      failed,
      stranded: plan.stranded.map(entry => ({
        sessionId: entry.sessionId,
        agent: entry.agent,
        reasons: entry.rejected,
      })),
      skipped: plan.skipped,
    };
    await this.publish(recordTick(state, at, summarize(report)));
    return report;
  }

  /**
   * One migration, with the ledger written on both sides of it.
   *
   * The `pending` write is what survives a daemon that dies inside the migration; see this module's
   * header for why over-counting an attempt is the safe direction and under-counting is the loop.
   */
  private async attempt(
    migration: QuotaFailoverMigration,
    state: QuotaFailoverState,
    moved: QuotaFailoverMoved[],
    failed: QuotaFailoverFailure[],
  ): Promise<QuotaFailoverState> {
    const session = migration.session;
    const pending = recordAttempt(state, session.id, {
      at: new Date(this.parts.clock.nowMs()).toISOString(),
      outcome: `attempting a move to ${migration.target.agent}`,
    });
    await this.publish(pending);
    const failure = await this.parts.migrator
      .migrate(session.id, migration.target.agent)
      .then(() => undefined)
      .catch((reason: unknown) => describe(reason));
    const at = new Date(this.parts.clock.nowMs()).toISOString();
    if (failure !== undefined) {
      failed.push({ sessionId: session.id, from: session.agent, to: migration.target.agent, reason: failure });
      await this.parts.journal
        .record(session.id, QUOTA_FAILOVER_REFUSED_EVENT, {
          from: session.agent,
          to: migration.target.agent,
          evidence: migration.evidence,
          reason: failure,
        })
        .catch(() => undefined);
      return recordAttempt(pending, session.id, { at, outcome: `refused: ${failure}` });
    }
    moved.push({
      sessionId: session.id,
      from: session.agent,
      to: migration.target.agent,
      evidence: migration.evidence,
    });
    await this.parts.journal
      .record(session.id, QUOTA_FAILOVER_MOVED_EVENT, {
        from: session.agent,
        to: migration.target.agent,
        evidence: migration.evidence,
        spentPercent: migration.target.spentPercent,
        rejected: migration.rejected,
      })
      .catch(() => undefined);
    return recordAttempt(pending, session.id, {
      at,
      outcome: `moved to ${migration.target.agent}`,
      move: { from: session.agent, to: migration.target.agent, at, evidence: migration.evidence },
    });
  }

  /** A ledger write that fails is swallowed rather than abandoning the tick: the move already
   *  happened, and the report is still worth returning. It is not silent — the next tick reads a
   *  ledger without the attempt on it and says so through its own outcome. */
  private async publish(state: QuotaFailoverState): Promise<void> {
    await this.parts.state.write(state).catch(() => undefined);
  }
}

/** A halted tick, in the report shape every caller already handles. */
function halted(at: string, reason: string, warnings: readonly string[]): QuotaFailoverTickReport {
  return {
    at,
    halted: reason,
    warnings,
    considered: 0,
    moved: [],
    failed: [],
    stranded: [],
    skipped: [],
  };
}

/** The one line the ledger carries so a reader can see the loop is alive without the report. */
function summarize(report: QuotaFailoverTickReport): string {
  return (
    `${report.considered} session(s) considered, ${report.moved.length} moved, ` +
    `${report.failed.length} refused, ${report.stranded.length} stranded`
  );
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
