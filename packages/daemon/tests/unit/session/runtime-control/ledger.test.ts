import { describe, it } from 'bun:test';
import type { RuntimeControlRequest, SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  RUNTIME_LEDGER_LIMIT,
  RuntimeRequestLedger,
  runtimeRequestFingerprint,
} from '../../../../src/lib/session/runtime-control/ledger.ts';
import type { SessionId } from '../../../../src/lib/session-id.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

/**
 * The one thing standing between a retried request whose answer was lost and a second keystroke
 * sequence typed into a live modal.
 *
 * Every case here is about a caller who sends the same id twice. There are exactly three honest
 * answers to that — here is what you got, you reused the id for something else, and it already
 * happened and nobody recorded how — and telling them apart is the whole point.
 */

const ID = 's1' as SessionId;
const VIEW: SessionView = sessionView('s1');
const OTHER: SessionView = sessionView('s1', {}, { status: 'thinking' });

/** The error a call threw, as a value. `should(...).throw()` answers the assertion, not the error. */
const thrown = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal, and the call returned');
};

const print = (request: RuntimeControlRequest) => runtimeRequestFingerprint(request);
const COMPACT = print({ action: 'compact' });
const EFFORT = print({ action: 'effort', effort: 'high' });

describe('the runtime request fingerprint', () => {
  it('should read two serialisations of one control as the same request', () => {
    // A retry may well re-serialize the body, and key order or whitespace is not a different ask.
    // Act
    const actual = [
      print({ action: 'model', model: 'gpt-5.6-codex', effort: 'high' }),
      print({ effort: 'high', model: 'gpt-5.6-codex', action: 'model' } as RuntimeControlRequest),
    ];

    // Assert
    should(actual[0]).equal(actual[1]);
  });

  it('should tell every arm of the union apart, including one that only omits a field', () => {
    // Act
    const prints = [
      print({ action: 'compact' }),
      print({ action: 'effort', effort: 'high' }),
      print({ action: 'model' }),
      print({ action: 'model', model: 'gpt-5.6-codex' }),
      print({ action: 'model', model: 'gpt-5.6-codex', effort: 'high' }),
    ];

    // Assert: five controls, five distinct prints.
    should(new Set(prints).size).equal(prints.length);
  });
});

describe('the runtime request ledger', () => {
  it('should answer an unknown id with nothing at all', () => {
    // Arrange
    const subject = new RuntimeRequestLedger();

    // Act / Assert
    should(subject.replay(ID, 'req-1', COMPACT)).be.undefined();
  });

  it('should replay the first answer for a genuine retry', () => {
    // Arrange
    const subject = new RuntimeRequestLedger();
    subject.spend(ID, 'req-1', COMPACT);
    subject.settle(ID, 'req-1', COMPACT, VIEW);

    // Act / Assert
    should(subject.replay(ID, 'req-1', COMPACT)).equal(VIEW);
  });

  it('should refuse an id reused for a DIFFERENT control rather than answering the first one', () => {
    // Handing this the first control's view would tell a caller its model switch succeeded when what
    // actually happened was somebody else's effort change.
    // Arrange
    const subject = new RuntimeRequestLedger();
    subject.settle(ID, 'req-1', COMPACT, VIEW);

    // Act
    const failure = thrown(() => subject.replay(ID, 'req-1', EFFORT));

    // Assert
    should(failure).match({ failure: 'conflict', message: /already spent on a different runtime control/u });
  });

  it('should refuse a spent id whose outcome nobody recorded, rather than replaying or retrying', () => {
    // The first attempt reached the harness and then failed on its own bookkeeping. A second
    // `/compact` discards context nobody asked to lose.
    // Arrange
    const subject = new RuntimeRequestLedger();
    subject.spend(ID, 'req-1', COMPACT);

    // Act
    const failure = thrown(() => subject.replay(ID, 'req-1', COMPACT));

    // Assert
    should(failure).match({
      failure: 'unsettled',
      message: /already performed on this session and its outcome was not recorded/u,
    });
  });

  it('should keep one id per session, so two sessions may share a caller id', () => {
    // Arrange
    const subject = new RuntimeRequestLedger();
    subject.settle(ID, 'req-1', COMPACT, VIEW);

    // Act / Assert
    should(subject.replay('s2' as SessionId, 'req-1', COMPACT)).be.undefined();
  });

  it('should forget the OLDEST entries once it is full, never the newest', () => {
    // A retry arrives seconds after its original, never thousands of controls later — but a daemon
    // whose composer chips are used routinely must not hold a session view per control it ever served.
    // Arrange
    const subject = new RuntimeRequestLedger(3);
    for (const id of ['a', 'b', 'c']) subject.settle(ID, id, COMPACT, VIEW);

    // Act — one more than it holds.
    subject.settle(ID, 'd', COMPACT, OTHER);

    // Assert
    should(subject.replay(ID, 'a', COMPACT)).be.undefined();
    should(subject.replay(ID, 'b', COMPACT)).equal(VIEW);
    should(subject.replay(ID, 'd', COMPACT)).equal(OTHER);
  });

  it('should re-date an entry it records twice, so settling does not age it out early', () => {
    // `spend` then `settle` is the ordinary life of every id. If the second write kept the first
    // write's place in the queue, a busy daemon would evict answers it had only just recorded.
    // Arrange
    const subject = new RuntimeRequestLedger(2);
    subject.spend(ID, 'first', COMPACT);
    subject.settle(ID, 'second', COMPACT, VIEW);

    // Act — re-recording `first` must move it behind `second`.
    subject.settle(ID, 'first', COMPACT, OTHER);
    subject.settle(ID, 'third', COMPACT, VIEW);

    // Assert: `second` was the oldest by then and is the one that went.
    should(subject.replay(ID, 'second', COMPACT)).be.undefined();
    should(subject.replay(ID, 'first', COMPACT)).equal(OTHER);
  });

  it('should default to a bound far beyond any real retry window', () => {
    // Act / Assert
    should(RUNTIME_LEDGER_LIMIT).equal(512);
  });
});
