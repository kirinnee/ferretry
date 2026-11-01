import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, type WardenConfig } from '@ferretry/protocol';
import should from 'should';
import { WardenAutoMigrateService, type WardenFleetSession } from '../../../src/lib/warden/index.ts';
import { credential, facts, runtime, tool } from '../pack/support.ts';
import { enabled, harness, session } from './sweep-harness.ts';

const moving = (changes: Partial<WardenConfig['autoMigrate']> = {}): WardenConfig =>
  enabled({ autoMigrate: { ...DEFAULT_WARDEN_CONFIG.autoMigrate, enabled: true, ...changes } });

/** A ferret sitting on a usage limit that has not reset: nothing the detector flags yet. */
const limited = (id = 's1'): WardenFleetSession => {
  const view = session({ id, status: 'rate_limited', state: { quota: { resetAt: Date.parse('2099-01-01') } } });
  return { ...view, config: { ...view.config, agent: 'claude-a-wrapper', harness: 'claude' } };
};

function mover(moved: { sessionId: string; agent: string }[]) {
  return new WardenAutoMigrateService({
    facts: async () =>
      facts({
        runtimes: [runtime('claude-a'), runtime('claude-b')],
        credentials: [credential('claude-a-login'), credential('claude-b-login')],
        tools: [tool('claude', true)],
      }),
    ownerHold: async () => undefined,
    blockingJobs: async () => [],
    askToStopJobs: async () => undefined,
    stopJobs: async () => ({ stopped: [], survivors: [] }),
    migrate: async (sessionId, request) => {
      moved.push({ sessionId, agent: request.agent });
    },
    notifyOwner: async () => undefined,
    emit: async () => undefined,
    journal: { record: () => undefined },
  });
}

describe('moving a ferret that hit a limit, in the sweep', () => {
  it('should move a rate-limited ferret, list it under Recent actions as automatic and count it as moved', async () => {
    // Arrange
    const moved: { sessionId: string; agent: string }[] = [];
    const subject = harness({ config: moving(), fleet: [limited()], autoMigrate: mover(moved) });

    // Act
    await subject.service.run({ force: false });
    const status = await subject.service.status();

    // Assert
    should(moved).deepEqual([{ sessionId: 's1', agent: 'claude-b-wrapper' }]);
    should(subject.state().actions?.[0]).match({
      action: 'failover',
      outcome: 'done',
      actor: 'auto',
      agent: 'claude-b-wrapper',
      fromAgent: 'claude-a-wrapper',
    });
    should(subject.state().autoMigrate?.sessions.s1?.moves).have.length(1);
    should(status.actionTotals?.find(entry => entry.action === 'failover' && entry.outcome === 'done')).containEql({
      auto: 1,
    });
  });

  it('should move nothing while the setting is off', async () => {
    // Arrange
    const moved: { sessionId: string; agent: string }[] = [];
    const subject = harness({ config: enabled(), fleet: [limited()], autoMigrate: mover(moved) });

    // Act
    await subject.service.run({ force: false });

    // Assert
    should(moved).deepEqual([]);
    should(subject.state().actions ?? []).deepEqual([]);
  });

  it('should move a ferret past its hard budget when asked to, and only when budgets are a trigger', async () => {
    // Arrange
    const moved: { sessionId: string; agent: string }[] = [];
    const running = { ...limited(), state: { status: 'running' as const } };
    const on = harness({ config: moving(), fleet: [running], autoMigrate: mover(moved) });
    const off = harness({ config: moving({ when: ['rate_limited'] }), fleet: [running], autoMigrate: mover(moved) });

    // Act
    const yes = await on.service.relocate('s1', 'budget_exceeded');
    const no = await off.service.relocate('s1', 'budget_exceeded');

    // Assert
    should(yes).be.true();
    should(no).be.false();
    should(moved).deepEqual([{ sessionId: 's1', agent: 'claude-b-wrapper' }]);
    should(on.state().actions?.[0]).match({ action: 'failover', outcome: 'done', actor: 'auto' });
  });

  it('should never move a warden through the budget path', async () => {
    // Arrange
    const moved: { sessionId: string; agent: string }[] = [];
    const warden = { ...limited(), config: { ...limited().config, label: 'fleet-warden' } };
    const subject = harness({ config: moving(), fleet: [warden], autoMigrate: mover(moved) });

    // Act
    const result = await subject.service.relocate('s1', 'budget_exceeded');

    // Assert
    should(result).be.false();
    should(moved).deepEqual([]);
  });
});
