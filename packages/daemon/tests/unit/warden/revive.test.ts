import { describe, it } from 'bun:test';
import { DEFAULT_WARDEN_REVIVE } from '@ferretry/protocol';
import should from 'should';
import {
  breakerVerdict,
  cascadeMembers,
  causeKey,
  causeText,
  classifyEnd,
  deathKey,
  EMPTY_REVIVE_STATE,
  planRevives,
  type ReviveEvent,
  type ReviveState,
  type ReviveSubject,
  reviveMessage,
  signalName,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();
const config = DEFAULT_WARDEN_REVIVE;

const exited = (data: Record<string, unknown>, time = ago(60)): ReviveEvent => ({
  type: 'session.exited',
  time,
  data: { status: 'failed', ...data },
});
const event = (type: string, time = ago(60)): ReviveEvent => ({ type, time, data: {} });

const subject = (id: string, overrides: Partial<ReviveSubject> = {}): ReviveSubject => ({
  id,
  mode: 'auto',
  cause: { kind: 'terminal_gone' },
  diedAt: ago(60),
  ...overrides,
});

const plan = (
  subjects: readonly ReviveSubject[],
  options: { fleet?: { id: string; status: string; parent?: string }[]; state?: ReviveState } = {},
) =>
  planRevives(
    subjects,
    options.fleet ?? subjects.map(entry => ({ id: entry.id, status: 'failed' })),
    options.state ?? EMPTY_REVIVE_STATE,
    NOW,
    config,
  );

describe('which deaths are revivable', () => {
  it('should read a vanished terminal as a revivable death', () => {
    // Act
    const verdict = classifyEnd('failed', [exited({ pane: 'gone', exitCode: null })]);

    // Assert
    should(verdict).deepEqual({ kind: 'revive', cause: { kind: 'terminal_gone' }, diedAt: ago(60) });
  });

  it('should read a recorded signal as that signal', () => {
    // Act / Assert
    should(classifyEnd('failed', [exited({ pane: 'exited', exitCode: null, signal: 9 })])).containDeep({
      kind: 'revive',
      cause: { kind: 'signal', signal: 9 },
    });
  });

  it('should read a shell-style 128+N exit code as a signal', () => {
    // Act / Assert
    should(classifyEnd('failed', [exited({ exitCode: 137 })])).containDeep({ cause: { kind: 'signal', signal: 9 } });
  });

  it('should read any other non-zero exit as the agent crashing', () => {
    // Act / Assert
    should(classifyEnd('failed', [exited({ exitCode: 2 })])).containDeep({
      cause: { kind: 'agent_crashed', exitCode: 2 },
    });
  });

  it('should leave exit 0 alone', () => {
    // Act / Assert
    should(classifyEnd('failed', [exited({ exitCode: 0 })])).deepEqual({ kind: 'leave', why: 'clean_exit' });
    should(classifyEnd('failed', [{ type: 'session.exited', time: ago(1), data: { status: 'completed' } }])).deepEqual({
      kind: 'leave',
      why: 'clean_exit',
    });
  });

  it('should leave an exit that recorded neither a pane, a signal nor a code', () => {
    // Act / Assert
    should(classifyEnd('failed', [exited({ pane: 'exited' })])).deepEqual({ kind: 'leave', why: 'unrecorded_exit' });
    should(classifyEnd('failed', [{ type: 'session.exited', time: ago(1), data: 'odd' }])).deepEqual({
      kind: 'leave',
      why: 'clean_exit',
    });
  });

  it('should never revive what someone stopped, finished or never started', () => {
    // Act / Assert
    should(classifyEnd('failed', [exited({ pane: 'gone' }), event('session.stopped')])).deepEqual({
      kind: 'leave',
      why: 'stopped',
    });
    should(classifyEnd('failed', [exited({ pane: 'gone' }), event('session.completed')])).deepEqual({
      kind: 'leave',
      why: 'completed',
    });
    should(classifyEnd('failed', [event('session.failed')])).deepEqual({ kind: 'leave', why: 'start_failed' });
  });

  it('should decide from the LAST terminal event only', () => {
    // Act / Assert
    should(classifyEnd('failed', [event('session.stopped', ago(300)), exited({ pane: 'gone' })]).kind).equal('revive');
  });

  it('should leave a session that is not failed now, or has no terminal event', () => {
    // Act / Assert
    should(classifyEnd('running', [exited({ pane: 'gone' })])).deepEqual({ kind: 'leave', why: 'not_failed' });
    should(classifyEnd('failed', [event('turn.started')])).deepEqual({ kind: 'leave', why: 'no_terminal_event' });
  });
});

describe('the plain words for a death', () => {
  it('should word each cause', () => {
    // Act / Assert
    should(causeText({ kind: 'tmux_crashed' })).equal('the tmux server crashed');
    should(causeText({ kind: 'terminal_gone' })).equal('its terminal disappeared');
    should(causeText({ kind: 'signal', signal: 9 })).equal('it was killed by a signal (SIGKILL)');
    should(causeText({ kind: 'signal', signal: 15 })).equal('it was killed by a signal (SIGTERM)');
    should(causeText({ kind: 'signal', signal: 99 })).equal('it was killed by a signal (signal 99)');
    should(causeText({ kind: 'agent_crashed', exitCode: 3 })).equal('the agent crashed (exit 3)');
    should(signalName(11)).equal('SIGSEGV');
  });

  it('should key each cause for the journal', () => {
    // Act / Assert
    should(causeKey({ kind: 'tmux_crashed' })).equal('tmux_crashed');
    should(causeKey({ kind: 'terminal_gone' })).equal('terminal_gone');
    should(causeKey({ kind: 'signal', signal: 9 })).equal('signal:SIGKILL');
    should(causeKey({ kind: 'agent_crashed', exitCode: 3 })).equal('exit:3');
  });

  it('should tell an auto session why and to carry on', () => {
    // Act
    const message = reviveMessage({ kind: 'signal', signal: 9 }, '2026-10-30T11:59:00.000Z', 'auto');

    // Assert
    should(message).startWith('[ferretry] Your terminal ended because it was killed by a signal (SIGKILL) at ');
    should(message).containEql('2026-10-30 11:59 UTC; it was started again.');
    should(message).containEql('Re-read your last turn file and continue');
  });

  it('should tell an interactive session the notice and nothing to do', () => {
    // Act
    const message = reviveMessage({ kind: 'tmux_crashed' }, '2026-10-30T11:59:00.000Z', 'interactive');

    // Assert
    should(message).equal(
      '[ferretry] Your terminal ended because the tmux server crashed at 2026-10-30 11:59 UTC; it was started again.',
    );
  });
});

describe('a fleet-wide death', () => {
  it('should be three deaths within ten seconds', () => {
    // Arrange
    const together = [
      subject('a', { diedAt: ago(60) }),
      subject('b', { diedAt: ago(58) }),
      subject('c', { diedAt: ago(55) }),
    ];

    // Act / Assert
    should([...cascadeMembers(together)].toSorted()).deepEqual(['a', 'b', 'c']);
    should([...cascadeMembers(together.slice(0, 2))]).deepEqual([]);
    should([
      ...cascadeMembers([subject('a'), subject('b', { diedAt: ago(40) }), subject('c', { diedAt: ago(20) })]),
    ]).deepEqual([]);
  });

  it('should name the tmux server as the cause of a terminal that vanished with others', () => {
    // Arrange
    const together = [
      subject('a', { diedAt: ago(60) }),
      subject('b', { diedAt: ago(59) }),
      subject('c', { diedAt: ago(58) }),
    ];

    // Act
    const planned = plan(together);

    // Assert
    should(planned.cascade).be.true();
    should(planned.waves.flat().map(entry => entry.cause.kind)).deepEqual([
      'tmux_crashed',
      'tmux_crashed',
      'tmux_crashed',
    ]);
  });

  it('should say a lone vanished terminal was only its own', () => {
    // Act
    const planned = plan([subject('a')]);

    // Assert
    should(planned.cascade).be.false();
    should(planned.waves[0]?.[0]?.cause).deepEqual({ kind: 'terminal_gone' });
  });
});

describe('who is revived, and who is refused', () => {
  it('should refuse a death older than the window', () => {
    // Act
    const planned = plan([subject('a', { diedAt: ago(16 * 60) })]);

    // Assert
    should(planned.waves).deepEqual([]);
    should(planned.refused.map(entry => entry.why)).deepEqual(['too_old']);
  });

  it('should refuse everything while the breaker is open', () => {
    // Arrange
    const state: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      breaker: { openedAt: ago(60), until: new Date(NOW + 60_000).toISOString(), why: 'x' },
    };

    // Act
    const planned = plan([subject('a')], { state });

    // Assert
    should(planned.refused.map(entry => entry.why)).deepEqual(['breaker_open']);
  });

  it('should revive again once the breaker has lapsed', () => {
    // Arrange
    const state: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      breaker: { openedAt: ago(3600), until: ago(60), why: 'x' },
    };

    // Act / Assert
    should(plan([subject('a')], { state }).waves).have.length(1);
  });

  it('should refuse a session whose lead, or any ancestor, was stopped', () => {
    // Arrange
    const fleet = [
      { id: 'kid', status: 'failed', parent: 'mid' },
      { id: 'mid', status: 'running', parent: 'lead' },
      { id: 'lead', status: 'stopped' },
    ];

    // Act
    const planned = plan([subject('kid', { parent: 'mid' })], { fleet });

    // Assert
    should(planned.refused.map(entry => entry.why)).deepEqual(['parent_stopped']);
  });

  it('should not loop on a parent cycle, and still revive the session', () => {
    // Arrange
    const fleet = [
      { id: 'a', status: 'failed', parent: 'b' },
      { id: 'b', status: 'failed', parent: 'a' },
    ];

    // Act
    const planned = plan([subject('a', { parent: 'b' }), subject('b', { parent: 'a' })], { fleet });

    // Assert
    should(planned.refused).deepEqual([]);
    should(
      planned.waves
        .flat()
        .map(entry => entry.id)
        .toSorted(),
    ).deepEqual(['a', 'b']);
  });

  it('should refuse a session revived within the cooldown, and allow it after', () => {
    // Arrange
    const within: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(10 * 60), attempts: 1, crashRevives: 0 } },
    };
    const after: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(31 * 60), attempts: 1, crashRevives: 0 } },
    };

    // Act / Assert
    should(plan([subject('a')], { state: within }).refused.map(entry => entry.why)).deepEqual(['cooldown']);
    should(plan([subject('a')], { state: after }).waves).have.length(1);
  });

  it('should revive a crash of the agent only once ever', () => {
    // Arrange
    const crashed = subject('a', { cause: { kind: 'agent_crashed', exitCode: 2 } });
    const state: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(5 * 3600), attempts: 1, crashRevives: 1 } },
    };

    // Act / Assert
    should(plan([crashed], { state }).refused.map(entry => entry.why)).deepEqual(['crash_repeat']);
    should(plan([crashed]).waves).have.length(1);
  });

  it('should report the first rule that applies', () => {
    // Arrange
    const state: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      sessions: { a: { revivedAt: ago(60), attempts: 1, crashRevives: 1 } },
    };

    // Act
    const planned = plan([subject('a', { diedAt: ago(20 * 60) })], { state });

    // Assert
    should(planned.refused.map(entry => entry.why)).deepEqual(['too_old']);
  });
});

describe('the order of the waves', () => {
  it('should revive at most three at a time, earliest death first', () => {
    // Arrange
    const many = ['a', 'b', 'c', 'd', 'e'].map((id, index) => subject(id, { diedAt: ago(300 - index * 20) }));

    // Act
    const planned = plan(many);

    // Assert
    should(planned.waves.map(wave => wave.map(entry => entry.id))).deepEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
    should(planned.waves.map(wave => wave.map(entry => entry.wave))).deepEqual([
      [1, 1, 1],
      [2, 2],
    ]);
  });

  it('should put interactive sessions before auto ones, and leads before the rest', () => {
    // Arrange
    const subjects = [
      subject('auto-early', { diedAt: ago(300) }),
      subject('lead', { diedAt: ago(200) }),
      subject('kid', { diedAt: ago(250), parent: 'lead' }),
      subject('person', { mode: 'interactive', diedAt: ago(100) }),
      subject('auto-late', { diedAt: ago(90) }),
    ];

    // Act
    const planned = plan(subjects, {
      fleet: [
        ...subjects.map(entry => ({
          id: entry.id,
          status: 'failed',
          ...(entry.parent === undefined ? {} : { parent: entry.parent }),
        })),
      ],
    });

    // Assert
    should(planned.waves.map(wave => wave.map(entry => entry.id))).deepEqual([
      ['person', 'lead', 'auto-early'],
      ['kid', 'auto-late'],
    ]);
  });

  it('should send a child after its lead even when the lead would otherwise fill the wave alone', () => {
    // Arrange
    const subjects = [subject('kid', { parent: 'lead', diedAt: ago(300) }), subject('lead', { diedAt: ago(100) })];

    // Act
    const planned = plan(subjects, {
      fleet: [
        { id: 'kid', status: 'failed', parent: 'lead' },
        { id: 'lead', status: 'failed' },
      ],
    });

    // Assert
    should(planned.waves.map(wave => wave.map(entry => entry.id))).deepEqual([['lead'], ['kid']]);
  });

  it('should revive a child whose lead is alive in the first wave', () => {
    // Act
    const planned = plan([subject('kid', { parent: 'lead' })], {
      fleet: [
        { id: 'kid', status: 'failed', parent: 'lead' },
        { id: 'lead', status: 'running' },
      ],
    });

    // Assert
    should(planned.waves).have.length(1);
  });
});

describe('the circuit breaker', () => {
  const revivedState = (revivedAt: string): ReviveState => ({
    ...EMPTY_REVIVE_STATE,
    sessions: { a: { revivedAt, attempts: 1, crashRevives: 0 } },
  });

  it('should open when a revived session dies again within two minutes', () => {
    // Act
    const verdict = breakerVerdict(revivedState(ago(100)), [subject('a', { diedAt: ago(10) })], NOW, config);

    // Assert
    should(verdict?.why).containEql('a died again within 2 minutes');
    should(verdict?.until).equal(new Date(NOW + 30 * 60_000).toISOString());
  });

  it('should stay shut when the second death comes later, or was before the revive', () => {
    // Act / Assert
    should(breakerVerdict(revivedState(ago(600)), [subject('a', { diedAt: ago(10) })], NOW, config)).be.undefined();
    should(breakerVerdict(revivedState(ago(100)), [subject('a', { diedAt: ago(200) })], NOW, config)).be.undefined();
    should(breakerVerdict(EMPTY_REVIVE_STATE, [subject('a')], NOW, config)).be.undefined();
  });

  it('should open when more than half of one wave dies again', () => {
    // Arrange
    const state: ReviveState = {
      ...EMPTY_REVIVE_STATE,
      batches: [{ at: ago(600), ids: ['a', 'b', 'c'] }],
    };

    // Act
    const two = breakerVerdict(
      state,
      [subject('a', { diedAt: ago(100) }), subject('b', { diedAt: ago(90) })],
      NOW,
      config,
    );
    const one = breakerVerdict(state, [subject('a', { diedAt: ago(100) })], NOW, config);

    // Assert
    should(two?.why).equal('2 of the 3 sessions revived together died again');
    should(one).be.undefined();
  });

  it('should key a death by the session and when it died', () => {
    // Act / Assert
    should(deathKey({ id: 'a', diedAt: 'T' })).equal('a@T');
  });
});
