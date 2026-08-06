import { describe, it } from 'bun:test';
import type { SessionState, SessionView } from '@ferretry/protocol';
import should from 'should';
import { KeyedSerialExecutor } from '../../../../src/adapters/system/keyed-serial-executor.ts';
import {
  type AnswerLedger,
  type AnswerOperationRecord,
  AnswerReleased,
  AnswerRequestConflict,
  type AnswerRequestPayload,
  AnswerTerminalFailure,
  AnswerToolAlreadyHandled,
  AnswerUnconfirmed,
  answerFingerprint,
} from '../../../../src/lib/session/question/answer-ledger.ts';
import {
  StructuredAnswerCoordinator,
  type StructuredAnswerPerformer,
} from '../../../../src/lib/session/question/coordinator.ts';
import {
  StructuredQuestionAttemptFailed,
  StructuredQuestionDriveFailure,
  StructuredQuestionRefused,
} from '../../../../src/lib/session/question/service.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const OTHER = parseSessionId('session-2');
const REQUEST = { toolUseId: 'tool-1', labels: ['Yes'] } as const;

/** The ledger as a map, recording the exact order every receipt was appended in. */
class MemoryLedger implements AnswerLedger {
  readonly appended: Array<readonly [SessionId, AnswerOperationRecord]> = [];
  private readonly records = new Map<string, AnswerOperationRecord>();

  constructor(seed: ReadonlyArray<readonly [SessionId, AnswerOperationRecord]> = []) {
    for (const [id, record] of seed) this.records.set(`${id}\n${record.requestId}`, record);
  }

  async read(id: SessionId, requestId: string): Promise<AnswerOperationRecord | undefined> {
    return this.records.get(`${id}\n${requestId}`);
  }

  async all(id: SessionId): Promise<ReadonlyMap<string, AnswerOperationRecord>> {
    const records = new Map<string, AnswerOperationRecord>();
    for (const [key, record] of this.records) if (key.startsWith(`${id}\n`)) records.set(record.requestId, record);
    return records;
  }

  async append(id: SessionId, record: AnswerOperationRecord): Promise<void> {
    this.appended.push([id, record]);
    this.records.set(`${id}\n${record.requestId}`, record);
  }
}

/**
 * Drains the microtask queue.
 *
 * Every step of the path under test is promise-based with no timer in it, so settling the queue is
 * the whole of "let everything that CAN run, run". That is what makes the negative assertions below
 * — nothing else started — deterministic rather than a race against a clock.
 */
async function drain(): Promise<void> {
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

/** A performer whose drive can be held open, so a retry genuinely overlaps the first attempt. */
class Performer implements StructuredAnswerPerformer {
  readonly calls: Array<{ readonly id: SessionId; readonly toolUseId: string }> = [];
  readonly #waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  #release: (() => void) | undefined;
  #result: Promise<void> | undefined;

  constructor(private readonly failure?: unknown) {}

  /** Holds every subsequent drive until `release()` is called. */
  hold(): void {
    this.#result = new Promise<void>(resolve => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
  }

  /** Resolves once `count` drives have STARTED, so a test never guesses how many ticks that took. */
  async whenCalls(count: number): Promise<void> {
    if (this.calls.length >= count) return;
    await new Promise<void>(resolve => {
      this.#waiters.push({ count, resolve });
    });
  }

  async answer(input: { readonly id: SessionId; readonly toolUseId: string }): Promise<void> {
    this.calls.push({ id: input.id, toolUseId: input.toolUseId });
    for (const waiter of this.#waiters) if (this.calls.length >= waiter.count) waiter.resolve();
    if (this.#result !== undefined) await this.#result;
    if (this.failure !== undefined) throw this.failure;
  }
}

interface Harness {
  readonly subject: StructuredAnswerCoordinator;
  readonly ledger: MemoryLedger;
  readonly performer: Performer;
  readonly quarantined: Array<readonly [SessionId, AnswerOperationRecord]>;
  views(): number;
}

function harness(
  options: {
    readonly ledger?: MemoryLedger;
    readonly performer?: Performer;
    readonly serial?: KeyedSerialExecutor;
    readonly state?: SessionState | undefined;
    readonly view?: (id: SessionId) => Promise<SessionView>;
  } = {},
): Harness {
  const ledger = options.ledger ?? new MemoryLedger();
  const performer = options.performer ?? new Performer();
  const quarantined: Array<readonly [SessionId, AnswerOperationRecord]> = [];
  let reads = 0;
  const subject = new StructuredAnswerCoordinator({
    service: performer,
    ledger,
    serial: options.serial ?? new KeyedSerialExecutor(),
    clock: { now: () => '2026-08-06T00:00:00.000Z' },
    state: async () => options.state,
    // A DIFFERENT view every call, so a test can tell a re-read from a cached one.
    view:
      options.view ??
      (async id => {
        reads += 1;
        return { directory: `/sessions/${id}`, state: { read: reads } } as unknown as SessionView;
      }),
    quarantine: async (id, record) => {
      quarantined.push([id, record]);
    },
  });
  return { subject, ledger, performer, quarantined, views: () => reads };
}

const answer = (
  subject: StructuredAnswerCoordinator,
  requestId = 'request-1',
  request: AnswerRequestPayload = REQUEST,
  id = ID,
) => subject.answer({ id, requestId, request });

describe('the structured answer coordinator', () => {
  it('drives the form once for two concurrent retries of one request id', async () => {
    // Arrange
    const performer = new Performer();
    const { subject, performer: held } = harness({ performer });
    held.hold();

    // Act
    const first = answer(subject);
    const second = answer(subject);
    await held.whenCalls(1);
    held.release();
    const [left, right] = await Promise.all([first, second]);

    // Assert
    should(performer.calls).have.length(1);
    should(left).equal(right);
  });

  it('writes the accepted receipt before a single key is sent, and settles it after', async () => {
    // Arrange
    const { subject, ledger, performer } = harness();
    performer.hold();

    // Act
    const running = answer(subject);
    await performer.whenCalls(1);
    const beforeAnyKey = [...ledger.appended];
    performer.release();
    await running;

    // Assert
    should(beforeAnyKey.map(([, record]) => record.outcome)).deepEqual(['accepted']);
    should(performer.calls).have.length(1);
    should(ledger.appended.map(([, record]) => record.outcome)).deepEqual(['accepted', 'confirmed']);
    should(ledger.appended[0]?.[1]).match({ requestId: 'request-1', toolUseId: 'tool-1' });
  });

  it('refuses a reused id carrying a different answer while the first is still in flight, driving nothing new', async () => {
    // Arrange
    const { subject, performer } = harness();
    performer.hold();
    const running = answer(subject);

    // Act
    const conflict = answer(subject, 'request-1', { toolUseId: 'tool-1', labels: ['No'] });

    // Assert
    await should(conflict).be.rejectedWith(AnswerRequestConflict);
    performer.release();
    await running;
    should(performer.calls).have.length(1);
  });

  it('refuses a reused id carrying a different answer against a settled receipt, driving nothing', async () => {
    // Arrange
    const ledger = new MemoryLedger([
      [
        ID,
        {
          requestId: 'request-1',
          toolUseId: 'tool-1',
          fingerprint: answerFingerprint(REQUEST),
          acceptedAt: '2026-08-06T00:00:00.000Z',
          outcome: 'confirmed',
        },
      ],
    ]);
    const { subject, performer } = harness({ ledger });

    // Act + Assert
    await should(answer(subject, 'request-1', { toolUseId: 'tool-1', labels: ['No'] })).be.rejectedWith(
      AnswerRequestConflict,
    );
    should(performer.calls).deepEqual([]);
  });

  it('replays a settled receipt after a lost response, sending no keys and re-reading the current view', async () => {
    // Arrange — a receipt on disk and a coordinator that has never seen this request: a restart.
    const ledger = new MemoryLedger([
      [
        ID,
        {
          requestId: 'request-1',
          toolUseId: 'tool-1',
          fingerprint: answerFingerprint(REQUEST),
          acceptedAt: '2026-08-06T00:00:00.000Z',
          outcome: 'confirmed',
        },
      ],
    ]);
    const subject = harness({ ledger });

    // Act
    const actual = await answer(subject.subject);

    // Assert
    should(subject.performer.calls).deepEqual([]);
    should(subject.ledger.appended).deepEqual([]);
    should(subject.views()).equal(1);
    should(actual).match({ directory: '/sessions/session-1' });
  });

  it('promotes an unsettled receipt the state document already proved, without driving the form', async () => {
    // Arrange
    const ledger = new MemoryLedger([
      [
        ID,
        {
          requestId: 'request-1',
          toolUseId: 'tool-1',
          fingerprint: answerFingerprint(REQUEST),
          acceptedAt: '2026-08-06T00:00:00.000Z',
          outcome: 'accepted',
        },
      ],
    ]);
    const subject = harness({ ledger, state: { lastAnsweredQuestionToolUseId: 'tool-1' } as SessionState });

    // Act
    await answer(subject.subject);

    // Assert
    should(subject.performer.calls).deepEqual([]);
    should(subject.ledger.appended.map(([, record]) => record.outcome)).deepEqual(['confirmed']);
    should(subject.quarantined).deepEqual([]);
  });

  it('quarantines an unsettled receipt nothing can prove, and never sends its keys again', async () => {
    // Arrange
    const stranded: AnswerOperationRecord = {
      requestId: 'request-1',
      toolUseId: 'tool-1',
      fingerprint: answerFingerprint(REQUEST),
      acceptedAt: '2026-08-06T00:00:00.000Z',
      outcome: 'accepted',
    };
    const subject = harness({ ledger: new MemoryLedger([[ID, stranded]]), state: {} as SessionState });

    // Act + Assert
    await should(answer(subject.subject)).be.rejectedWith(AnswerUnconfirmed);
    should(subject.performer.calls).deepEqual([]);
    should(subject.quarantined).match([[ID, { ...stranded, outcome: 'quarantined', reason: /could not prove/u }]]);
    should(subject.ledger.appended.map(([, record]) => record.outcome)).deepEqual(['quarantined']);
  });

  it('tombstones a refusal raised before any key, so the same id may honestly start over', async () => {
    // Arrange
    const ledger = new MemoryLedger();
    const refusing = harness({ ledger, performer: new Performer(new StructuredQuestionRefused('form changed')) });

    // Act
    await should(answer(refusing.subject)).be.rejectedWith(StructuredQuestionRefused);
    const readmitted = harness({ ledger });
    await answer(readmitted.subject);

    // Assert
    should(ledger.appended.map(([, record]) => record.outcome)).deepEqual([
      'accepted',
      'withdrawn',
      'accepted',
      'confirmed',
    ]);
    should(readmitted.performer.calls).have.length(1);
  });

  it('leaves a failure at or after the drive ambiguous, and refuses the next attempt rather than repeating it', async () => {
    // Arrange
    const ledger = new MemoryLedger();
    const failing = harness({ ledger, performer: new Performer(new Error('the form did not visibly advance')) });

    // Act
    await should(answer(failing.subject)).be.rejectedWith(/did not visibly advance/u);
    // A fresh coordinator over the same durable ledger: the retry crossed a restart.
    const retry = harness({ ledger, state: {} as SessionState });

    // Assert
    should(ledger.appended.map(([, record]) => record.outcome)).deepEqual(['accepted']);
    await should(answer(retry.subject)).be.rejectedWith(AnswerUnconfirmed);
    should(retry.performer.calls).deepEqual([]);
  });

  it.each([
    ['failed', 'none'],
    ['quarantined', 'ambiguous'],
  ] as const)('settles a recovered %s attempt and never re-drives it after restart', async (receipt, acceptance) => {
    const ledger = new MemoryLedger();
    const recovered = new StructuredQuestionAttemptFailed(
      'the form was released; reply in prose',
      receipt,
      new StructuredQuestionDriveFailure('drive failed', acceptance),
    );
    const failing = harness({ ledger, performer: new Performer(recovered) });

    await should(answer(failing.subject)).be.rejectedWith(StructuredQuestionAttemptFailed);
    const retry = harness({ ledger, state: {} as SessionState });

    should(ledger.appended.map(([, record]) => record.outcome)).deepEqual(['accepted', receipt]);
    should(failing.quarantined).have.length(receipt === 'quarantined' ? 1 : 0);
    await should(answer(retry.subject)).be.rejectedWith(receipt === 'failed' ? AnswerTerminalFailure : AnswerReleased);
    should(retry.performer.calls).deepEqual([]);
  });

  it('keeps an unreleased recovery failure accepted and quarantines it after restart', async () => {
    const ledger = new MemoryLedger();
    const failure = new StructuredQuestionAttemptFailed(
      'the form could not be released',
      'accepted',
      new StructuredQuestionDriveFailure('drive failed', 'ambiguous'),
    );
    const first = harness({ ledger, performer: new Performer(failure) });

    await should(answer(first.subject)).be.rejectedWith(StructuredQuestionAttemptFailed);
    const retry = harness({ ledger, state: {} as SessionState });
    await should(answer(retry.subject)).be.rejectedWith(AnswerUnconfirmed);

    should(ledger.appended.map(([, record]) => record.outcome)).deepEqual(['accepted', 'quarantined']);
    should(retry.quarantined).have.length(1);
    should(retry.performer.calls).deepEqual([]);
  });

  it('refuses a fresh request id for a tool a settled request already owns', async () => {
    const ledger = new MemoryLedger([
      [
        ID,
        {
          requestId: 'request-1',
          toolUseId: 'tool-1',
          fingerprint: answerFingerprint(REQUEST),
          acceptedAt: '2026-08-06T00:00:00.000Z',
          outcome: 'confirmed',
        },
      ],
    ]);
    const retry = harness({ ledger });

    await should(answer(retry.subject, 'request-2')).be.rejectedWith(AnswerToolAlreadyHandled);
    should(retry.performer.calls).deepEqual([]);
  });

  it('reconciles another request id that accepted this tool before refusing a fresh id', async () => {
    const accepted: AnswerOperationRecord = {
      requestId: 'request-1',
      toolUseId: 'tool-1',
      fingerprint: answerFingerprint(REQUEST),
      acceptedAt: '2026-08-06T00:00:00.000Z',
      outcome: 'accepted',
    };
    const ledger = new MemoryLedger([[ID, accepted]]);
    const retry = harness({ ledger, state: { lastAnsweredQuestionToolUseId: 'tool-1' } as SessionState });

    await should(answer(retry.subject, 'request-2')).be.rejectedWith(AnswerToolAlreadyHandled);

    should(ledger.appended.map(([, record]) => record.outcome)).deepEqual(['confirmed']);
    should(retry.performer.calls).deepEqual([]);
  });

  it('serializes two different request ids on one session', async () => {
    // Arrange
    const { subject, performer } = harness();
    performer.hold();

    // Act
    const first = answer(subject, 'request-1');
    const second = answer(subject, 'request-2', { toolUseId: 'tool-2', labels: ['No'] });
    await performer.whenCalls(1);
    await drain();
    const duringFirst = performer.calls.length;
    performer.release();
    await Promise.all([first, second]);

    // Assert
    should(duringFirst).equal(1);
    should(performer.calls).have.length(2);
  });

  it('makes monitor projection wait for the live drive on the shared per-session queue', async () => {
    const serial = new KeyedSerialExecutor();
    const { subject, performer } = harness({ serial });
    performer.hold();
    const running = answer(subject);
    await performer.whenCalls(1);
    let projected = false;

    const projection = serial.run(ID, async () => {
      projected = true;
    });
    await drain();
    should(projected).be.false();
    performer.release();
    await Promise.all([running, projection]);

    should(projected).be.true();
  });

  it('releases the answer queue before reading a view that projects under the same queue', async () => {
    const serial = new KeyedSerialExecutor();
    const view = async (id: SessionId): Promise<SessionView> =>
      await serial.run(
        id,
        async () => ({ directory: `/sessions/${id}`, state: { status: 'running' } }) as unknown as SessionView,
      );
    const { subject } = harness({ serial, view });

    const settled = await answer(subject);

    should(settled).match({ directory: '/sessions/session-1' });
  });

  it('keeps unrelated sessions concurrent', async () => {
    // Arrange
    const { subject, performer } = harness();
    performer.hold();

    // Act
    const first = answer(subject, 'request-1', REQUEST, ID);
    const second = answer(subject, 'request-1', REQUEST, OTHER);
    await drain();
    const bothStarted = performer.calls.length;
    performer.release();
    await Promise.all([first, second]);

    // Assert
    should(bothStarted).equal(2);
    should(performer.calls.map(call => call.id)).deepEqual([ID, OTHER]);
  });

  it('never lets one session’s receipt answer for another’s', async () => {
    // Arrange — the same request id, settled on a DIFFERENT session.
    const ledger = new MemoryLedger([
      [
        OTHER,
        {
          requestId: 'request-1',
          toolUseId: 'tool-1',
          fingerprint: answerFingerprint(REQUEST),
          acceptedAt: '2026-08-06T00:00:00.000Z',
          outcome: 'confirmed',
        },
      ],
    ]);
    const { subject, performer } = harness({ ledger });

    // Act
    await answer(subject, 'request-1', REQUEST, ID);

    // Assert
    should(performer.calls.map(call => call.id)).deepEqual([ID]);
  });
});
