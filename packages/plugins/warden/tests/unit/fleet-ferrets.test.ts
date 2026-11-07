import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretEndCause, FerretSummary } from '@ferretry/core-ferrets/contract';
import { ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import { livenessTargets, reviveEventsOf, wardenFleetSession } from '../../daemon/fleet.ts';
import { classifyEnd, overdueCandidates, reflexSettingsFor, REPORT_OVERDUE_MS } from '../../daemon/lib/index.ts';

/** What Ferrets' additives (death cause, declared wait, finish, reflex times) let the Warden read. */

const ferret = (over: Partial<FerretSummary> = {}): FerretSummary => ({
  id: ferretId('f1'),
  name: 'rae',
  role: 'helper',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/w',
  state: 'working',
  mode: 'auto',
  createdAt: T0,
  stateAt: T0,
  parent: ferretId('lead'),
  ...over,
});

const stopped = (cause: FerretEndCause | undefined, over: Partial<FerretSummary> = {}): FerretSummary =>
  ferret({ state: 'stopped', ...(cause === undefined ? {} : { cause }), ...over });

const at = (iso: string): Instant => instantFromEpochMs(Date.parse(iso));

const session = (summary: FerretSummary) => wardenFleetSession(summary, 1, undefined, 'd');

describe('a ferret Ferrets says died is a failed session the revive can read (the death cause)', () => {
  const abnormal: readonly FerretEndCause[] = [
    { kind: 'tmux_crashed' },
    { kind: 'terminal_gone' },
    { kind: 'signal', signal: 9 },
    { kind: 'agent_crashed', exitCode: 2 },
    { kind: 'start_failed' },
  ];

  for (const cause of abnormal)
    it(`should read a ferret stopped by ${cause.kind} as failed`, () => {
      // Arrange / Act
      const read = session(stopped(cause));

      // Assert
      should(read.state.status).equal('failed');
      should(read.state.finishedAt).equal(T0);
    });

  it('should read a stop, a finish and a clean exit as somebody’s decision, never failed', () => {
    // Arrange / Act
    const stop = session(stopped({ kind: 'stopped' }));
    const done = session(stopped({ kind: 'completed' }, { finishedAt: T0 }));
    const clean = session(stopped({ kind: 'clean_exit' }));
    const unrecorded = session(stopped(undefined));

    // Assert
    should(stop.state.status).equal('stopped');
    should(done.state.status).equal('completed');
    should(clean.state.status).equal('stopped');
    should(unrecorded.state.status).equal('stopped');
  });

  it('should rebuild, for each abnormal cause, the one terminal event classifyEnd turns into that revive', () => {
    // Arrange
    const verdict = (cause: FerretEndCause) =>
      classifyEnd('failed', reviveEventsOf(stopped(cause, { stateAt: at('2026-11-07T10:00:00.000Z') })));

    // Act / Assert: the planner, not the journal, tells a crashed tmux server from a vanished pane (today's reading)
    should(verdict({ kind: 'terminal_gone' })).eql({
      kind: 'revive',
      cause: { kind: 'terminal_gone' },
      diedAt: '2026-11-07T10:00:00.000Z',
    });
    should(verdict({ kind: 'tmux_crashed' })).match({ kind: 'revive', cause: { kind: 'terminal_gone' } });
    should(verdict({ kind: 'signal', signal: 9 })).match({ kind: 'revive', cause: { kind: 'signal', signal: 9 } });
    should(verdict({ kind: 'agent_crashed', exitCode: 2 })).match({
      kind: 'revive',
      cause: { kind: 'agent_crashed', exitCode: 2 },
    });
  });

  it('should leave a stop, a finish, a failed start and a clean exit unrevived, each for its own reason', () => {
    // Arrange
    const why = (cause: FerretEndCause) => classifyEnd('failed', reviveEventsOf(stopped(cause)));

    // Act / Assert
    should(why({ kind: 'stopped' })).eql({ kind: 'leave', why: 'stopped' });
    should(why({ kind: 'completed' })).eql({ kind: 'leave', why: 'completed' });
    should(why({ kind: 'start_failed' })).eql({ kind: 'leave', why: 'start_failed' });
    should(why({ kind: 'clean_exit' })).eql({ kind: 'leave', why: 'clean_exit' });
  });

  it('should have no event for a ferret that has not ended, one with no cause, or one Ferrets does not know', () => {
    // Arrange / Act / Assert
    should(reviveEventsOf(ferret())).eql([]);
    should(reviveEventsOf(stopped(undefined))).eql([]);
    should(reviveEventsOf(undefined)).eql([]);
  });
});

describe('a declared wait and a finish keep a ferret out of the overdue-report nudge (waiting / finishedAt)', () => {
  const idle = (over: Partial<FerretSummary>): FerretSummary =>
    ferret({ state: 'idle', stateAt: at('2026-11-07T08:00:00.000Z'), ...over });
  const lead = ferret({ id: ferretId('lead'), name: 'lizzette', parent: undefined, role: 'lead', state: 'working' });
  const nowMs = Date.parse('2026-11-07T08:00:00.000Z') + REPORT_OVERDUE_MS + 60_000;
  const candidates = (child: FerretSummary) =>
    overdueCandidates([session(lead), session(child)], nowMs).map(entry => entry.child.config.id);

  it('should carry a declared wait onto the session, and drop it once the ferret has stopped', () => {
    // Arrange
    const waiting = { since: T0, until: at('2026-11-07T13:00:00.000Z'), condition: 'CI', peer: ferretId('lead') };

    // Act
    const parked = session(idle({ waiting }));
    const ended = session(stopped({ kind: 'stopped' }, { waiting }));

    // Assert
    should(parked.state.waiting).eql(waiting);
    should(ended.state.waiting).be.undefined();
  });

  it('should consider a sub-ferret at its prompt that declared nothing', () => {
    should(candidates(idle({}))).eql(['f1']);
  });

  it('should skip a sub-ferret that declared a wait', () => {
    should(candidates(idle({ waiting: { since: T0 } }))).eql([]);
  });

  it('should read a ferret that said signal done as finished, and never overdue', () => {
    // Arrange / Act
    const done = session(stopped({ kind: 'completed' }, { finishedAt: T0 }));

    // Assert
    should(done.hasDoneMarker).equal(true);
    should(session(idle({})).hasDoneMarker).be.undefined();
    should(candidates(idle({ finishedAt: T0 }))).eql([]);
  });
});

describe('the reflex is timed by each ferret’s own times and spares one that declared a wait (livenessTargets)', () => {
  it('should hand the reflex the ferret’s own nudge and frozen times, and its declared wait', () => {
    // Arrange
    const plain = session(ferret({ id: ferretId('a') }));
    const timed = session(ferret({ id: ferretId('b'), nudgeAfterSeconds: 60, killAfterSeconds: 120 }));
    const parked = session(ferret({ id: ferretId('c'), waiting: { since: T0 } }));

    // Act
    const [a, b, c] = livenessTargets([plain, timed, parked]);

    // Assert
    should(a).not.have.property('nudgeAfterSeconds');
    should(a?.waiting).equal(false);
    should(b).match({ nudgeAfterSeconds: 60, killAfterSeconds: 120, waiting: false });
    should(c?.waiting).equal(true);
    should(reflexSettingsFor(b ?? {}, 30)).match({ nudgeAfterSeconds: 60, frozenAfterSeconds: 120 });
  });

  it('should leave a ferret that names no time on the machine default (today: 0 is no time either)', () => {
    // Arrange
    const zero = session(ferret({ nudgeAfterSeconds: 0, killAfterSeconds: 0 }));

    // Act
    const [target] = livenessTargets([zero]);

    // Assert
    should(reflexSettingsFor(target ?? {}, 30)).match({ nudgeAfterSeconds: 300, frozenAfterSeconds: 900 });
  });
});
