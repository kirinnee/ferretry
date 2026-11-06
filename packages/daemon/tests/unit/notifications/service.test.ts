import { describe, it } from 'bun:test';
import { AgendaItemSchema, AgendaSnapshotSchema, type PushDeliveryResult } from '@ferretry/protocol';
import should from 'should';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { agendaAlertLane } from '../../../src/lib/notifications/policy.ts';
import { NotificationService } from '../../../src/lib/notifications/service.ts';
import { NotificationRecordSchema } from '../../../src/lib/notifications/types.ts';
import type {
  NotificationDeliveryLedger,
  NotificationLedgerEntry,
  NotificationPushDispatcher,
  NotificationRecord,
  NotificationSessionDirectory,
  NotificationSessionFacts,
} from '../../../src/lib/notifications/types.ts';
import type { PushDispatch } from '../../../src/lib/push/types.ts';

const AT = '2026-08-06T10:00:00.000Z';
const SESSION = 'session-1';
const OTHER = 'session-2';

class MemoryLedger implements NotificationDeliveryLedger {
  readonly records: NotificationRecord[] = [];
  readonly finds: string[] = [];
  readonly appends: NotificationRecord[] = [];
  failFind = false;
  failRequested = false;
  failOutcome = false;

  constructor(
    private readonly callLog: string[] = [],
    seed: readonly NotificationRecord[] = [],
  ) {
    this.records.push(...seed);
  }

  async find(key: string): Promise<NotificationLedgerEntry | undefined> {
    this.finds.push(key);
    if (this.failFind) throw new Error('ledger cannot be read');
    const requested = this.records.find(record => record.key === key && record.phase === 'requested');
    if (requested === undefined || requested.phase !== 'requested') return undefined;
    const outcome = this.records.find(record => record.key === key && record.phase === 'outcome');
    return {
      requested,
      ...(outcome === undefined || outcome.phase !== 'outcome' ? {} : { outcome }),
    };
  }

  async entries(): Promise<readonly NotificationLedgerEntry[]> {
    const keys = this.records.filter(record => record.phase === 'requested').map(record => record.key);
    const found = await Promise.all(keys.map(async key => await this.find(key)));
    return found.filter(entry => entry !== undefined);
  }

  async append(record: NotificationRecord): Promise<void> {
    this.callLog.push(`append:${record.phase}`);
    this.appends.push(record);
    if (record.phase === 'requested' && this.failRequested) throw new Error('requested append failed');
    if (record.phase === 'outcome' && this.failOutcome) throw new Error('outcome append failed');
    this.records.push(record);
  }
}

class Sessions implements NotificationSessionDirectory {
  readonly calls: string[] = [];
  readonly values = new Map<string, NotificationSessionFacts>([
    [SESSION, { name: 'Release agent', title: 'Ship the release', interactive: true }],
    [OTHER, { name: 'Second agent', interactive: false }],
  ]);
  failure?: Error;

  async describe(sessionId: string): Promise<NotificationSessionFacts | undefined> {
    this.calls.push(sessionId);
    if (this.failure !== undefined) throw this.failure;
    return this.values.get(sessionId);
  }
}

class Push implements NotificationPushDispatcher {
  readonly dispatches: PushDispatch[] = [];
  calls = 0;
  enrolled = 2;
  result: PushDeliveryResult = { delivered: 2, failed: 0 };
  notifyHook?: (dispatch: PushDispatch) => Promise<PushDeliveryResult>;

  constructor(private readonly callLog: string[] = []) {}

  async list(): Promise<readonly unknown[]> {
    return Array.from({ length: this.enrolled }, () => ({}));
  }

  async notify(dispatch: PushDispatch): Promise<PushDeliveryResult> {
    this.callLog.push('push');
    this.calls += 1;
    this.dispatches.push(dispatch);
    return this.notifyHook === undefined ? this.result : await this.notifyHook(dispatch);
  }
}

function fixture(
  options: {
    readonly ledger?: MemoryLedger;
    readonly sessions?: Sessions;
    readonly push?: Push;
    readonly callLog?: string[];
    readonly warnings?: string[];
    readonly subjectOf?: ConstructorParameters<typeof NotificationService>[0]['subjectOf'];
    readonly now?: () => string;
    readonly landed?: (sessionId: string) => void;
    readonly lanes?: ConstructorParameters<typeof NotificationService>[0]['lanes'];
  } = {},
) {
  const callLog = options.callLog ?? [];
  const ledger = options.ledger ?? new MemoryLedger(callLog);
  const sessions = options.sessions ?? new Sessions();
  const push = options.push ?? new Push(callLog);
  return {
    callLog,
    ledger,
    sessions,
    push,
    service: new NotificationService({
      ledger,
      sessions,
      push,
      serial: new KeyedSerialExecutor(),
      clock: { now: options.now ?? (() => AT) },
      ...(options.warnings === undefined
        ? {}
        : {
            diagnostics: {
              failed: (key: string, reason: string) => options.warnings?.push(`failed ${key}: ${reason}`),
              made: (key: string, result: PushDeliveryResult) =>
                options.warnings?.push(`made ${key}: ${result.delivered}/${result.failed}`),
            },
          }),
      ...(options.subjectOf === undefined ? {} : { subjectOf: options.subjectOf }),
      ...(options.landed === undefined ? {} : { landed: options.landed }),
      ...(options.lanes === undefined ? {} : { lanes: options.lanes }),
    }),
  };
}

const item = AgendaItemSchema.parse({
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Choose a release window',
  why: 'The deployment needs a human decision.',
  waitingSince: AT,
  howToResolve: 'Choose a window.',
  ask: { kind: 'open-question' },
  raisedBy: 'agent',
  raisedBySession: SESSION,
  raisedByName: 'Ada',
});

const snapshot = AgendaSnapshotSchema.parse({
  v: 1,
  sessionId: SESSION,
  items: [item],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: AT,
});
const second = AgendaItemSchema.parse({ ...item, id: 'A2', subject: 'Choose a region' });
const twoWaiting = AgendaSnapshotSchema.parse({ ...snapshot, items: [item, second], count: 2 });
const notice = AgendaItemSchema.parse({ ...item, id: 'A3', notice: true, subject: 'Build is green' });
const pinging = AgendaItemSchema.parse({ ...notice, id: 'A4', ping: true });
const due = AgendaItemSchema.parse({ ...item, neededBy: '2026-08-06T12:00:00.000Z' });

const requested = (world: ReturnType<typeof fixture>) =>
  world.ledger.records.filter(record => record.phase === 'requested');

describe('NotificationService stop push', () => {
  it('should push ONE "<ferret> is stopped · N need you" for a stop, whatever the items, and none for the same stop again', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.stopped(SESSION, AT, twoWaiting);
    await world.service.stopped(SESSION, AT, twoWaiting);
    await world.service.stopped(SESSION, AT, snapshot);

    // Assert
    should(world.push.calls).equal(1);
    should(world.push.dispatches[0]?.payload).containDeep({
      title: 'Release agent is stopped · 2 need you',
      url: `/session/${SESSION}?attention=A1`,
    });
    // A stop is about the ferret: its line goes under the ferret's tag, recorded so a clear can name it.
    should(world.push.dispatches[0]?.payload.tag).equal(`attention-${SESSION}`);
    should(requested(world)[0]).containDeep({
      key: `agenda:${SESSION}:stopped:${AT}`,
      stoppedAt: AT,
      tag: `attention-${SESSION}`,
    });
  });

  it('should push again for the next stop of the same ferret', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.stopped(SESSION, AT, snapshot);
    await world.service.stopped(SESSION, '2026-08-06T11:00:00.000Z', snapshot);

    // Assert
    should(world.push.calls).equal(2);
  });

  it('should push nothing when no item waits on the owner', async () => {
    // Arrange
    const world = fixture();
    const ferretTurn = AgendaItemSchema.parse({ ...item, waitingOn: 'ferret', askedAt: AT });
    const waiting = AgendaSnapshotSchema.parse({ ...snapshot, items: [ferretTurn, notice], count: 2 });

    // Act
    await world.service.stopped(SESSION, AT, waiting);

    // Assert
    should(world.push.calls).equal(0);
  });
});

describe('NotificationService deadline push', () => {
  it('should push once per item, however often the deadline is seen', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.deadline(SESSION, due, snapshot);
    await world.service.deadline(SESSION, due, snapshot);

    // Assert
    should(world.push.calls).equal(1);
    should(world.push.dispatches[0]?.payload.body).startWith('Needed in about 2 h');
    // An item's push goes under its own tag (one line per item), recorded so a clear can name it.
    should(world.push.dispatches[0]?.payload.tag).equal(`attention-${SESSION}:A1`);
    should(requested(world)[0]).containDeep({
      key: `agenda:${SESSION}:A1:deadline`,
      deadline: true,
      tag: `attention-${SESSION}:A1`,
    });
  });

  it('should keep its own key apart from a stop of the same item', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.stopped(SESSION, AT, snapshot);
    await world.service.deadline(SESSION, due, snapshot);

    // Assert
    should(world.push.calls).equal(2);
  });
});

describe('NotificationService woke push', () => {
  it('should push once per wake, however often the wake is seen, and again for the next wake', async () => {
    // Arrange
    const world = fixture();
    const nextWake = AgendaItemSchema.parse({ ...item, waitingSince: '2026-08-07T09:00:00.000Z' });

    // Act
    await world.service.woke(SESSION, item, snapshot);
    await world.service.woke(SESSION, item, snapshot);
    await world.service.woke(SESSION, nextWake, snapshot);

    // Assert
    should(world.push.calls).equal(2);
    should(world.push.dispatches[0]?.payload.body).equal('Back from snooze: Choose a release window');
    should(requested(world)[0]).containDeep({ woke: AT });
    should(requested(world).map(record => record.key)).deepEqual([
      `agenda:${SESSION}:A1:woke:${AT}`,
      `agenda:${SESSION}:A1:woke:2026-08-07T09:00:00.000Z`,
    ]);
  });
});

/** A card's gate item (docs/board.md § Cards show progress): raised by the daemon, answered only by the owner. */
const gated = AgendaItemSchema.parse({
  id: 'A5',
  source: 'task',
  sourceRef: 'gate:F412:released:7',
  subject: 'Try it: open the Board',
  why: '&F412 reached Released · to test, which waits on you.',
  waitingSince: AT,
  howToResolve: 'Choose Not good or Done; the card moves when you answer.',
  kind: 'choice',
  title: 'Gate items',
  ask: { kind: 'multiple-choice', options: [{ label: 'Not good' }, { label: 'Done' }] },
  task: { id: 'F412' },
  gate: {
    cardId: 'F412',
    laneId: 'released',
    laneName: 'Released · to test',
    entry: 7,
    projectId: 'p-1',
    options: [
      { id: 'done', label: 'Done', outcome: 'close' },
      { id: 'not-good', label: 'Not good', outcome: 'reopen-with-agenda' },
    ],
  },
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
});

describe('NotificationService gate push', () => {
  it('should push a gate item once, at its raise, saying what to try', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.raised(SESSION, gated, snapshot);
    await world.service.raised(SESSION, gated, snapshot);

    // Assert
    should(world.push.calls).equal(1);
    should(requested(world).map(record => record.key)).deepEqual([`agenda:${SESSION}:A5:ping`]);
    should(world.push.dispatches[0]?.payload).match({ body: 'Try it: open the Board', eventKey: 'agenda-gate:A5' });
  });

  it('should leave a gate item out of a stop: alone it is no stop, beside another it is not counted', async () => {
    // Arrange
    const alone = fixture();
    const beside = fixture();
    const gateOnly = AgendaSnapshotSchema.parse({ ...snapshot, items: [gated], count: 1 });
    const both = AgendaSnapshotSchema.parse({ ...snapshot, items: [gated, item], count: 2 });

    // Act
    await alone.service.stopped(SESSION, AT, gateOnly);
    await beside.service.stopped(SESSION, AT, both);

    // Assert
    should(alone.push.calls).equal(0);
    should(beside.push.calls).equal(1);
    should(requested(beside).map(record => record.key)).deepEqual([`agenda:${SESSION}:stopped:${AT}`]);
    should(beside.push.dispatches[0]?.payload.url).containEql('A1');
  });
});

describe('NotificationService ping push', () => {
  it('should push a notice that asked to, once, and nothing for one that did not', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.raised(SESSION, notice, snapshot);
    await world.service.raised(SESSION, pinging, snapshot);
    await world.service.raised(SESSION, pinging, snapshot);
    await world.service.raised(SESSION, item, snapshot);

    // Assert
    should(world.push.calls).equal(1);
    should(requested(world).map(record => record.key)).deepEqual([`agenda:${SESSION}:A4:ping`]);
    should(world.push.dispatches[0]?.payload.body).equal('Build is green');
  });

  it('should survive a restart: a new service on the same ledger pushes nothing again', async () => {
    // Arrange
    const first = fixture();
    await first.service.raised(SESSION, pinging, snapshot);
    await first.service.stopped(SESSION, AT, snapshot);
    const restarted = fixture({ ledger: first.ledger });

    // Act
    await restarted.service.raised(SESSION, pinging, snapshot);
    await restarted.service.stopped(SESSION, AT, snapshot);

    // Assert
    should(restarted.push.calls).equal(0);
  });
});

describe('NotificationService containment', () => {
  it('should contain missing sessions, unreadable ledgers, push failures, and both append failures', async () => {
    // Arrange
    const missing = fixture();
    missing.sessions.values.delete(SESSION);
    const unreadable = fixture();
    unreadable.ledger.failFind = true;
    const requestedFailure = fixture();
    requestedFailure.ledger.failRequested = true;
    const pushFailure = fixture();
    pushFailure.push.notifyHook = async () => {
      throw new Error('push failed');
    };
    pushFailure.ledger.failOutcome = true;
    const outcomeFailure = fixture();
    outcomeFailure.ledger.failOutcome = true;

    // Act + Assert
    for (const world of [missing, unreadable, requestedFailure, pushFailure, outcomeFailure]) {
      await should(world.service.stopped(SESSION, AT, snapshot)).be.fulfilled();
    }
    should(missing.push.calls).equal(0);
    should(unreadable.push.calls).equal(0);
    should(requestedFailure.push.calls).equal(0);
    should(pushFailure.push.calls).equal(1);
    should(outcomeFailure.push.calls).equal(1);
  });

  it('should tell its diagnostics each push it made and each it could not make or deliver', async () => {
    // Arrange
    const unreadableWarnings: string[] = [];
    const unreadable = fixture({ warnings: unreadableWarnings });
    unreadable.ledger.failFind = true;
    const undeliveredWarnings: string[] = [];
    const undelivered = fixture({ warnings: undeliveredWarnings });
    undelivered.push.notifyHook = async () => {
      throw new Error('push failed');
    };
    const madeWarnings: string[] = [];
    const made = fixture({ warnings: madeWarnings });

    // Act
    await unreadable.service.stopped(SESSION, AT, snapshot);
    await undelivered.service.stopped(SESSION, AT, snapshot);
    await made.service.stopped(SESSION, AT, snapshot);
    await made.service.stopped(SESSION, AT, snapshot);

    // Assert
    const key = `agenda:${SESSION}:stopped:${AT}`;
    should(unreadableWarnings).eql([`failed ${key}: ledger cannot be read`]);
    should(undeliveredWarnings).eql([`failed ${key}: push failed`]);
    should(madeWarnings).eql([`made ${key}: 2/0`]);
  });

  it('should stay total when its diagnostics throw', async () => {
    // Arrange
    const world = fixture();
    world.ledger.failFind = true;
    const service = new NotificationService({
      ledger: world.ledger,
      sessions: world.sessions,
      push: world.push,
      serial: new KeyedSerialExecutor(),
      clock: { now: () => AT },
      diagnostics: {
        failed: () => {
          throw new Error('stderr closed');
        },
        made: () => {
          throw new Error('stderr closed');
        },
      },
    });

    // Act / Assert
    await should(service.stopped(SESSION, AT, snapshot)).be.fulfilled();
    world.ledger.failFind = false;
    await should(service.stopped(SESSION, AT, snapshot)).be.fulfilled();
    should(world.push.calls).equal(1);
    should(world.ledger.records.map(record => record.phase)).eql(['requested', 'outcome']);
  });
});

describe('NotificationService enrolled devices', () => {
  it('should count every enrolled device, zero included', async () => {
    // Arrange
    const world = fixture();
    const nobody = new Push();
    nobody.enrolled = 0;

    // Act + Assert
    should(await world.service.enrolledDevices()).equal(2);
    should(await fixture({ push: nobody }).service.enrolledDevices()).equal(0);
  });
});

/** A push recorded by a daemon that predates the agenda rename: `attention:` key, `attention` origin. */
function legacyRecord(key: string, extra: Record<string, unknown>): NotificationRecord {
  return NotificationRecordSchema.parse({
    v: 1,
    phase: 'requested',
    key,
    at: AT,
    origin: 'attention',
    attribution: 'attention:agent:session-1',
    sessionId: SESSION,
    agendaId: 'A1',
    ...extra,
    sent: { kind: 'attention', interactive: true, title: 'earlier', body: 'earlier' },
    enrolled: 1,
  });
}

describe('NotificationService across the agenda rename', () => {
  it('should write the new spelling: an agenda key and the agenda origin', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.stopped(SESSION, AT, snapshot);

    // Assert
    should(requested(world)[0]).containDeep({ key: `agenda:${SESSION}:stopped:${AT}`, origin: 'agenda' });
  });

  it('should never push again a stop, deadline or ping already recorded under the attention key', async () => {
    // Arrange — the ledger a daemon wrote BEFORE the upgrade.
    const ledger = new MemoryLedger(
      [],
      [
        legacyRecord(`attention:${SESSION}:stopped:${AT}`, { stoppedAt: AT }),
        legacyRecord(`attention:${SESSION}:A1:deadline`, { deadline: true }),
        legacyRecord(`attention:${SESSION}:A4:ping`, { agendaId: 'A4', ping: true }),
      ],
    );
    const world = fixture({ ledger });

    // Act
    await world.service.stopped(SESSION, AT, snapshot);
    await world.service.deadline(SESSION, due, snapshot);
    await world.service.raised(SESSION, pinging, snapshot);

    // Assert
    should(world.push.calls).equal(0);
    should(ledger.appends).deepEqual([]);
  });

  it('should still push a stop the old ledger does not hold, once', async () => {
    // Arrange
    const ledger = new MemoryLedger([], [legacyRecord(`attention:${SESSION}:stopped:${AT}`, { stoppedAt: AT })]);
    const world = fixture({ ledger });
    const later = '2026-08-06T11:00:00.000Z';

    // Act
    await world.service.stopped(SESSION, later, snapshot);
    await world.service.stopped(SESSION, later, snapshot);

    // Assert
    should(world.push.calls).equal(1);
  });
});

describe('NotificationRecordSchema across the agenda rename', () => {
  const base = {
    v: 1,
    phase: 'requested',
    at: AT,
    attribution: 'attention:agent:session-1',
    sessionId: SESSION,
    agendaId: 'A1',
    ping: true,
    sent: { kind: 'attention', interactive: true, title: 't', body: 'b' },
    enrolled: 1,
  };

  it('should parse a record written before the rename and one written after', () => {
    // Arrange
    const { agendaId, ...unnamed } = base;
    const before = { ...unnamed, attentionId: agendaId, key: `attention:${SESSION}:A1:ping`, origin: 'attention' };

    // Act
    const parsed = NotificationRecordSchema.safeParse(before);

    // Assert
    should(parsed.success).be.true();
    should(parsed.data).containDeep({ agendaId: 'A1' });
    should(parsed.data).not.have.property('attentionId');
    should(
      NotificationRecordSchema.safeParse({ ...base, key: `attention:${SESSION}:A1:ping`, origin: 'attention' }).success,
    ).be.true();
    should(
      NotificationRecordSchema.safeParse({ ...base, key: `agenda:${SESSION}:A1:ping`, origin: 'agenda' }).success,
    ).be.true();
  });

  it('should refuse a key that does not name its session and item, in either spelling', () => {
    // Arrange / Act / Assert
    should(
      NotificationRecordSchema.safeParse({ ...base, key: `attention:${OTHER}:A1:ping`, origin: 'attention' }).success,
    ).be.false();
    should(
      NotificationRecordSchema.safeParse({ ...base, key: `agenda:${OTHER}:A1:ping`, origin: 'agenda' }).success,
    ).be.false();
  });
});

describe('NotificationService high priority', () => {
  /** A2 is an input card asking for a one-time code; nothing else is. */
  const codeCard = (_session: string, candidate: { readonly id: string }) =>
    candidate.id === 'A2' ? ('one-time-code' as const) : ('other' as const);

  it('should push a stop at high priority only when the item it shows is the code card', async () => {
    // Arrange — the code card A2 blocks, so the stop shows it; in the other stop A1 is shown and A2 only waits.
    const shown = fixture({ subjectOf: codeCard });
    const behind = fixture({ subjectOf: codeCard });
    const blockingCode = AgendaItemSchema.parse({ ...second, blockingNow: true });

    // Act
    await shown.service.stopped(
      SESSION,
      AT,
      AgendaSnapshotSchema.parse({ ...twoWaiting, items: [item, blockingCode] }),
    );
    await behind.service.stopped(SESSION, AT, twoWaiting);

    // Assert — a throwaway code card cannot make every other push loud.
    should(shown.push.dispatches[0]?.urgency).equal('high');
    should(shown.push.dispatches[0]?.payload).containDeep({
      urgency: 'high',
      // The group's line keeps the ferret's tag even when loud, so a clear of the code card never takes it down.
      tag: `attention-${SESSION}`,
      url: `/session/${SESSION}?attention=A2`,
    });
    should(behind.push.dispatches[0]?.urgency).be.undefined();
    should(behind.push.dispatches[0]?.payload).not.have.property('urgency');
  });

  it('should push everything else as before: no urgency, the shared tag', async () => {
    // Arrange
    const world = fixture({ subjectOf: codeCard });

    // Act
    await world.service.stopped(SESSION, AT, snapshot);

    // Assert
    should(world.push.dispatches[0]?.urgency).be.undefined();
    should(world.push.dispatches[0]?.payload).not.have.property('urgency');
    should(world.push.dispatches[0]?.payload.tag).equal(`attention-${SESSION}`);
  });

  it('should send a ferret at most three high pushes a rolling hour, and leave the others theirs', async () => {
    // Arrange — every item is a code card; the clock is moved by hand.
    let now = Date.parse(AT);
    const world = fixture({ subjectOf: () => 'one-time-code', now: () => new Date(now).toISOString() });
    const card = (n: number) => AgendaItemSchema.parse({ ...due, id: `A${String(n)}` });

    // Act — one ferret raises four code cards in an hour; another ferret then raises one; an hour later, one more.
    for (let n = 1; n <= 4; n += 1) await world.service.deadline(SESSION, card(n), snapshot);
    await world.service.deadline(OTHER, card(5), snapshot);
    now += 3_600_000;
    await world.service.deadline(SESSION, card(6), snapshot);

    // Assert — still one push per card; only the urgency is capped, and only for the ferret that spent its own.
    should(world.push.dispatches.map(dispatch => dispatch.urgency ?? 'normal')).eql([
      'high',
      'high',
      'high',
      'normal',
      'high',
      'high',
    ]);
    should(world.push.dispatches[3]?.payload).not.have.property('urgency');
  });

  it('should give a high slot back when the push reached no device, so it is spent only on a push that went out', async () => {
    // Arrange — a ferret's three high slots; the first three pushes reach nobody (no device, a throw, zero accepted).
    const push = new Push();
    const world = fixture({ subjectOf: () => 'one-time-code', push });
    const card = (n: number) => AgendaItemSchema.parse({ ...due, id: `A${String(n)}` });
    const outcomes: (() => Promise<PushDeliveryResult>)[] = [
      async () => ({ delivered: 0, failed: 0 }),
      async () => {
        throw new Error('the push service is down');
      },
      async () => ({ delivered: 0, failed: 1 }),
    ];
    push.notifyHook = async () => await (outcomes.shift() ?? (async () => ({ delivered: 1, failed: 0 })))();

    // Act — three pushes that reached nobody, then three that did, then one more.
    for (let n = 1; n <= 7; n += 1) await world.service.deadline(SESSION, card(n), snapshot);

    // Assert — the failed three spent nothing, so the next three are still high; the seventh is capped.
    should(push.dispatches.map(dispatch => dispatch.urgency ?? 'normal')).eql([
      'high',
      'high',
      'high',
      'high',
      'high',
      'high',
      'normal',
    ]);
  });

  it('should send at most twelve high pushes a rolling hour across the daemon', async () => {
    // Arrange — thirteen ferrets, one code card each.
    const sessions = new Sessions();
    for (let n = 1; n <= 13; n += 1)
      sessions.values.set(`ferret-${String(n)}`, { name: `Ferret ${String(n)}`, interactive: true });
    const world = fixture({ subjectOf: () => 'one-time-code', sessions });

    // Act
    for (let n = 1; n <= 13; n += 1)
      await world.service.deadline(
        `ferret-${String(n)}`,
        AgendaItemSchema.parse({ ...due, id: `A${String(n)}` }),
        snapshot,
      );

    // Assert
    const urgencies = world.push.dispatches.map(dispatch => dispatch.urgency ?? 'normal');
    should(urgencies.filter(urgency => urgency === 'high')).have.length(12);
    should(urgencies.at(-1)).equal('normal');
  });

  it('should push a code card past its deadline at high priority too', async () => {
    // Arrange
    const world = fixture({ subjectOf: codeCard });
    const code = AgendaItemSchema.parse({ ...due, id: 'A2' });

    // Act
    await world.service.deadline(SESSION, code, snapshot);

    // Assert
    should(world.push.dispatches[0]?.urgency).equal('high');
  });
});

describe('NotificationService approve-on-phone push', () => {
  const PA = 'pa_0123456789abcdef01234567';
  const card = AgendaItemSchema.parse({
    id: 'A9',
    source: 'question',
    sourceRef: PA,
    title: 'Approve on your phone',
    subject: 'Approve on your phone: ClickUp · a@gmail.com',
    why: 'ClickUp · a@gmail.com: company.okta.com.',
    waitingSince: AT,
    howToResolve: 'Approve it on your phone.',
    kind: 'info',
    raisedBy: 'daemon',
    raisedBySession: null,
    raisedByName: null,
    phoneApproval: { id: PA },
  });
  const approval = (sequence: number, body = 'Tap 42 on your phone: ClickUp · a@gmail.com') => ({
    id: PA,
    body,
    sequence,
    secondsLeft: 90,
  });

  it('should push high, under the approval’s own tag, held no longer than the card lives, in the daemon’s words (invariant 18)', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.phoneApproval(SESSION, card, snapshot, approval(0));

    // Assert — the body is the daemon-read number and the account (owner decision !A171), nothing else.
    should(world.push.dispatches).have.length(1);
    should(world.push.dispatches[0]).containDeep({ urgency: 'high', ttlSeconds: 90 });
    should(world.push.dispatches[0]?.payload).eql({
      version: 1,
      eventKey: `phone-approval:${PA}`,
      sessionId: SESSION,
      kind: 'attention',
      title: 'Approve on your phone',
      body: 'Tap 42 on your phone: ClickUp · a@gmail.com',
      tag: `pa-${PA}`,
      url: `/session/${SESSION}?attention=A9`,
      count: 1,
      urgency: 'high',
    });
    should(requested(world)[0]).containDeep({ key: `agenda:${SESSION}:A9:phone-approval:0`, phoneApproval: 0 });
  });

  it('should push once per number: the same push again is no second one, a new number is', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.phoneApproval(SESSION, card, snapshot, approval(0));
    await world.service.phoneApproval(SESSION, card, snapshot, approval(0));
    await world.service.phoneApproval(
      SESSION,
      card,
      snapshot,
      approval(1, 'Tap 17 on your phone: ClickUp · a@gmail.com'),
    );

    // Assert — both under one tag, so the second replaces the first on the lock screen.
    should(world.push.dispatches.map(dispatch => dispatch.payload.body)).eql([
      'Tap 42 on your phone: ClickUp · a@gmail.com',
      'Tap 17 on your phone: ClickUp · a@gmail.com',
    ]);
    should(new Set(world.push.dispatches.map(dispatch => dispatch.payload.tag))).eql(new Set([`pa-${PA}`]));
  });

  it('should stay inside the per-ferret high caps, and keep its own tag when it goes out normal', async () => {
    // Arrange
    const world = fixture();

    // Act
    for (let sequence = 0; sequence < 4; sequence += 1)
      await world.service.phoneApproval(SESSION, card, snapshot, approval(sequence));

    // Assert
    should(world.push.dispatches.map(dispatch => dispatch.urgency ?? 'normal')).eql(['high', 'high', 'high', 'normal']);
    should(world.push.dispatches[3]?.payload.tag).equal(`pa-${PA}`);
  });

  it('should push nothing for a card with no time left', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.phoneApproval(SESSION, card, snapshot, { ...approval(0), secondsLeft: 0 });

    // Assert
    should(world.push.calls).equal(0);
  });

  it('should label a ferret’s own push that reads as the approve-on-phone push, in any letters', async () => {
    // Arrange — two notices a ferret raised and asked to buzz for, titled like the daemon's push.
    const world = fixture();
    const latin = AgendaItemSchema.parse({ ...pinging, id: 'A5', title: 'Approve on your phone' });
    const lookalike = AgendaItemSchema.parse({ ...pinging, id: 'A6', title: 'Аpprove оn your phone now' });

    // Act
    await world.service.raised(SESSION, latin, snapshot);
    await world.service.raised(SESSION, lookalike, snapshot);

    // Assert
    should(world.push.dispatches.map(dispatch => dispatch.payload.title)).eql([
      'Ferret “Approve on your phone”',
      'Ferret “Аpprove оn your phone now”',
    ]);
  });
});

describe("NotificationService sends in the ferret's alert lane (review round 5: a clear never follows a newer push)", () => {
  it('should record, send and record the outcome of a push inside that lane, and tell of its landing there', async () => {
    // Arrange
    const order: string[] = [];
    const world = fixture({
      callLog: order,
      lanes: {
        run: async (key, work) => {
          order.push(`enter ${key}`);
          try {
            return await work();
          } finally {
            order.push(`leave ${key}`);
          }
        },
      },
      landed: () => void order.push('landed'),
    });

    // Act
    await world.service.deadline(SESSION, due, snapshot);

    // Assert
    should(order[0]).equal(`enter ${agendaAlertLane(SESSION)}`);
    should(order.at(-1)).equal(`leave ${agendaAlertLane(SESSION)}`);
    should(order).containEql('landed');
    should(order.filter(line => line.startsWith('enter'))).have.length(1);
  });
});

describe('NotificationService tells the clearer a push landed (review round 1: a push on its way when its item was handled)', () => {
  it('should say so once the outcome of a push that reached a device is recorded, and not for one that reached none', async () => {
    // Arrange
    const landed: string[] = [];
    const world = fixture({ landed: sessionId => landed.push(sessionId) });

    // Act
    await world.service.deadline(SESSION, due, snapshot);
    world.push.result = { delivered: 0, failed: 2 };
    await world.service.stopped(SESSION, AT, snapshot);

    // Assert
    should(landed).deepEqual([SESSION]);
  });

  it('should not say so when the outcome could not be recorded, and stay total when the listener throws', async () => {
    // Arrange
    const ledger = new MemoryLedger();
    ledger.failOutcome = true;
    const landed: string[] = [];
    const failing = fixture({ ledger, landed: sessionId => landed.push(sessionId) });
    const throwing = fixture({
      landed: () => {
        throw new Error('the clearer is down');
      },
    });

    // Act
    await failing.service.deadline(SESSION, due, snapshot);
    await throwing.service.deadline(SESSION, due, snapshot);

    // Assert
    should(landed).deepEqual([]);
    should(throwing.push.calls).equal(1);
  });
});

/** A card's agenda carrying its ask (docs/agenda.md § Card asks): opened by the daemon on its ferret's behalf. */
const carrying = AgendaItemSchema.parse({
  id: 'A6',
  source: 'task',
  sourceRef: 'card-agenda:F412',
  subject: 'Try it: open the Board',
  why: '&F412 reached Released.',
  waitingSince: AT,
  howToResolve:
    "Answer the card's ask here (its buttons move the card); reply to talk it over. The ferret marks this done.",
  kind: 'reply',
  ask: { kind: 'open-question' },
  task: { id: 'F412' },
  cardAsks: [{ gate: { ...gated.gate, laneName: 'Released', cardTitle: 'Badge fix' }, at: AT }],
  raisedBy: 'daemon',
  raisedBySession: null,
  raisedByName: null,
});

describe('NotificationService card-ask push', () => {
  it('should say which card waits where, and what the owner can answer, at its raise and when it wakes the agenda', async () => {
    // Arrange
    const world = fixture();
    const woken = AgendaItemSchema.parse({ ...carrying, waitingSince: '2026-08-07T09:00:00.000Z' });

    // Act
    await world.service.raised(SESSION, carrying, snapshot);
    await world.service.woke(SESSION, woken, snapshot);

    // Assert
    should(world.push.calls).equal(2);
    for (const dispatch of world.push.dispatches) {
      should(dispatch.payload).match({
        body: '&F412 Badge fix is at Released: Done or Not good',
        eventKey: 'agenda-gate:A6',
      });
    }
  });

  it('should leave an agenda whose sole open items are card asks out of a stop: alone it is no stop, beside another it is not counted', async () => {
    // Arrange
    const alone = fixture();
    const beside = fixture();
    const onlyAsk = AgendaSnapshotSchema.parse({ ...snapshot, items: [carrying], count: 1 });
    const both = AgendaSnapshotSchema.parse({ ...snapshot, items: [carrying, item], count: 2 });

    // Act
    await alone.service.stopped(SESSION, AT, onlyAsk);
    await beside.service.stopped(SESSION, AT, both);

    // Assert
    should(alone.push.calls).equal(0);
    should(beside.push.calls).equal(1);
    should(beside.push.dispatches[0]?.payload.url).containEql('A1');
  });

  it('should count a ferret’s own thread that carries an ask once the ferret asked something after it', async () => {
    // Arrange — the ask was put on the thread at AT; the ferret asked its question later
    const asked = { ...carrying.cardAsks?.[0], at: AT };
    const askedOnly = AgendaItemSchema.parse({
      ...item,
      id: 'A7',
      task: { id: 'F412' },
      cardAsks: [asked],
      waitingSince: '2026-08-06T10:30:00.000Z',
    });
    const quiet = AgendaItemSchema.parse({ ...askedOnly, waitingSince: '2026-08-06T09:00:00.000Z' });
    const talked = fixture();
    const silent = fixture();

    // Act
    await talked.service.stopped(
      SESSION,
      '2026-08-06T11:00:00.000Z',
      AgendaSnapshotSchema.parse({ ...snapshot, items: [askedOnly], count: 1 }),
    );
    await silent.service.stopped(
      SESSION,
      '2026-08-06T11:00:00.000Z',
      AgendaSnapshotSchema.parse({ ...snapshot, items: [quiet], count: 1 }),
    );

    // Assert
    should(talked.push.calls).equal(1);
    should(silent.push.calls).equal(0);
  });
});
