import { describe, it } from 'bun:test';
import should from 'should';
import {
  emptyQuotaFailoverState,
  planQuotaFailover,
  type QuotaFailoverPlanInput,
  QuotaFailoverConfigSchema,
} from '../../../src/lib/quota-failover/index.ts';
import { account, AT, config, healthyRow, session, spentRow } from './fixtures.ts';

const input = (overrides: Partial<QuotaFailoverPlanInput> = {}): QuotaFailoverPlanInput => ({
  config: config(),
  state: emptyQuotaFailoverState,
  sessions: [session('s-1', 'agent-a')],
  accounts: [account('agent-a'), account('agent-b')],
  usage: [spentRow('agent-a'), healthyRow('agent-b', 15)],
  snapshotAt: AT - 1_000,
  nowMs: AT,
  ...overrides,
});

/** The planned branch, narrowed, so a test can read the three lists without re-asserting the variant. */
const planned = (plan: ReturnType<typeof planQuotaFailover>) => {
  should(plan.kind).equal('planned');
  if (plan.kind !== 'planned') throw new Error('unreachable: the assertion above already failed');
  return plan;
};

describe('planQuotaFailover halts', () => {
  it('should halt when the operator has not enabled failover', () => {
    // Arrange / Act
    const plan = planQuotaFailover(input({ config: QuotaFailoverConfigSchema.parse({ accounts: ['agent-a'] }) }));

    // Assert
    should(plan).deepEqual({ kind: 'halted', reason: 'automatic quota failover is disabled (enabled=false)' });
  });

  it('should halt when failover is on but nothing is pooled', () => {
    // Arrange — the switch alone opts nobody in, and saying so beats silently doing nothing
    const plan = planQuotaFailover(input({ config: QuotaFailoverConfigSchema.parse({ enabled: true }) }));

    // Assert
    should(plan.kind).equal('halted');
    should(plan.kind === 'halted' && plan.reason).match(/no accounts are pooled/);
  });

  it('should halt when the usage feed has never collected', () => {
    // Arrange — "the feed is down, so no account looks exhausted, so all is well" is the failure
    // this variant exists to make impossible
    const plan = planQuotaFailover(input({ snapshotAt: undefined }));

    // Assert
    should(plan.kind).equal('halted');
    should(plan.kind === 'halted' && plan.reason).match(/never collected a snapshot/);
  });

  it('should halt when the usage snapshot is stale', () => {
    // Arrange — a migration destroys a pane, and an old reading is a guess about the present
    const plan = planQuotaFailover(input({ snapshotAt: AT - 3_600_000 }));

    // Assert
    should(plan.kind).equal('halted');
    should(plan.kind === 'halted' && plan.reason).match(/freshness ceiling/);
  });
});

describe('planQuotaFailover', () => {
  it('should plan a move for a session whose account is measurably out of tokens', () => {
    // Act
    const plan = planned(planQuotaFailover(input()));

    // Assert
    should(plan.migrations).have.length(1);
    should(plan.migrations[0]?.session.id).equal('s-1');
    should(plan.migrations[0]?.target).deepEqual({ agent: 'agent-b', spentPercent: 15 });
    should(plan.migrations[0]?.evidence).match(/measured agent-a at its limit/);
  });

  it('should leave a session on an account outside the pool alone', () => {
    // Arrange — pool membership IS the opt-in
    const plan = planned(planQuotaFailover(input({ sessions: [session('s-1', 'agent-z')] })));

    // Assert
    should(plan.migrations).be.empty();
    should(plan.skipped[0]?.reason).equal(
      'agent-z is not in the quota-failover pool, so this session has not opted in',
    );
  });

  it.each([
    { status: 'created' as const },
    { status: 'starting' as const },
    { status: 'retrying' as const },
    { status: 'kill_failed' as const },
    { status: 'completed' as const },
    { status: 'failed' as const },
    { status: 'stopped' as const },
  ])('should leave a $status session alone', ({ status }) => {
    // Act
    const plan = planned(planQuotaFailover(input({ sessions: [session('s-1', 'agent-a', { status })] })));

    // Assert
    should(plan.migrations).be.empty();
    should(plan.skipped[0]?.reason).equal(`its status is ${status}, which has no next turn to protect`);
  });

  it.each([
    { status: 'running' as const },
    { status: 'thinking' as const },
    { status: 'tool_running' as const },
    { status: 'awaiting_question' as const },
    { status: 'awaiting_user' as const },
    { status: 'interrupted' as const },
    { status: 'rate_limited' as const },
    { status: 'waiting' as const },
    { status: 'stalled' as const },
  ])('should plan a move for a $status session', ({ status }) => {
    // Act
    const plan = planned(planQuotaFailover(input({ sessions: [session('s-1', 'agent-a', { status })] })));

    // Assert
    should(plan.migrations).have.length(1);
  });

  it('should leave a session alone when nothing measured says its account ran out', () => {
    // Arrange
    const plan = planned(planQuotaFailover(input({ usage: [healthyRow('agent-a', 30), healthyRow('agent-b', 15)] })));

    // Assert
    should(plan.migrations).be.empty();
    should(plan.skipped[0]?.reason).equal('nothing measured says agent-a is out of tokens');
  });

  it('should leave a session alone once it has spent its move budget', () => {
    // Arrange
    const state = {
      sessions: {
        's-1': {
          moves: [{ from: 'agent-b', to: 'agent-a', at: '2025-01-01T00:00:00.000Z', evidence: 'at its limit' }],
        },
      },
    };

    // Act
    const plan = planned(planQuotaFailover(input({ state })));

    // Assert — the ceiling, not the cooldown: the move happened over a year before `nowMs`
    should(plan.migrations).be.empty();
    should(plan.skipped[0]?.reason).match(/already been moved automatically/);
  });

  it('should never send a session back to an account it was just moved off', () => {
    // Arrange — agent-a ran out and agent-b is the only other pool member, but the session came
    // FROM agent-b twenty minutes ago
    const state = {
      sessions: {
        's-1': {
          moves: [{ from: 'agent-b', to: 'agent-a', at: '2025-12-31T23:40:00.000Z', evidence: 'at its limit' }],
        },
      },
    };

    // Act
    const plan = planned(planQuotaFailover(input({ state, config: config({ maxMovesPerSession: 5 }) })));

    // Assert
    should(plan.migrations).be.empty();
    should(plan.stranded).have.length(1);
    should(plan.stranded[0]?.rejected['agent-b']).match(/moved off it/);
  });

  it('should report a session that is out of tokens with nowhere to go as stranded, not skipped', () => {
    // Arrange — the whole pool is spent, which is the one outcome an operator must act on
    const plan = planned(planQuotaFailover(input({ usage: [spentRow('agent-a'), spentRow('agent-b')] })));

    // Assert
    should(plan.migrations).be.empty();
    should(plan.skipped).be.empty();
    should(plan.stranded).deepEqual([
      {
        sessionId: 's-1',
        agent: 'agent-a',
        evidence: 'the usage feed measured agent-a at its limit (5h 100%)',
        rejected: {
          'agent-a': 'it is the account this session is already on',
          'agent-b': 'the account is at its usage limit',
        },
      },
    ]);
  });

  it('should decide each session in the fleet on its own evidence', () => {
    // Arrange
    const plan = planned(
      planQuotaFailover(
        input({
          sessions: [session('s-1', 'agent-a'), session('s-2', 'agent-b'), session('s-3', 'agent-z')],
        }),
      ),
    );

    // Assert
    should(plan.migrations.map(entry => entry.session.id)).deepEqual(['s-1']);
    should(plan.skipped.map(entry => entry.sessionId)).deepEqual(['s-2', 's-3']);
  });
});
