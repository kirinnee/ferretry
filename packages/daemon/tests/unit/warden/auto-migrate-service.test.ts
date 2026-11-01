import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, type WardenConfig } from '@ferretry/protocol';
import should from 'should';
import type { AgentJob } from '../../../src/lib/migrate/agent-jobs.ts';
import {
  type AutoMigrateMemory,
  type AutoMigrateSubject,
  EMPTY_AUTO_MIGRATE_MEMORY,
  recordMove,
} from '../../../src/lib/warden/auto-migrate.ts';
import {
  moveNote,
  type StoppedAgentJobs,
  WardenAutoMigrateService,
} from '../../../src/lib/warden/auto-migrate-service.ts';
import type { WardenSessionView } from '../../../src/lib/warden/types.ts';
import { credential, facts, runtime, tool } from '../pack/support.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const MINUTE = 60_000;

const config = (changes: Partial<WardenConfig['autoMigrate']> = {}): WardenConfig => ({
  ...DEFAULT_WARDEN_CONFIG,
  autoMigrate: { ...DEFAULT_WARDEN_CONFIG.autoMigrate, enabled: true, ...changes },
});

const limited = (id = 's1', status = 'rate_limited', agent = 'claude-a-wrapper'): WardenSessionView =>
  ({
    config: { id, mode: 'auto', agent, harness: 'claude' },
    state: { status },
    hasLiveMonitor: true,
  }) as WardenSessionView;

const fleetFacts = facts({
  runtimes: [runtime('claude-a'), runtime('claude-b'), runtime('claude-c')],
  credentials: [credential('claude-a-login'), credential('claude-b-login'), credential('claude-c-login')],
  tools: [tool('claude', true)],
});

const job: AgentJob = { pid: 4242, command: 'bun run dev' };

const overBudget: AutoMigrateSubject = {
  id: 's1',
  agent: 'claude-a-wrapper',
  harness: 'claude',
  mode: 'auto',
  trigger: 'budget_exceeded',
};

interface Recorded {
  readonly migrations: Record<string, unknown>[];
  readonly asked: string[];
  readonly stoppedFor: string[];
  readonly notices: { sessionId: string; title: string; subject: string }[];
  readonly events: { sessionId: string; type: string; data: Readonly<Record<string, unknown>> }[];
  readonly journal: string[];
  /** The ledger as the mover last wrote it. */
  ledger: unknown;
  /** The login each ferret is on now: a move changes it, as the real migration restamps the session. */
  readonly agents: Map<string, string>;
}

function subject(
  options: {
    readonly hold?: string;
    readonly jobs?: () => readonly AgentJob[];
    readonly stop?: () => StoppedAgentJobs;
    readonly migrate?: () => Promise<void> | void;
    readonly facts?: () => Promise<typeof fleetFacts>;
    readonly ledger?: unknown;
  } = {},
) {
  const recorded: Recorded = {
    migrations: [],
    asked: [],
    stoppedFor: [],
    notices: [],
    events: [],
    journal: [],
    ledger: options.ledger,
    agents: new Map([['s1', 'claude-a-wrapper']]),
  };
  const service = new WardenAutoMigrateService({
    facts: options.facts ?? (async () => fleetFacts),
    ownerHold: async () => options.hold,
    blockingJobs: async () => options.jobs?.() ?? [],
    askToStopJobs: async sessionId => {
      recorded.asked.push(sessionId);
    },
    stopJobs: async sessionId => {
      recorded.stoppedFor.push(sessionId);
      return options.stop?.() ?? { stopped: [job], survivors: [] };
    },
    migrate: async (sessionId, request) => {
      await options.migrate?.();
      recorded.migrations.push({ sessionId, ...request });
      recorded.agents.set(sessionId, request.agent);
    },
    agentOf: async sessionId => recorded.agents.get(sessionId),
    ledger: {
      read: async () => recorded.ledger,
      write: async memory => {
        recorded.ledger = memory;
      },
    },
    notifyOwner: async notice => {
      recorded.notices.push({ sessionId: notice.sessionId, title: notice.title, subject: notice.subject });
    },
    emit: async (sessionId, type, data) => {
      recorded.events.push({ sessionId, type, data });
    },
    journal: { record: type => void recorded.journal.push(type) },
  });
  const ledger = (): AutoMigrateMemory => (recorded.ledger ?? EMPTY_AUTO_MIGRATE_MEMORY) as AutoMigrateMemory;
  const sweep = async (
    nowMs = NOW,
    settings: WardenConfig = config(),
    fleet: readonly WardenSessionView[] = [limited('s1', 'rate_limited', recorded.agents.get('s1'))],
  ) => await service.run({ fleet, config: settings, nowMs });
  return { service, recorded, ledger, sweep };
}

describe('WardenAutoMigrateService.run', () => {
  it('should do nothing while moving is off', async () => {
    // Arrange
    const { recorded, sweep } = subject();

    // Act
    const result = await sweep(NOW, config({ enabled: false }));

    // Assert
    should(result.actions).deepEqual([]);
    should(recorded.migrations).deepEqual([]);
  });

  it('should move a rate-limited ferret to a ready login and record it as an automatic failover', async () => {
    // Arrange
    const { recorded, ledger, sweep } = subject();

    // Act
    const result = await sweep();

    // Assert
    should(recorded.migrations).deepEqual([
      {
        sessionId: 's1',
        agent: 'claude-b-wrapper',
        note: "Ferretry's Warden moved you from claude-a-wrapper to claude-b-wrapper because claude-a-wrapper hit its usage limit.",
      },
    ]);
    should(result.actions).deepEqual([
      {
        at: '2026-11-01T12:00:00.000Z',
        sessionId: 's1',
        action: 'failover',
        outcome: 'done',
        by: 'warden',
        actor: 'auto',
        agent: 'claude-b-wrapper',
        fromAgent: 'claude-a-wrapper',
        detail: 'Moved it from claude-a-wrapper to claude-b-wrapper because claude-a-wrapper hit its usage limit.',
      },
    ]);
    should([...result.moved]).deepEqual(['s1']);
    should(ledger().sessions.s1?.moves).deepEqual(['2026-11-01T12:00:00.000Z']);
    should(recorded.events.map(event => event.type)).deepEqual(['warden.auto_migrated']);
  });

  it('should not move a ferret holding an input card, a secret or an owner prompt, and record that once', async () => {
    // Arrange
    const { recorded, sweep } = subject({ hold: 'it has an input card open' });

    // Act
    const first = await sweep();
    const second = await sweep(NOW + MINUTE);

    // Assert
    should(recorded.migrations).deepEqual([]);
    should(first.actions.map(action => [action.outcome, action.detail])).deepEqual([
      ['held', 'Not moved although claude-a-wrapper hit its usage limit: it has an input card open.'],
    ]);
    should(second.actions).deepEqual([]);
    should(recorded.notices).deepEqual([]);
  });

  it('should not move one ferret more often than the settings allow in an hour, and tell the owner', async () => {
    // Arrange
    const { recorded, sweep } = subject({ ledger: recordMove(EMPTY_AUTO_MIGRATE_MEMORY, 's1', NOW - 20 * MINUTE) });

    // Act
    const result = await sweep();

    // Assert
    should(recorded.migrations).deepEqual([]);
    should(result.actions[0]?.outcome).equal('held');
    should(result.actions[0]?.detail).match(/already moved once in the last hour/);
    should(recorded.notices).have.length(1);
  });

  it('should tell the owner in one line which logins it tried and why when none can take the ferret', async () => {
    // Arrange
    const spent = facts({
      runtimes: [runtime('claude-a'), runtime('claude-b', { disabled: { source: 'runtime' } })],
      credentials: [credential('claude-a-login'), credential('claude-b-login')],
      tools: [tool('claude', true)],
    });
    const { recorded, sweep } = subject({ facts: async () => spent });

    // Act
    const result = await sweep();

    // Assert
    should(recorded.migrations).deepEqual([]);
    should(recorded.notices).have.length(1);
    should(recorded.notices[0]?.subject).equal(
      'Not moved although claude-a-wrapper hit its usage limit: no login could take it. Tried claude-b (claude-b cannot launch: it is disabled.).',
    );
    should(result.actions[0]?.outcome).equal('held');
  });

  it('should ask a ferret to stop its background jobs, wait, and move it once they stopped', async () => {
    // Arrange
    let running: readonly AgentJob[] = [job];
    const { recorded, ledger, sweep } = subject({ jobs: () => running });

    // Act
    const asked = await sweep();
    const waiting = await sweep(NOW + 2 * MINUTE);
    running = [];
    const moved = await sweep(NOW + 4 * MINUTE);

    // Assert
    should(recorded.asked).deepEqual(['s1']);
    should(asked.actions).deepEqual([]);
    should(waiting.actions).deepEqual([]);
    should(recorded.stoppedFor).deepEqual([]);
    should(recorded.migrations.map(migration => migration.agent)).deepEqual(['claude-b-wrapper']);
    should(moved.actions[0]?.outcome).equal('done');
    should(ledger().sessions.s1?.asked).be.undefined();
  });

  it('should tell the owner when the jobs are still running after the wait, and never stop them itself', async () => {
    // Arrange
    const { recorded, sweep } = subject({ jobs: () => [job] });

    // Act
    await sweep();
    const expired = await sweep(NOW + 10 * MINUTE);
    const later = await sweep(NOW + 12 * MINUTE);

    // Assert
    should(recorded.asked).deepEqual(['s1']);
    should(recorded.stoppedFor).deepEqual([]);
    should(recorded.migrations).deepEqual([]);
    should(expired.actions.map(action => action.detail)).deepEqual([
      'Not moved although claude-a-wrapper hit its usage limit: it was asked to stop its background jobs 10 min ago and these still run: pid 4242 (bun).',
    ]);
    should(later.actions).deepEqual([]);
    should(recorded.notices).have.length(1);
  });

  it('should stop the ferret’s own jobs itself when force-stop is on, then move it WITHOUT forcing the safety check', async () => {
    // Arrange
    const { recorded, sweep } = subject({ jobs: () => [job] });

    // Act
    const result = await sweep(NOW, config({ forceStopBackground: true }));

    // Assert
    should(recorded.asked).deepEqual([]);
    should(recorded.stoppedFor).deepEqual(['s1']);
    should(recorded.migrations).deepEqual([
      {
        sessionId: 's1',
        agent: 'claude-b-wrapper',
        note: moveNote('claude-a-wrapper', 'claude-b-wrapper', 'claude-a-wrapper hit its usage limit', [job]),
      },
    ]);
    should(result.actions[0]?.detail).equal(
      'Moved it from claude-a-wrapper to claude-b-wrapper because claude-a-wrapper hit its usage limit. Stopped its background jobs first: pid 4242 (bun).',
    );
    should(recorded.events.map(event => event.type)).deepEqual([
      'warden.auto_migrate_stopped_jobs',
      'warden.auto_migrated',
    ]);
    should(recorded.events[0]?.data).deepEqual({ stopped: [{ pid: 4242, program: 'bun' }], survivors: [] });
  });

  it('should stop nothing and force nothing when force-stop is on but no job is in the way, and stay put on a refusal', async () => {
    // Arrange: the safety check still refuses — a blind spot, or a blocker that is no job of the ferret's.
    const { recorded, sweep } = subject({
      jobs: () => [],
      migrate: () => {
        throw new Error('the pane could not be inspected');
      },
    });

    // Act
    const result = await sweep(NOW, config({ forceStopBackground: true }));

    // Assert
    should(recorded.stoppedFor).deepEqual([]);
    should(result.actions.map(action => action.outcome)).deepEqual(['failed']);
    should(result.actions[0]?.detail).match(/did not take: the pane could not be inspected/);
    should([...result.moved]).deepEqual([]);
  });

  it('should not move a ferret whose jobs survived being stopped', async () => {
    // Arrange
    const { recorded, sweep } = subject({ jobs: () => [job], stop: () => ({ stopped: [], survivors: [job] }) });

    // Act
    const result = await sweep(NOW, config({ forceStopBackground: true }));

    // Assert
    should(recorded.migrations).deepEqual([]);
    should(result.actions[0]?.detail).match(/still running after the Warden stopped them: pid 4242/);
    should(recorded.notices).have.length(1);
  });

  it('should record a move that did not take as failed, once, and tell the owner', async () => {
    // Arrange
    const { recorded, sweep } = subject({
      migrate: () => {
        throw new Error('the safety check refused');
      },
    });

    // Act
    const first = await sweep();
    const second = await sweep(NOW + MINUTE);

    // Assert
    should(first.actions.map(action => action.outcome)).deepEqual(['failed']);
    should(first.actions[0]?.detail).match(/did not take: the safety check refused/);
    should(second.actions).deepEqual([]);
    should(recorded.notices).have.length(1);
  });

  it('should forget what a ferret was held for once its limit is over, so a new limit is told afresh', async () => {
    // Arrange
    const { ledger, sweep } = subject({ hold: 'it has an input card open' });
    await sweep();

    // Act
    await sweep(NOW + MINUTE, config(), [limited('s1', 'running')]);
    const reset = ledger();
    const again = await sweep(NOW + 2 * MINUTE);

    // Assert
    should(reset.sessions.s1).be.undefined();
    should(again.actions.map(action => action.outcome)).deepEqual(['held']);
  });

  it('should say so and start over when the stored ledger is not a ledger', async () => {
    // Arrange
    const { recorded, sweep } = subject({ ledger: { sessions: 'garbage' } });

    // Act
    const result = await sweep();

    // Assert
    should(recorded.journal).containEql('fleet.warden_auto_migrate_ledger_reset');
    should(result.actions.map(action => action.outcome)).deepEqual(['done']);
  });
});

describe('WardenAutoMigrateService: one ledger for the sweep and the budget stop', () => {
  it('should let a budget stop that comes during a sweep see the sweep’s move, and not move the ferret again', async () => {
    // Arrange: the sweep's migration is in flight when the budget stop asks.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let first = true;
    const { service, recorded, ledger, sweep } = subject({
      migrate: async () => {
        if (first) {
          first = false;
          await gate;
        }
      },
    });

    // Act
    const sweeping = sweep();
    const budget = service.relocate(overBudget, config(), NOW + 1_000);
    release();
    const [swept, relocated] = await Promise.all([sweeping, budget]);

    // Assert
    should(recorded.migrations).have.length(1);
    should([...swept.moved]).deepEqual(['s1']);
    should(relocated).deepEqual({ away: true });
    should(ledger().sessions.s1?.moves).have.length(1);
  });

  it('should count a sweep’s move against a later budget move of the same ferret within the hour', async () => {
    // Arrange
    const { service, recorded, sweep } = subject();
    await sweep();
    const now = { ...overBudget, agent: 'claude-b-wrapper' };

    // Act
    const result = await service.relocate(now, config(), NOW + 10 * MINUTE);

    // Assert
    should(recorded.migrations).have.length(1);
    should(result.away).be.false();
    should(result.action?.detail).match(/already moved once in the last hour/);
  });
});

describe('WardenAutoMigrateService.relocate', () => {
  it('should move a ferret whose login passed its hard budget, when that is a trigger', async () => {
    // Arrange
    const { service, recorded } = subject();
    const other = subject();

    // Act
    const result = await service.relocate(overBudget, config(), NOW);
    const notTrigger = await other.service.relocate(overBudget, config({ when: ['rate_limited'] }), NOW);

    // Assert
    should(result.away).be.true();
    should(recorded.migrations[0]?.note).match(/passed its hard spend budget on this machine/);
    should(notTrigger.away).be.false();
    should(other.recorded.migrations).deepEqual([]);
  });

  it('should not wait for jobs on a budget stop: without force-stop the ferret is left to the stop', async () => {
    // Arrange
    const { service, recorded } = subject({ jobs: () => [job] });

    // Act
    const result = await service.relocate(overBudget, config(), NOW);

    // Assert
    should(result.away).be.false();
    should(recorded.asked).deepEqual([]);
    should(result.action?.outcome).equal('held');
  });
});

describe('WardenAutoMigrateService when a port fails', () => {
  it('should record an unexpected failure once, journal it, and not try again this episode', async () => {
    // Arrange
    let looks = 0;
    const { recorded, sweep } = subject({
      facts: async () => {
        looks += 1;
        throw new Error('the fleet catalog could not be read');
      },
    });

    // Act
    const first = await sweep();
    const second = await sweep(NOW + MINUTE);

    // Assert
    should(first.actions.map(action => [action.outcome, action.detail])).deepEqual([
      ['failed', 'Not moved: the fleet catalog could not be read.'],
    ]);
    should(recorded.journal).deepEqual(['fleet.warden_auto_migrate_failed']);
    should(second.actions).deepEqual([]);
    should(looks).equal(1);
  });
});

describe('WardenAutoMigrateService: what the owner’s words carry about a job', () => {
  it('should name a job by pid and program only to the owner, and tell the ferret its whole command', async () => {
    // Arrange: a command line carrying a credential no vault knows.
    const secret: AgentJob = { pid: 77, command: "/usr/bin/curl -H 'Authorization: Bearer sk-live-123' https://x" };
    const asked = subject({ jobs: () => [secret] });
    const forced = subject({ jobs: () => [secret], stop: () => ({ stopped: [secret], survivors: [] }) });

    // Act
    await asked.sweep();
    const timedOut = await asked.sweep(NOW + 10 * MINUTE);
    const moved = await forced.sweep(NOW, config({ forceStopBackground: true }));

    // Assert
    const ownerFacing = JSON.stringify([
      timedOut.actions,
      moved.actions,
      asked.recorded.notices,
      forced.recorded.notices,
      asked.recorded.events,
      forced.recorded.events,
    ]);
    should(ownerFacing).not.containEql('sk-live-123');
    should(ownerFacing).containEql('pid 77 (curl)');
    should(String(forced.recorded.migrations[0]?.note)).containEql('sk-live-123');
  });
});

describe('WardenAutoMigrateService.failoverTarget', () => {
  const source = { agent: 'claude-a-wrapper', harness: 'claude' as const };

  it('should answer the wrapper of the login the verdict named when it is ready, with no note', async () => {
    // Arrange
    const { service } = subject();

    // Act
    const target = await service.failoverTarget(source, 'claude-b', config());

    // Assert
    should(target).deepEqual({ agent: 'claude-b-wrapper' });
  });

  it('should answer the best ready login and why, when the named one is below the headroom floor', async () => {
    // Arrange
    const tight = facts({
      runtimes: [runtime('claude-a'), runtime('claude-b'), runtime('claude-c')],
      credentials: [
        credential('claude-a-login'),
        credential('claude-b-login', { usage: { fiveHour: { usedPercent: 90 }, weekly: {} } }),
        credential('claude-c-login'),
      ],
      tools: [tool('claude', true)],
    });
    const { service } = subject({ facts: async () => tight });

    // Act
    const target = await service.failoverTarget(source, 'claude-b', config({ minHeadroomPercent: 20 }));
    const lowered = await service.failoverTarget(source, 'claude-b', config({ minHeadroomPercent: 5 }));

    // Assert
    should(target.agent).equal('claude-c-wrapper');
    should(target.note).match(/^claude-b was turned down \(only 10% is left/);
    should(lowered).deepEqual({ agent: 'claude-b-wrapper' });
  });

  it('should refuse, naming every login tried, when none can take it', async () => {
    // Arrange
    const none = facts({
      runtimes: [runtime('claude-a'), runtime('claude-b')],
      credentials: [
        credential('claude-a-login'),
        credential('claude-b-login', { usage: { fiveHour: { usedPercent: 100 }, weekly: {} } }),
      ],
      tools: [tool('claude', true)],
    });
    const { service } = subject({ facts: async () => none });

    // Act
    const refused = service.failoverTarget(source, 'claude-b', config());

    // Assert
    await refused.then(
      () => should.fail('it was moved', 'it was refused'),
      (error: Error) => should(error.message).match(/^no login could take it\. Tried claude-b/),
    );
  });
});

describe('WardenAutoMigrateService.migrateCandidates', () => {
  it('should list the ready logins for each ferret, most headroom first', async () => {
    // Arrange
    const { service } = subject();

    // Act
    const listed = await service.migrateCandidates(
      [limited('s1'), limited('s2', 'rate_limited', 'claude-b-wrapper')],
      config(),
    );

    // Assert
    should(listed).deepEqual([
      { sessionId: 's1', currentAgent: 'claude-a-wrapper', candidates: ['claude-b-wrapper', 'claude-c-wrapper'] },
      { sessionId: 's2', currentAgent: 'claude-b-wrapper', candidates: ['claude-a-wrapper', 'claude-c-wrapper'] },
    ]);
  });

  it('should list no candidates when the fleet cannot be read, and skip a ferret with no recorded login', async () => {
    // Arrange
    const broken = subject({
      facts: async () => {
        throw new Error('no facts');
      },
    });
    const nameless = { ...limited('s3'), config: { ...limited('s3').config, agent: undefined } } as WardenSessionView;

    // Act
    const unread = await broken.service.migrateCandidates([limited('s1')], config());
    const skipped = await subject().service.migrateCandidates([nameless], config());

    // Assert
    should(unread).deepEqual([{ sessionId: 's1', currentAgent: 'claude-a-wrapper', candidates: [] }]);
    should(skipped).deepEqual([]);
  });
});
