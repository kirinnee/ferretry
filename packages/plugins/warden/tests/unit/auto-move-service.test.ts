import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_CONFIG, type WardenConfig } from '../../daemon/lib/protocol.ts';
import should from 'should';
import type { AgentJob } from '../../daemon/lib/foreign.ts';
import {
  type AutoMoveMemory,
  type AutoMoveSubject,
  EMPTY_AUTO_MOVE_MEMORY,
  recordMove,
  waitingFerrets,
} from '../../daemon/lib/auto-move.ts';
import { moveNote, type StoppedAgentJobs, WardenAutoMoveService } from '../../daemon/lib/auto-move-service.ts';
import type { WardenSessionView } from '../../daemon/lib/types.ts';
import { credential, facts, runtime, tool } from '../support/pack.ts';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const MINUTE = 60_000;

const config = (changes: Partial<WardenConfig['autoMove']> = {}): WardenConfig => ({
  ...DEFAULT_WARDEN_CONFIG,
  autoMove: { ...DEFAULT_WARDEN_CONFIG.autoMove, enabled: true, ...changes },
});

const limited = (id = 's1', status = 'rate_limited', agent = 'claude-a-wrapper', resetAt?: number): WardenSessionView =>
  ({
    config: { id, mode: 'auto', agent, harness: 'claude' },
    state: { status, ...(resetAt === undefined ? {} : { quota: { resetAt } }) },
    hasLiveMonitor: true,
  }) as WardenSessionView;

const fleetFacts = facts({
  runtimes: [runtime('claude-a'), runtime('claude-b'), runtime('claude-c')],
  credentials: [credential('claude-a-login'), credential('claude-b-login'), credential('claude-c-login')],
  tools: [tool('claude', true)],
});

const job: AgentJob = { pid: 4242, command: 'bun run dev' };

const overBudget: AutoMoveSubject = {
  id: 's1',
  agent: 'claude-a-wrapper',
  harness: 'claude',
  mode: 'auto',
  trigger: 'budget_exceeded',
};

interface Recorded {
  readonly moves: Record<string, unknown>[];
  readonly asked: string[];
  readonly resumed: string[];
  /** The turn each resume handed the ferret. */
  readonly resumeNotes: string[];
  readonly stoppedFor: string[];
  readonly notices: { sessionId: string; title: string; subject: string }[];
  readonly events: { sessionId: string; type: string; data: Readonly<Record<string, unknown>> }[];
  readonly journal: string[];
  /** The ledger as the mover last wrote it. */
  ledger: unknown;
  /** The login each ferret is on now: a move changes it, as the real move restamps the session. */
  readonly agents: Map<string, string>;
}

function subject(
  options: {
    readonly hold?: string;
    /** A hold read afresh each time, for a card that opens while the mover awaits. */
    readonly holdNow?: () => string | undefined;
    readonly jobs?: () => readonly AgentJob[];
    readonly stop?: () => StoppedAgentJobs;
    readonly move?: () => Promise<void> | void;
    readonly facts?: () => Promise<typeof fleetFacts>;
    readonly ledger?: unknown;
    readonly resume?: () => Promise<void> | void;
    /** Throws from this call of `agentOf` on (1-based), for a read that fails mid-run. */
    readonly agentOfThrowsFrom?: number;
    /** From this call of `agentOf` on (1-based), the ferret reads as already on another login. */
    readonly agentOfMovedFrom?: number;
  } = {},
) {
  let agentReads = 0;
  const recorded: Recorded = {
    moves: [],
    asked: [],
    resumed: [],
    resumeNotes: [],
    stoppedFor: [],
    notices: [],
    events: [],
    journal: [],
    ledger: options.ledger,
    agents: new Map([['s1', 'claude-a-wrapper']]),
  };
  const service = new WardenAutoMoveService({
    facts: options.facts ?? (async () => fleetFacts),
    ownerHold: async () => options.holdNow?.() ?? options.hold,
    blockingJobs: async () => options.jobs?.() ?? [],
    askToStopJobs: async sessionId => {
      recorded.asked.push(sessionId);
    },
    stopJobs: async sessionId => {
      recorded.stoppedFor.push(sessionId);
      return options.stop?.() ?? { stopped: [job], survivors: [] };
    },
    move: async (sessionId, request) => {
      await options.move?.();
      recorded.moves.push({ sessionId, ...request });
      recorded.agents.set(sessionId, request.agent);
    },
    resume: async (sessionId, message) => {
      await options.resume?.();
      recorded.resumed.push(sessionId);
      recorded.resumeNotes.push(message);
    },
    agentOf: async sessionId => {
      agentReads += 1;
      if (options.agentOfThrowsFrom !== undefined && agentReads >= options.agentOfThrowsFrom)
        throw new Error('ferrets did not answer');
      if (options.agentOfMovedFrom !== undefined && agentReads >= options.agentOfMovedFrom) return 'claude-c-wrapper';
      return recorded.agents.get(sessionId);
    },
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
  const ledger = (): AutoMoveMemory => (recorded.ledger ?? EMPTY_AUTO_MOVE_MEMORY) as AutoMoveMemory;
  const sweep = async (
    nowMs = NOW,
    settings: WardenConfig = config(),
    fleet: readonly WardenSessionView[] = [limited('s1', 'rate_limited', recorded.agents.get('s1'))],
  ) => await service.run({ fleet, config: settings, nowMs });
  /** One sweep over a ferret on a limit that resets at `resetAt`. */
  const sweepAt = async (resetAt: number | undefined, nowMs = NOW, settings: WardenConfig = config()) =>
    await sweep(nowMs, settings, [limited('s1', 'rate_limited', recorded.agents.get('s1'), resetAt)]);
  return { service, recorded, ledger, sweep, sweepAt };
}

describe('WardenAutoMoveService.run', () => {
  it('should do nothing while moving is off', async () => {
    // Arrange
    const { recorded, sweep } = subject();

    // Act
    const result = await sweep(NOW, config({ enabled: false }));

    // Assert
    should(result.actions).deepEqual([]);
    should(recorded.moves).deepEqual([]);
  });

  it('should move a rate-limited ferret to a ready login and record it as an automatic failover', async () => {
    // Arrange
    const { recorded, ledger, sweep } = subject();

    // Act
    const result = await sweep();

    // Assert
    should(recorded.moves).deepEqual([
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
    should(recorded.events.map(event => event.type)).deepEqual(['warden.auto_moved']);
  });

  it('should not move a ferret an owner card was opened on while the logins were being read', async () => {
    // Arrange: nothing open when the hold is first read; a card by the time the facts are back.
    let open = false;
    const { recorded, sweep } = subject({
      holdNow: () => (open ? 'it has an input card open' : undefined),
      facts: async () => {
        open = true;
        return fleetFacts;
      },
    });

    // Act
    const result = await sweep();

    // Assert
    should(recorded.moves).deepEqual([]);
    should(result.actions.map(action => action.outcome)).deepEqual(['held']);
    should(result.actions[0]?.detail).containEql('it has an input card open');
  });

  it('should treat a hold read that throws as a hold, and move nothing', async () => {
    // Arrange
    const { recorded, sweep } = subject({
      holdNow: () => {
        throw new Error('accounts exploded');
      },
    });

    // Act
    const result = await sweep();

    // Assert
    should(recorded.moves).deepEqual([]);
    should(result.actions[0]?.detail).containEql('accounts exploded');
  });

  it('should not move a ferret holding an input card, a secret or an owner prompt, and record that once', async () => {
    // Arrange
    const { recorded, sweep } = subject({ hold: 'it has an input card open' });

    // Act
    const first = await sweep();
    const second = await sweep(NOW + MINUTE);

    // Assert
    should(recorded.moves).deepEqual([]);
    should(first.actions.map(action => [action.outcome, action.detail])).deepEqual([
      ['held', 'Not moved although claude-a-wrapper hit its usage limit: it has an input card open.'],
    ]);
    should(second.actions).deepEqual([]);
    should(recorded.notices).deepEqual([]);
  });

  it('should not move one ferret more often than the settings allow in an hour, and tell the owner', async () => {
    // Arrange
    const { recorded, sweep } = subject({ ledger: recordMove(EMPTY_AUTO_MOVE_MEMORY, 's1', NOW - 20 * MINUTE) });

    // Act
    const result = await sweep();

    // Assert
    should(recorded.moves).deepEqual([]);
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
    should(recorded.moves).deepEqual([]);
    should(recorded.notices).have.length(1);
    should(recorded.notices[0]?.subject).equal(
      'Not moved although claude-a-wrapper hit its usage limit: no login could take it. Tried claude-b (claude-b cannot launch: it is disabled.). It stays where it is; resume it yourself when the limit is over.',
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
    should(recorded.moves.map(move => move.agent)).deepEqual(['claude-b-wrapper']);
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
    should(recorded.moves).deepEqual([]);
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
    should(recorded.moves).deepEqual([
      {
        sessionId: 's1',
        agent: 'claude-b-wrapper',
        note: moveNote('claude-a-wrapper', 'claude-b-wrapper', 'claude-a-wrapper hit its usage limit', [job]),
      },
    ]);
    should(result.actions[0]?.detail).equal(
      'Moved it from claude-a-wrapper to claude-b-wrapper because claude-a-wrapper hit its usage limit. Stopped its background jobs first: pid 4242 (bun).',
    );
    should(recorded.events.map(event => event.type)).deepEqual(['warden.auto_move_stopped_jobs', 'warden.auto_moved']);
    should(recorded.events[0]?.data).deepEqual({ stopped: [{ pid: 4242, program: 'bun' }], survivors: [] });
  });

  it('should stop nothing under a card that was opened while the jobs were being read, even with force-stop on', async () => {
    // Arrange: nothing open when the hold is first read; a card by the time the jobs are back.
    let open = false;
    const { recorded, sweep } = subject({
      holdNow: () => (open ? 'it has an input card open' : undefined),
      jobs: () => {
        open = true;
        return [job];
      },
    });

    // Act
    const result = await sweep(NOW, config({ forceStopBackground: true }));

    // Assert
    should(recorded.stoppedFor).deepEqual([]);
    should(recorded.moves).deepEqual([]);
    should(result.actions.map(action => action.outcome)).deepEqual(['held']);
    should(result.actions[0]?.detail).containEql('it has an input card open');
  });

  it('should stop nothing and force nothing when force-stop is on but no job is in the way, and stay put on a refusal', async () => {
    // Arrange: the safety check still refuses — a blind spot, or a blocker that is no job of the ferret's.
    const { recorded, sweep } = subject({
      jobs: () => [],
      move: () => {
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
    should(recorded.moves).deepEqual([]);
    should(result.actions[0]?.detail).match(/still running after the Warden stopped them: pid 4242/);
    should(recorded.notices).have.length(1);
  });

  it('should record a move that did not take as failed, once, and tell the owner', async () => {
    // Arrange
    const { recorded, sweep } = subject({
      move: () => {
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
    should(recorded.journal).containEql('fleet.warden_auto_move_ledger_reset');
    should(result.actions.map(action => action.outcome)).deepEqual(['done']);
  });
});

describe('WardenAutoMoveService: one ledger for the sweep and the budget stop', () => {
  it('should let a budget stop that comes during a sweep see the sweep’s move, and not move the ferret again', async () => {
    // Arrange: the sweep's move is in flight when the budget stop asks.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let first = true;
    const { service, recorded, ledger, sweep } = subject({
      move: async () => {
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
    should(recorded.moves).have.length(1);
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
    should(recorded.moves).have.length(1);
    should(result.away).be.false();
    should(result.action?.detail).match(/already moved once in the last hour/);
  });
});

describe('WardenAutoMoveService.relocate', () => {
  it('should move a ferret whose login passed its hard budget, when that is a trigger', async () => {
    // Arrange
    const { service, recorded } = subject();
    const other = subject();

    // Act
    const result = await service.relocate(overBudget, config(), NOW);
    const notTrigger = await other.service.relocate(overBudget, config({ when: ['rate_limited'] }), NOW);

    // Assert
    should(result.away).be.true();
    should(recorded.moves[0]?.note).match(/passed its hard spend budget on this machine/);
    should(notTrigger.away).be.false();
    should(other.recorded.moves).deepEqual([]);
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

describe('WardenAutoMoveService when a port fails', () => {
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
    should(recorded.journal).deepEqual(['fleet.warden_auto_move_failed']);
    should(second.actions).deepEqual([]);
    should(looks).equal(1);
  });
});

describe('WardenAutoMoveService: what the owner’s words carry about a job', () => {
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
    should(String(forced.recorded.moves[0]?.note)).containEql('sk-live-123');
  });
});

describe('WardenAutoMoveService.failoverTarget', () => {
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

describe('WardenAutoMoveService.moveCandidates', () => {
  it('should list the ready logins for each ferret, most headroom first', async () => {
    // Arrange
    const { service } = subject();

    // Act
    const listed = await service.moveCandidates(
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
    const unread = await broken.service.moveCandidates([limited('s1')], config());
    const skipped = await subject().service.moveCandidates([nameless], config());

    // Assert
    should(unread).deepEqual([{ sessionId: 's1', currentAgent: 'claude-a-wrapper', candidates: [] }]);
    should(skipped).deepEqual([]);
  });
});

describe('WardenAutoMoveService.failover', () => {
  it('should not carry out a verdict’s move on a ferret something of the owner’s is open on, and run nothing', async () => {
    // Arrange
    const { service, recorded } = subject({ hold: 'it has an input card open' });
    const executed: unknown[] = [];

    // Act
    const refusal = await service
      .failover(
        { sessionId: 's1', source: { agent: 'claude-a-wrapper', harness: 'claude' }, named: 'claude-b-wrapper' },
        config(),
        NOW,
        async target => void executed.push(target),
      )
      .catch((error: Error) => error);

    // Assert
    should((refusal as Error).message).equal('not moved: it has an input card open');
    should(executed).deepEqual([]);
    should(recorded.ledger).be.undefined();
  });

  it('should not carry out a verdict’s move on a ferret that is no longer on the login the verdict was about', async () => {
    // Arrange: a sweep or a person already moved it.
    const { service, recorded } = subject();
    recorded.agents.set('s1', 'claude-c-wrapper');
    const executed: unknown[] = [];

    // Act
    const refusal = await service
      .failover(
        { sessionId: 's1', source: { agent: 'claude-a-wrapper', harness: 'claude' }, named: 'claude-b-wrapper' },
        config(),
        NOW,
        async target => void executed.push(target),
      )
      .catch((error: Error) => error);

    // Assert
    should((refusal as Error).message).equal('it is no longer on the login the verdict was about, so it was not moved');
    should(executed).deepEqual([]);
  });
});

describe('WardenAutoMoveService: the owner’s targets are a hard list', () => {
  const left = (usedPercent: number) => ({ usage: { fiveHour: { usedPercent }, weekly: {} } });
  /** The ferret's own login, a personal login the owner listed, and a WORK login with far more room. */
  const withWork = (personalUsed: number) =>
    facts({
      // The work login is listed FIRST: nothing but the owner's list keeps the ferret off it.
      runtimes: [runtime('claude-a'), runtime('claude-liftoff'), runtime('personal-a')],
      credentials: [
        credential('claude-a-login'),
        credential('claude-liftoff-login', left(1)),
        credential('personal-a-login', left(personalUsed)),
      ],
      tools: [tool('claude', true)],
    });

  it('should move to the listed login, and only to it, though a work login has the most headroom', async () => {
    // Arrange
    const unlisted = subject({ facts: async () => withWork(40) });
    const listed = subject({ facts: async () => withWork(40) });

    // Act
    await unlisted.sweep();
    await listed.sweep(NOW, config({ targets: ['personal-a'] }));

    // Assert: with no list the work login wins, which is exactly what the list forbids
    should(unlisted.recorded.moves.map(move => move.agent)).deepEqual(['claude-liftoff-wrapper']);
    should(listed.recorded.moves.map(move => move.agent)).deepEqual(['personal-a-wrapper']);
  });

  it('should NOT move to the work login when the listed one has no headroom: it stays, and the owner is told once', async () => {
    // Arrange: personal-a is 95% used, under the 20% floor; claude-liftoff is nearly empty.
    const { recorded, sweep } = subject({ facts: async () => withWork(95) });
    const listed = config({ targets: ['personal-a'] });

    // Act
    const first = await sweep(NOW, listed);
    const second = await sweep(NOW + MINUTE, listed);

    // Assert
    should(recorded.moves).deepEqual([]);
    should(first.actions[0]?.outcome).equal('held');
    should(first.actions[0]?.detail).containEql('personal-a (only 5% is left');
    should(first.actions[0]?.detail).not.containEql('claude-liftoff');
    should(second.actions).deepEqual([]);
    should(recorded.notices).have.length(1);
  });

  it('should keep a ferret on a codex work login inside the list too', async () => {
    // Arrange
    const codex = facts({
      runtimes: [
        runtime('codex-a', { harness: 'codex' }),
        runtime('codex-personal', { harness: 'codex' }),
        runtime('codex-loai', { harness: 'codex' }),
      ],
      credentials: [
        credential('codex-a-login', { harness: 'codex' }),
        credential('codex-personal-login', { harness: 'codex', ...left(97) }),
        credential('codex-loai-login', { harness: 'codex', ...left(1) }),
      ],
      tools: [tool('codex', true)],
    });
    const { recorded, sweep } = subject({ facts: async () => codex });
    recorded.agents.set('s1', 'codex-a-wrapper');
    const view = {
      config: { id: 's1', mode: 'auto', agent: 'codex-a-wrapper', harness: 'codex' },
      state: { status: 'rate_limited' },
      hasLiveMonitor: true,
    } as WardenSessionView;

    // Act
    await sweep(NOW, config({ targets: ['codex-personal'] }), [view]);

    // Assert
    should(recorded.moves).deepEqual([]);
  });
});

describe('WardenAutoMoveService: nowhere to go, so wait and resume at the reset', () => {
  /** Every other login is switched off: no headroom anywhere. */
  const spent = facts({
    runtimes: [runtime('claude-a'), runtime('claude-b', { disabled: { source: 'runtime' } })],
    credentials: [credential('claude-a-login'), credential('claude-b-login')],
    tools: [tool('claude', true)],
  });
  const RESET_PAST = NOW - 5 * MINUTE;

  it('should resume the ferret by rule once its limit has reset, recording it as automatic and telling the owner once', async () => {
    // Arrange
    const { recorded, ledger, sweepAt } = subject({ facts: async () => spent });

    // Act
    const result = await sweepAt(RESET_PAST);

    // Assert
    should(recorded.moves).deepEqual([]);
    should(recorded.resumed).deepEqual(['s1']);
    should([...result.resumed]).deepEqual(['s1']);
    should([...result.moved]).deepEqual([]);
    should(result.actions.map(action => [action.action, action.outcome, action.actor, action.by])).deepEqual([
      ['failover', 'held', 'auto', 'warden'],
      ['resume', 'done', 'auto', 'warden'],
    ]);
    should(result.actions[1]?.detail).match(/^Resumed it on its own: the claude-a-wrapper limit reset at /);
    should(recorded.notices).have.length(1);
    should(recorded.notices[0]?.subject).containEql('is being resumed now');
    should(ledger().sessions.s1?.resumed).equal(new Date(RESET_PAST).toISOString());
    should(recorded.journal).containEql('fleet.warden_auto_resumed');
  });

  it('should wait before the reset, say when it will resume in Pacific time, and resume once it has passed', async () => {
    // Arrange: resets 2026-11-03 17:00Z = 9:00 AM PST.
    const reset = Date.parse('2026-11-03T17:00:00.000Z');
    const { recorded, ledger, sweepAt, sweep } = subject({ facts: async () => spent });

    // Act
    const before = await sweepAt(reset);
    const remembered = ledger().sessions.s1?.waiting;
    const during = await sweepAt(reset, reset - MINUTE);
    const after = await sweepAt(reset, reset + MINUTE);
    await sweep(reset + 2 * MINUTE, config(), [limited('s1', 'running')]);

    // Assert
    should(before.actions.map(action => action.action)).deepEqual(['failover']);
    should(before.actions[0]?.detail).match(/It stays where it is and resumes on its own at Nov 3, 9:00\sAM PST\.$/);
    should(recorded.notices).have.length(1);
    // It is remembered as waiting for this reset, so it is found again when Ferrets stops showing the limit …
    should(remembered).equal('2026-11-03T17:00:00.000Z');
    should(during.actions).deepEqual([]);
    should(after.actions.map(action => [action.action, action.outcome])).deepEqual([['resume', 'done']]);
    should(recorded.resumed).deepEqual(['s1']);
    should(recorded.resumeNotes[0]).match(
      /^Ferretry's Warden: the usage limit on claude-a-wrapper has reset \(Nov 3, 9:00\sAM PST\)\. Carry on/,
    );
    // … and forgotten once it is off the limit.
    should(ledger().sessions.s1).be.undefined();
    should(waitingFerrets(ledger())).deepEqual([]);
  });

  it('should name the ferrets it is waiting for, so the sweep can look at them after Ferrets drops the limit', async () => {
    // Arrange
    const reset = Date.parse('2026-11-03T17:00:00.000Z');
    const { ledger, sweepAt } = subject({ facts: async () => spent });

    // Act
    await sweepAt(reset);

    // Assert
    should(waitingFerrets(ledger())).deepEqual(['s1']);
  });

  it('should not wait on a later reset under the memory of an earlier one', async () => {
    // Arrange
    const first = Date.parse('2026-11-03T17:00:00.000Z');
    const second = Date.parse('2026-11-03T22:00:00.000Z');
    const { ledger, sweepAt } = subject({ facts: async () => spent });

    // Act
    await sweepAt(first);
    await sweepAt(second, first - MINUTE);

    // Assert
    should(ledger().sessions.s1?.waiting).equal('2026-11-03T22:00:00.000Z');
  });

  it('should resume at most once for one reset, even while the ferret still reads as limited', async () => {
    // Arrange
    const { recorded, sweepAt } = subject({ facts: async () => spent });

    // Act
    await sweepAt(RESET_PAST);
    const again = await sweepAt(RESET_PAST, NOW + MINUTE);

    // Assert
    should(recorded.resumed).deepEqual(['s1']);
    should(again.actions).deepEqual([]);
    should([...again.resumed]).deepEqual([]);
  });

  it('should resume again for a later reset, once the earlier one is over', async () => {
    // Arrange
    const later = NOW + 6 * 60 * MINUTE;
    const { recorded, ledger, sweepAt, sweep } = subject({ facts: async () => spent });

    // Act
    await sweepAt(RESET_PAST);
    await sweep(NOW + MINUTE, config(), [limited('s1', 'running')]);
    const settled = ledger().sessions.s1;
    await sweepAt(later, later + MINUTE);

    // Assert
    should(settled).be.undefined();
    should(recorded.resumed).deepEqual(['s1', 's1']);
  });

  it('should leave it alone when the owner does not let the Warden resume alone, and say so', async () => {
    // Arrange
    const noResume: WardenConfig = {
      ...config(),
      mayActAlone: { ...DEFAULT_WARDEN_CONFIG.mayActAlone, resume: false },
    };
    const { recorded, sweepAt } = subject({ facts: async () => spent });

    // Act
    const result = await sweepAt(RESET_PAST, NOW, noResume);

    // Assert
    should(recorded.resumed).deepEqual([]);
    should(result.actions.map(action => action.action)).deepEqual(['failover']);
    should(recorded.notices[0]?.subject).endWith('It stays where it is; resume it yourself when the limit is over.');
  });

  it('should not resume a ferret whose limit shows no reset time, and tell the owner to', async () => {
    // Arrange
    const { recorded, sweepAt } = subject({ facts: async () => spent });

    // Act
    await sweepAt(undefined);

    // Assert
    should(recorded.resumed).deepEqual([]);
    should(recorded.notices[0]?.subject).endWith('resume it yourself when the limit is over.');
  });

  it('should not resume a ferret something of the owner’s is open on', async () => {
    // Arrange
    const { recorded, sweepAt } = subject({ facts: async () => spent, hold: 'it has an input card open' });

    // Act
    const result = await sweepAt(RESET_PAST);

    // Assert
    should(recorded.resumed).deepEqual([]);
    should(result.actions.map(action => action.action)).deepEqual(['failover']);
  });

  it('should not resume a ferret that is no longer on the login whose limit it was', async () => {
    // Arrange: a person moved it while the logins were being read.
    const { recorded, sweepAt } = subject({ facts: async () => spent, agentOfMovedFrom: 2 });

    // Act: the first read (the guard) still sees claude-a; the read before the resume sees claude-c
    await sweepAt(RESET_PAST);

    // Assert
    should(recorded.resumed).deepEqual([]);
  });

  it('should record a resume Ferrets refused once as failed, and not ask again on the next sweep', async () => {
    // Arrange
    const { recorded, sweepAt } = subject({
      facts: async () => spent,
      resume: () => {
        throw new Error('it was stopped on purpose');
      },
    });

    // Act
    const first = await sweepAt(RESET_PAST);
    const second = await sweepAt(RESET_PAST, NOW + MINUTE);

    // Assert
    const failed = first.actions.find(action => action.action === 'resume');
    should(failed?.outcome).equal('failed');
    should(failed?.detail).containEql('it was stopped on purpose');
    should([...first.resumed]).deepEqual([]);
    should(recorded.resumed).deepEqual([]);
    should(second.actions).deepEqual([]);
  });

  it('should journal a ferret it could not read at the reset and carry on', async () => {
    // Arrange: the login reads fine at first (guard), and fail on the read before the resume.
    const { recorded, sweepAt } = subject({ facts: async () => spent, agentOfThrowsFrom: 2 });

    // Act
    const result = await sweepAt(RESET_PAST);

    // Assert
    should(recorded.resumed).deepEqual([]);
    should(recorded.journal).containEql('fleet.warden_auto_move_failed');
    should([...result.resumed]).deepEqual([]);
  });

  it('should resume nothing while moving is switched off', async () => {
    // Arrange
    const { recorded, sweepAt } = subject({ facts: async () => spent });

    // Act
    await sweepAt(RESET_PAST, NOW, config({ enabled: false }));

    // Assert
    should(recorded.resumed).deepEqual([]);
  });

  it('should not resume a ferret it just moved: the new login carries it on', async () => {
    // Arrange
    const { recorded, sweepAt } = subject();

    // Act
    const result = await sweepAt(RESET_PAST);

    // Assert
    should(recorded.moves).have.length(1);
    should(recorded.resumed).deepEqual([]);
    should([...result.resumed]).deepEqual([]);
  });
});
