import type { AccountUsage } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import type { CoreAccount } from '../../../src/lib/core/inventory.ts';
import {
  QUOTA_FAILOVER_MOVED_EVENT,
  QUOTA_FAILOVER_REFUSED_EVENT,
  QUOTA_FAILOVER_STRANDED_EVENT,
  type QuotaFailoverParts,
  QuotaFailoverService,
  type QuotaFailoverSession,
  type QuotaFailoverState,
} from '../../../src/lib/quota-failover/index.ts';
import { account, AT, healthyRow, session, spentRow } from './fixtures.ts';

interface JournalEntry {
  readonly sessionId: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

interface Harness {
  readonly service: QuotaFailoverService;
  readonly journal: JournalEntry[];
  readonly migrations: { readonly sessionId: string; readonly agent: string }[];
  /** Every ledger the service wrote, in order, so the ordering rule can be asserted directly. */
  readonly writes: QuotaFailoverState[];
  /** How many times the usage feed was read, which is what a disabled tick must not do. */
  readonly probes: () => number;
}

interface HarnessOptions {
  readonly config?: unknown;
  readonly configError?: Error;
  readonly stored?: unknown;
  readonly sessions?: readonly QuotaFailoverSession[];
  readonly rosterError?: Error;
  readonly accounts?: readonly CoreAccount[];
  readonly usage?: readonly AccountUsage[];
  readonly snapshotAt?: number | undefined;
  readonly migrate?: (sessionId: string, agent: string) => Promise<void>;
  readonly journalError?: Error;
  readonly writeError?: Error;
  readonly nowMs?: () => number;
}

const enabledConfig = { enabled: true, accounts: ['agent-a', 'agent-b'] };

function harness(options: HarnessOptions = {}): Harness {
  const journal: JournalEntry[] = [];
  const migrations: { sessionId: string; agent: string }[] = [];
  const writes: QuotaFailoverState[] = [];
  let current: unknown = options.stored;
  let probes = 0;
  const parts: QuotaFailoverParts = {
    config: {
      read: async () => {
        if (options.configError !== undefined) throw options.configError;
        return options.config ?? enabledConfig;
      },
    },
    // A ledger that actually persists, so a second tick reads what the first one wrote — which is
    // the only way the anti-loop guards can be exercised across ticks at all.
    state: {
      read: async () => current,
      write: async state => {
        if (options.writeError !== undefined) throw options.writeError;
        current = state;
        writes.push(state);
      },
    },
    roster: {
      sessions: async () => {
        if (options.rosterError !== undefined) throw options.rosterError;
        return options.sessions ?? [session('s-1', 'agent-a')];
      },
    },
    accounts: { accounts: async () => options.accounts ?? [account('agent-a'), account('agent-b')] },
    usage: {
      accounts: async () => {
        probes += 1;
        return options.usage ?? [spentRow('agent-a'), healthyRow('agent-b', 12)];
      },
      snapshotAt: () => ('snapshotAt' in options ? options.snapshotAt : AT - 1_000),
      hasSnapshot: () => true,
    },
    migrator: {
      migrate: async (sessionId, agent) => {
        migrations.push({ sessionId, agent });
        if (options.migrate !== undefined) await options.migrate(sessionId, agent);
      },
    },
    journal: {
      record: async (sessionId, event, data) => {
        if (options.journalError !== undefined) throw options.journalError;
        journal.push({ sessionId, event, data });
      },
    },
    clock: { nowMs: options.nowMs ?? (() => AT) },
  };
  return { service: new QuotaFailoverService(parts), journal, migrations, writes, probes: () => probes };
}

describe('the quota-failover tick', () => {
  it('should move a stranded session onto the pool account with confirmed headroom', async () => {
    // Arrange
    const test = harness();

    // Act
    const report = await test.service.run();

    // Assert
    should(test.migrations).deepEqual([{ sessionId: 's-1', agent: 'agent-b' }]);
    should(report.halted).be.undefined();
    should(report.moved).have.length(1);
    should(report.moved[0]?.from).equal('agent-a');
    should(report.moved[0]?.to).equal('agent-b');
    should(report.considered).equal(1);
  });

  it('should write the move onto the session own journal, with the reading it moved on', async () => {
    // Arrange
    const test = harness();

    // Act
    await test.service.run();

    // Assert — the question a human asks is "why is this on a different account than I left it on"
    const entry = test.journal.find(item => item.event === QUOTA_FAILOVER_MOVED_EVENT);
    should(entry?.sessionId).equal('s-1');
    should(entry?.data.from).equal('agent-a');
    should(entry?.data.to).equal('agent-b');
    should(entry?.data.spentPercent).equal(12);
    should(String(entry?.data.evidence)).match(/measured agent-a at its limit/);
  });

  it('should record the attempt BEFORE asking for the migration', async () => {
    // Arrange — a daemon that dies inside a migration must come back knowing it tried; the ledger
    // may over-count an attempt, never under-count one
    const seen: string[] = [];
    const test = harness({
      migrate: async () => {
        seen.push('migrate');
      },
    });

    // Act
    await test.service.run();

    // Assert — the first write carries the pending outcome, before any move was recorded
    should(test.writes[0]?.sessions['s-1']?.lastOutcome).equal('attempting a move to agent-b');
    should(test.writes[0]?.sessions['s-1']?.moves).be.empty();
    should(seen).deepEqual(['migrate']);
  });

  it('should record the completed move in the durable budget', async () => {
    // Arrange
    const test = harness();

    // Act
    await test.service.run();

    // Assert
    const last = test.writes.at(-1);
    should(last?.sessions['s-1']?.moves).have.length(1);
    should(last?.sessions['s-1']?.moves[0]?.from).equal('agent-a');
    should(last?.sessions['s-1']?.moves[0]?.to).equal('agent-b');
    should(last?.lastTick?.summary).equal('1 session(s) considered, 1 moved, 0 refused, 0 stranded');
  });

  it('should record a refusal from the migration preflight without spending a move', async () => {
    // Arrange — the preflight refusing in-flight work is the gate doing its job, not a bug
    const test = harness({
      migrate: async () => {
        throw new Error('migration_refused: a destructive tool call is in flight');
      },
    });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.moved).be.empty();
    should(report.failed).deepEqual([
      {
        sessionId: 's-1',
        from: 'agent-a',
        to: 'agent-b',
        reason: 'migration_refused: a destructive tool call is in flight',
      },
    ]);
    should(test.writes.at(-1)?.sessions['s-1']?.moves).be.empty();
    should(test.writes.at(-1)?.sessions['s-1']?.lastOutcome).match(/^refused: /);
  });

  it('should journal a refusal so a human can see the attempt happened', async () => {
    // Arrange
    const test = harness({
      migrate: async () => {
        throw new Error('the preflight found unknown work');
      },
    });

    // Act
    await test.service.run();

    // Assert
    const entry = test.journal.find(item => item.event === QUOTA_FAILOVER_REFUSED_EVENT);
    should(entry?.data.reason).equal('the preflight found unknown work');
  });

  it('should carry a non-Error rejection through as text rather than losing it', async () => {
    // Arrange
    const test = harness({
      migrate: async () => {
        throw 'a bare string, from somewhere careless';
      },
    });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.failed[0]?.reason).equal('a bare string, from somewhere careless');
  });

  it('should still start the retry cooldown after a refusal', async () => {
    // Arrange
    const test = harness({
      migrate: async () => {
        throw new Error('refused');
      },
    });

    // Act
    await test.service.run();

    // Assert — the cooldown is measured from attempts, not successes, so a refusal is not a free retry
    should(test.writes.at(-1)?.sessions['s-1']?.lastAttemptAt).equal(new Date(AT).toISOString());
  });

  it('should journal a stranded session so the exhausted pool is visible', async () => {
    // Arrange
    const test = harness({ usage: [spentRow('agent-a'), spentRow('agent-b')] });

    // Act
    const report = await test.service.run();

    // Assert
    should(test.migrations).be.empty();
    should(report.stranded).have.length(1);
    should(report.stranded[0]?.reasons['agent-b']).equal('the account is at its usage limit');
    should(test.journal.find(item => item.event === QUOTA_FAILOVER_STRANDED_EVENT)?.sessionId).equal('s-1');
  });

  it('should move sessions one at a time rather than relaunching a fleet at once', async () => {
    // Arrange
    let inFlight = 0;
    let overlapped = false;
    const test = harness({
      sessions: [session('s-1', 'agent-a'), session('s-2', 'agent-a')],
      config: { ...enabledConfig, retryCooldownMinutes: 0 },
      migrate: async () => {
        inFlight += 1;
        if (inFlight > 1) overlapped = true;
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    // Act
    const report = await test.service.run();

    // Assert
    should(overlapped).be.false();
    should(report.moved).have.length(2);
  });

  it('should report what it skipped and why, not merely that nothing moved', async () => {
    // Arrange
    const test = harness({ sessions: [session('s-9', 'agent-z')] });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.skipped).deepEqual([
      { sessionId: 's-9', reason: 'agent-z is not in the quota-failover pool, so this session has not opted in' },
    ]);
  });

  it('should drop ledger records for sessions this daemon no longer holds', async () => {
    // Arrange
    const stored = { sessions: { 's-gone': { moves: [] }, 's-1': { moves: [] } } };
    const test = harness({ stored, sessions: [session('s-1', 'agent-a')] });

    // Act
    await test.service.run();

    // Assert
    should(Object.keys(test.writes.at(-1)?.sessions ?? {})).deepEqual(['s-1']);
  });
});

describe('the quota-failover tick halts', () => {
  it('should halt without touching the usage feed when failover is disabled', async () => {
    // Arrange — a switched-off subsystem must not be the reason a collector is probed every tick
    const test = harness({ config: { enabled: false } });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.halted).equal('automatic quota failover is disabled (enabled=false)');
    should(test.writes).be.empty();
    should(test.probes()).equal(0);
  });

  it('should halt, and say why, when the ledger is damaged', async () => {
    // Arrange — an unreadable ledger must not become an unlimited move budget
    const test = harness({ stored: { sessions: { 's-1': { moves: 42 } } } });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.halted).match(/did not validate/);
    should(test.migrations).be.empty();
  });

  it('should carry the configuration warning onto a tick that used the defaults', async () => {
    // Arrange
    const test = harness({ config: { enabled: true, accounts: ['agent-a'], headroomPercent: -4 } });

    // Act
    const report = await test.service.run();

    // Assert — the defaults are off, so the tick halts AND explains the document
    should(report.halted).equal('automatic quota failover is disabled (enabled=false)');
    should(report.warnings).have.length(1);
    should(report.warnings[0]).match(/headroomPercent/);
  });

  it('should halt rather than reject when the configuration cannot be read at all', async () => {
    // Arrange — a background timer must never take a daemon down
    const test = harness({ configError: new Error('EACCES') });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.halted).equal('the quota-failover configuration could not be read: EACCES');
  });

  it('should halt rather than reject when the roster cannot be read', async () => {
    // Arrange — an empty roster from a failed read would prune the whole ledger
    const test = harness({ rosterError: new Error('the index is closed') });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.halted).equal('the index is closed');
    should(test.writes).be.empty();
  });

  it('should halt and still stamp the ledger when the usage snapshot is stale', async () => {
    // Arrange
    const test = harness({ snapshotAt: AT - 3_600_000 });

    // Act
    const report = await test.service.run();

    // Assert — a halted tick is visible as a tick rather than as silence
    should(report.halted).match(/freshness ceiling/);
    should(test.writes.at(-1)?.lastTick?.summary).match(/^halted: /);
  });
});

describe('the quota-failover loop', () => {
  it('should read its cadence from the operator document', async () => {
    // Arrange
    const test = harness({ config: { ...enabledConfig, intervalMinutes: 9 } });

    // Act / Assert
    should(await test.service.intervalMs()).equal(540_000);
  });

  it('should fall back to the default cadence when the document cannot be read', async () => {
    // Arrange — a cadence is needed to arm the timer at all; the tick itself will halt and say why
    const test = harness({ configError: new Error('EACCES') });

    // Act / Assert
    should(await test.service.intervalMs()).equal(300_000);
  });

  it('should never let two ticks read the same ledger before either wrote', async () => {
    // Arrange — the second would re-spend a budget the first had already spent
    let concurrent = 0;
    let overlapped = false;
    const test = harness({
      migrate: async () => {
        concurrent += 1;
        if (concurrent > 1) overlapped = true;
        await Promise.resolve();
        await Promise.resolve();
        concurrent -= 1;
      },
    });

    // Act
    const [first, second] = await Promise.all([test.service.run(), test.service.run()]);

    // Assert
    should(overlapped).be.false();
    should(first.halted).be.undefined();
    should(second.halted).be.undefined();
  });

  it('should keep ticking after a tick that threw', async () => {
    // Arrange — chaining only on success would wedge failover permanently the first time one failed
    let attempts = 0;
    const test = harness({
      migrate: async () => {
        attempts += 1;
        throw new Error('refused');
      },
    });

    // Act
    await test.service.run();
    await test.service.run();

    // Assert — the second tick is inside the retry cooldown, so it plans nothing but it DID run
    should(attempts).equal(1);
    should(test.writes.at(-1)?.lastTick).not.be.undefined();
  });

  it('should complete the tick even when the ledger cannot be written', async () => {
    // Arrange — the move already happened, and the report is still worth returning
    const test = harness({ writeError: new Error('the disk is full') });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.moved).have.length(1);
  });

  it('should complete the tick even when the journal cannot be written', async () => {
    // Arrange
    const test = harness({ journalError: new Error('the journal is gone') });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.moved).have.length(1);
  });

  it('should complete the stranded report even when the journal cannot be written', async () => {
    // Arrange
    const test = harness({ usage: [spentRow('agent-a'), spentRow('agent-b')], journalError: new Error('gone') });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.stranded).have.length(1);
  });

  it('should complete the tick even when a refusal cannot be journalled', async () => {
    // Arrange
    const test = harness({
      journalError: new Error('gone'),
      migrate: async () => {
        throw new Error('refused');
      },
    });

    // Act
    const report = await test.service.run();

    // Assert
    should(report.failed).have.length(1);
  });
});
