import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, type WardenConfig } from '@ferretry/protocol';
import should from 'should';
import type { AgentJob } from '../../../src/lib/migrate/agent-jobs.ts';
import { EMPTY_AUTO_MIGRATE_MEMORY, recordMove } from '../../../src/lib/warden/auto-migrate.ts';
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

const limited = (id = 's1', status = 'rate_limited'): WardenSessionView =>
  ({
    config: { id, mode: 'auto', agent: 'claude-a-wrapper', harness: 'claude' },
    state: { status },
    hasLiveMonitor: true,
  }) as WardenSessionView;

const fleetFacts = facts({
  runtimes: [runtime('claude-a'), runtime('claude-b')],
  credentials: [credential('claude-a-login'), credential('claude-b-login')],
  tools: [tool('claude', true)],
});

const job: AgentJob = { pid: 4242, command: 'bun run dev' };

interface Recorded {
  readonly migrations: { sessionId: string; agent: string; force: boolean; note: string }[];
  readonly asked: string[];
  readonly stoppedFor: string[];
  readonly notices: { sessionId: string; title: string; subject: string }[];
  readonly events: { sessionId: string; type: string; data: Readonly<Record<string, unknown>> }[];
}

function subject(
  options: {
    readonly hold?: string;
    readonly jobs?: () => readonly AgentJob[];
    readonly stop?: () => StoppedAgentJobs;
    readonly migrate?: () => void;
    readonly facts?: typeof fleetFacts;
  } = {},
) {
  const recorded: Recorded = { migrations: [], asked: [], stoppedFor: [], notices: [], events: [] };
  const service = new WardenAutoMigrateService({
    facts: async () => options.facts ?? fleetFacts,
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
      options.migrate?.();
      recorded.migrations.push({ sessionId, ...request });
    },
    notifyOwner: async notice => {
      recorded.notices.push({ sessionId: notice.sessionId, title: notice.title, subject: notice.subject });
    },
    emit: async (sessionId, type, data) => {
      recorded.events.push({ sessionId, type, data });
    },
    journal: { record: () => undefined },
  });
  return { service, recorded };
}

describe('WardenAutoMigrateService.run', () => {
  it('should do nothing while moving is off', async () => {
    // Arrange
    const { service, recorded } = subject();

    // Act
    const result = await service.run({
      fleet: [limited()],
      config: config({ enabled: false }),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });

    // Assert
    should(result.actions).deepEqual([]);
    should(recorded.migrations).deepEqual([]);
  });

  it('should move a rate-limited ferret to a ready login and record it as an automatic failover', async () => {
    // Arrange
    const { service, recorded } = subject();

    // Act
    const result = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });

    // Assert
    should(recorded.migrations).deepEqual([
      {
        sessionId: 's1',
        agent: 'claude-b-wrapper',
        force: false,
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
    should(result.memory.sessions.s1?.moves).deepEqual(['2026-11-01T12:00:00.000Z']);
    should(recorded.events.map(event => event.type)).deepEqual(['warden.auto_migrated']);
  });

  it('should not move a ferret holding an input card, a secret or an owner prompt, and record that once', async () => {
    // Arrange
    const { service, recorded } = subject({ hold: 'it has an input card open' });

    // Act
    const first = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });
    const second = await service.run({
      fleet: [limited()],
      config: config(),
      memory: first.memory,
      nowMs: NOW + MINUTE,
    });

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
    const { service, recorded } = subject();
    const memory = recordMove(EMPTY_AUTO_MIGRATE_MEMORY, 's1', NOW - 20 * MINUTE);

    // Act
    const result = await service.run({ fleet: [limited()], config: config(), memory, nowMs: NOW });

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
    const { service, recorded } = subject({ facts: spent });

    // Act
    const result = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });

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
    const { service, recorded } = subject({ jobs: () => running });

    // Act
    const asked = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });
    const waiting = await service.run({
      fleet: [limited()],
      config: config(),
      memory: asked.memory,
      nowMs: NOW + 2 * MINUTE,
    });
    running = [];
    const moved = await service.run({
      fleet: [limited()],
      config: config(),
      memory: waiting.memory,
      nowMs: NOW + 4 * MINUTE,
    });

    // Assert
    should(recorded.asked).deepEqual(['s1']);
    should(asked.actions).deepEqual([]);
    should(waiting.actions).deepEqual([]);
    should(recorded.stoppedFor).deepEqual([]);
    should(recorded.migrations.map(migration => [migration.agent, migration.force])).deepEqual([
      ['claude-b-wrapper', false],
    ]);
    should(moved.actions[0]?.outcome).equal('done');
    should(moved.memory.sessions.s1?.asked).be.undefined();
  });

  it('should tell the owner when the jobs are still running after the wait, and never stop them itself', async () => {
    // Arrange
    const { service, recorded } = subject({ jobs: () => [job] });

    // Act
    const asked = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });
    const expired = await service.run({
      fleet: [limited()],
      config: config(),
      memory: asked.memory,
      nowMs: NOW + 10 * MINUTE,
    });
    const later = await service.run({
      fleet: [limited()],
      config: config(),
      memory: expired.memory,
      nowMs: NOW + 12 * MINUTE,
    });

    // Assert
    should(recorded.asked).deepEqual(['s1']);
    should(recorded.stoppedFor).deepEqual([]);
    should(recorded.migrations).deepEqual([]);
    should(expired.actions.map(action => action.detail)).deepEqual([
      'Not moved although claude-a-wrapper hit its usage limit: it was asked to stop its background jobs 10 min ago and these still run: pid 4242 (bun run dev).',
    ]);
    should(later.actions).deepEqual([]);
    should(recorded.notices).have.length(1);
  });

  it('should stop the ferret’s own jobs itself when force-stop is on, say what it stopped, and move it', async () => {
    // Arrange
    const { service, recorded } = subject({ jobs: () => [job] });

    // Act
    const result = await service.run({
      fleet: [limited()],
      config: config({ forceStopBackground: true }),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });

    // Assert
    should(recorded.asked).deepEqual([]);
    should(recorded.stoppedFor).deepEqual(['s1']);
    should(recorded.migrations).deepEqual([
      {
        sessionId: 's1',
        agent: 'claude-b-wrapper',
        force: true,
        note: moveNote('claude-a-wrapper', 'claude-b-wrapper', 'claude-a-wrapper hit its usage limit', [job]),
      },
    ]);
    should(result.actions[0]?.detail).equal(
      'Moved it from claude-a-wrapper to claude-b-wrapper because claude-a-wrapper hit its usage limit. Stopped its background jobs first: pid 4242 (bun run dev).',
    );
    should(recorded.events.map(event => event.type)).deepEqual([
      'warden.auto_migrate_stopped_jobs',
      'warden.auto_migrated',
    ]);
    should(recorded.events[0]?.data).deepEqual({ stopped: [{ pid: 4242, command: 'bun run dev' }], survivors: [] });
  });

  it('should not move a ferret whose jobs survived being stopped', async () => {
    // Arrange
    const { service, recorded } = subject({ jobs: () => [job], stop: () => ({ stopped: [], survivors: [job] }) });

    // Act
    const result = await service.run({
      fleet: [limited()],
      config: config({ forceStopBackground: true }),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });

    // Assert
    should(recorded.migrations).deepEqual([]);
    should(result.actions[0]?.detail).match(/still running after the Warden stopped them: pid 4242/);
    should(recorded.notices).have.length(1);
  });

  it('should record a move that did not take as failed, once, and tell the owner', async () => {
    // Arrange
    const { service, recorded } = subject({
      migrate: () => {
        throw new Error('the safety check refused');
      },
    });

    // Act
    const first = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });
    const second = await service.run({
      fleet: [limited()],
      config: config(),
      memory: first.memory,
      nowMs: NOW + MINUTE,
    });

    // Assert
    should(first.actions.map(action => action.outcome)).deepEqual(['failed']);
    should(first.actions[0]?.detail).match(/did not take: the safety check refused/);
    should(second.actions).deepEqual([]);
    should(recorded.notices).have.length(1);
  });

  it('should forget what a ferret was held for once its limit is over, so a new limit is told afresh', async () => {
    // Arrange
    const { service } = subject({ hold: 'it has an input card open' });
    const held = await service.run({
      fleet: [limited()],
      config: config(),
      memory: EMPTY_AUTO_MIGRATE_MEMORY,
      nowMs: NOW,
    });

    // Act
    const reset = await service.run({
      fleet: [limited('s1', 'running')],
      config: config(),
      memory: held.memory,
      nowMs: NOW + MINUTE,
    });
    const again = await service.run({
      fleet: [limited()],
      config: config(),
      memory: reset.memory,
      nowMs: NOW + 2 * MINUTE,
    });

    // Assert
    should(reset.memory.sessions.s1).be.undefined();
    should(again.actions.map(action => action.outcome)).deepEqual(['held']);
  });
});

describe('WardenAutoMigrateService.relocate', () => {
  const overBudget = {
    id: 's1',
    agent: 'claude-a-wrapper',
    harness: 'claude' as const,
    mode: 'auto' as const,
    trigger: 'budget_exceeded' as const,
  };

  it('should move a ferret whose login passed its hard budget, when that is a trigger', async () => {
    // Arrange
    const { service, recorded } = subject();

    // Act
    const result = await service.relocate(overBudget, config(), EMPTY_AUTO_MIGRATE_MEMORY, NOW);
    const notTrigger = await service.relocate(
      overBudget,
      config({ when: ['rate_limited'] }),
      EMPTY_AUTO_MIGRATE_MEMORY,
      NOW,
    );

    // Assert
    should(result.moved).be.true();
    should(recorded.migrations[0]?.note).match(/passed its hard spend budget on this machine/);
    should(notTrigger.moved).be.false();
    should(recorded.migrations).have.length(1);
  });

  it('should not wait for jobs on a budget stop: without force-stop the ferret is left to the stop', async () => {
    // Arrange
    const { service, recorded } = subject({ jobs: () => [job] });

    // Act
    const result = await service.relocate(overBudget, config(), EMPTY_AUTO_MIGRATE_MEMORY, NOW);

    // Assert
    should(result.moved).be.false();
    should(recorded.asked).deepEqual([]);
    should(result.action?.outcome).equal('held');
  });
});
