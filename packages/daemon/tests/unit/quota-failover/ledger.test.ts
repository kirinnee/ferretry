import { describe, it } from 'bun:test';
import should from 'should';
import {
  attemptRefusal,
  barredTargets,
  emptyQuotaFailoverState,
  parseStoredQuotaFailoverState,
  pruneLedger,
  type QuotaFailoverSessionRecord,
  type QuotaFailoverState,
  recordAttempt,
  recordTick,
  sessionRecord,
} from '../../../src/lib/quota-failover/index.ts';

const move = (from: string, to: string, at: string) => ({ from, to, at, evidence: 'measured at its limit' });

const stateWith = (sessionId: string, record: QuotaFailoverSessionRecord): QuotaFailoverState => ({
  sessions: { [sessionId]: record },
});

describe('parseStoredQuotaFailoverState', () => {
  it.each([
    { label: 'no ledger has been written yet', stored: undefined },
    { label: 'the ledger is null', stored: null },
  ])('should read an empty ledger when $label', ({ stored }) => {
    // Arrange / Act
    const result = parseStoredQuotaFailoverState(stored);

    // Assert — a state home that has never moved a session is a legitimate empty
    should(result).deepEqual({ kind: 'ledger', state: emptyQuotaFailoverState });
  });

  it('should read back a ledger an earlier tick wrote', () => {
    // Arrange
    const stored = {
      sessions: { 's-1': { moves: [move('agent-a', 'agent-b', '2026-01-01T00:00:00.000Z')] } },
      lastTick: { at: '2026-01-01T00:05:00.000Z', summary: '3 session(s) considered, 1 moved' },
    };

    // Act
    const result = parseStoredQuotaFailoverState(stored);

    // Assert
    should(result.kind).equal('ledger');
    should(result.kind === 'ledger' && result.state.sessions['s-1']?.moves).have.length(1);
  });

  it('should HALT rather than start fresh when the ledger is damaged', () => {
    // Arrange — an empty ledger says "this session has never been moved", which is exactly the
    // permission a session already moved twice must not be granted
    const result = parseStoredQuotaFailoverState({ sessions: { 's-1': { moves: 'all of them' } } });

    // Assert
    should(result.kind).equal('damaged');
    should(result.kind === 'damaged' && result.reason).match(/did not validate/);
    should(result.kind === 'damaged' && result.reason).match(/cannot be shown not to be a loop/);
  });

  it('should name the document itself when the stored value is not an object at all', () => {
    // Arrange / Act
    const result = parseStoredQuotaFailoverState(7);

    // Assert
    should(result.kind === 'damaged' && result.reason).match(/\(document: /);
  });
});

describe('sessionRecord', () => {
  it('should answer an empty record for a session nothing has moved', () => {
    // Arrange / Act / Assert
    should(sessionRecord(emptyQuotaFailoverState, 's-1')).deepEqual({ moves: [] });
  });
});

describe('attemptRefusal', () => {
  const limits = { maxMoves: 1, retryCooldownMs: 60_000 };

  it('should allow a session that has never been touched', () => {
    // Arrange / Act / Assert
    should(attemptRefusal({ moves: [] }, limits, 1_000)).be.undefined();
  });

  it('should refuse a session that has spent its move budget', () => {
    // Arrange
    const record = { moves: [move('agent-a', 'agent-b', '2026-01-01T00:00:00.000Z')] };

    // Act
    const refusal = attemptRefusal(record, limits, Date.parse('2026-06-01T00:00:00.000Z'));

    // Assert — moving a third and fourth time hides a workload the pool does not fit
    should(refusal).match(/already been moved automatically 1 time\(s\)/);
  });

  it('should refuse a session still inside its retry cooldown', () => {
    // Arrange
    const record = { moves: [], lastAttemptAt: '2026-01-01T00:00:00.000Z' };

    // Act
    const refusal = attemptRefusal(record, limits, Date.parse('2026-01-01T00:00:30.000Z'));

    // Assert
    should(refusal).equal('the last attempt was 30s ago and the retry cooldown has 30s left');
  });

  it('should allow a session whose retry cooldown has elapsed', () => {
    // Arrange
    const record = { moves: [], lastAttemptAt: '2026-01-01T00:00:00.000Z' };

    // Act / Assert
    should(attemptRefusal(record, limits, Date.parse('2026-01-01T00:01:00.000Z'))).be.undefined();
  });

  it('should fail closed when the last attempt has no readable instant', () => {
    // Arrange — the permissive reading of a damaged timestamp is an attempt every single tick
    const record = { moves: [], lastAttemptAt: 'the other day' };

    // Act / Assert
    should(attemptRefusal(record, limits, 1_000)).match(/no readable instant/);
  });

  it('should check the move budget before the cooldown, because the budget is unrecoverable', () => {
    // Arrange — both apply; the ceiling is the fact worth reporting
    const record = { moves: [move('agent-a', 'agent-b', '2026-01-01T00:00:00.000Z')], lastAttemptAt: 'nonsense' };

    // Act / Assert
    should(attemptRefusal(record, limits, 1_000)).match(/already been moved automatically/);
  });
});

describe('barredTargets', () => {
  const nowMs = Date.parse('2026-01-01T01:00:00.000Z');

  it('should bar nothing for a session that has never moved', () => {
    // Arrange / Act / Assert
    should(barredTargets({ moves: [] }, 3_600_000, nowMs).size).equal(0);
  });

  it('should bar BOTH ends of a recent move', () => {
    // Arrange
    const record = { moves: [move('agent-a', 'agent-b', '2026-01-01T00:30:00.000Z')] };

    // Act
    const barred = barredTargets(record, 3_600_000, nowMs);

    // Assert — barring only the destination leaves the exhausted source immediately eligible again,
    // which is the ping-pong this exists to prevent
    should(barred.get('agent-a')).equal('this session was automatically moved off it 1800s ago');
    should(barred.get('agent-b')).equal('this session was automatically moved onto it 1800s ago');
  });

  it('should let an account out of the bar once the cooldown has passed', () => {
    // Arrange
    const record = { moves: [move('agent-a', 'agent-b', '2026-01-01T00:00:00.000Z')] };

    // Act / Assert
    should(barredTargets(record, 60_000, nowMs).size).equal(0);
  });

  it('should treat a move with an unreadable instant as recent', () => {
    // Arrange — dropping it would quietly restore an account because its timestamp was damaged
    const record = { moves: [move('agent-a', 'agent-b', 'some time last week')] };

    // Act
    const barred = barredTargets(record, 60_000, nowMs);

    // Assert
    should(barred.get('agent-a')).match(/no readable instant/);
    should(barred.get('agent-b')).match(/no readable instant/);
  });

  it('should keep the first bar so the most recent move keeps its wording', () => {
    // Arrange — two moves naming the same account, scanned oldest first
    const record = {
      moves: [
        move('agent-a', 'agent-b', '2026-01-01T00:50:00.000Z'),
        move('agent-b', 'agent-a', '2026-01-01T00:55:00.000Z'),
      ],
    };

    // Act
    const barred = barredTargets(record, 3_600_000, nowMs);

    // Assert
    should(barred.get('agent-a')).equal('this session was automatically moved off it 600s ago');
  });
});

describe('recordAttempt', () => {
  it('should record an attempt that did not move anything, so the cooldown still starts', () => {
    // Act
    const state = recordAttempt(emptyQuotaFailoverState, 's-1', {
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'refused: in-flight work',
    });

    // Assert
    should(state.sessions['s-1']).deepEqual({
      moves: [],
      lastAttemptAt: '2026-01-01T00:00:00.000Z',
      lastOutcome: 'refused: in-flight work',
    });
  });

  it('should append a completed move to the budget', () => {
    // Arrange
    const first = recordAttempt(emptyQuotaFailoverState, 's-1', {
      at: '2026-01-01T00:00:00.000Z',
      outcome: 'moved to agent-b',
      move: move('agent-a', 'agent-b', '2026-01-01T00:00:00.000Z'),
    });

    // Act
    const second = recordAttempt(first, 's-1', {
      at: '2026-02-01T00:00:00.000Z',
      outcome: 'moved to agent-c',
      move: move('agent-b', 'agent-c', '2026-02-01T00:00:00.000Z'),
    });

    // Assert
    should(second.sessions['s-1']?.moves).have.length(2);
    should(second.sessions['s-1']?.lastOutcome).equal('moved to agent-c');
  });

  it('should leave other sessions untouched', () => {
    // Arrange
    const state = stateWith('s-other', { moves: [move('agent-a', 'agent-b', '2026-01-01T00:00:00.000Z')] });

    // Act
    const next = recordAttempt(state, 's-1', { at: '2026-01-01T00:00:00.000Z', outcome: 'moved to agent-b' });

    // Assert
    should(next.sessions['s-other']?.moves).have.length(1);
  });
});

describe('recordTick', () => {
  it('should publish the tick account so a reader can tell a quiet loop from a stopped one', () => {
    // Act
    const state = recordTick(emptyQuotaFailoverState, '2026-01-01T00:00:00.000Z', '2 considered, 0 moved');

    // Assert
    should(state.lastTick).deepEqual({ at: '2026-01-01T00:00:00.000Z', summary: '2 considered, 0 moved' });
  });
});

describe('pruneLedger', () => {
  it('should drop records for sessions this daemon no longer holds', () => {
    // Arrange
    const state: QuotaFailoverState = {
      sessions: { 's-live': { moves: [] }, 's-gone': { moves: [] } },
    };

    // Act
    const pruned = pruneLedger(state, new Set(['s-live']));

    // Assert
    should(Object.keys(pruned.sessions)).deepEqual(['s-live']);
  });

  it('should return the same ledger untouched when nothing needs dropping', () => {
    // Arrange
    const state: QuotaFailoverState = { sessions: { 's-live': { moves: [] } } };

    // Act / Assert
    should(pruneLedger(state, new Set(['s-live']))).equal(state);
  });

  it('should prune NOTHING when the roster could not be read', () => {
    // Arrange — an empty roster from a failed read would otherwise erase the entire ledger
    const state: QuotaFailoverState = { sessions: { 's-1': { moves: [] } } };

    // Act / Assert
    should(pruneLedger(state, undefined)).equal(state);
  });
});
