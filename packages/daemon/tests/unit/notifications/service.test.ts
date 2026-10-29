import { describe, it } from 'bun:test';
import { AttentionItemSchema, AttentionSnapshotSchema, type PushDeliveryResult } from '@ferretry/protocol';
import should from 'should';
import { KeyedSerialExecutor } from '../../../src/adapters/system/keyed-serial-executor.ts';
import { NotificationService } from '../../../src/lib/notifications/service.ts';
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
      clock: { now: () => AT },
    }),
  };
}

const item = AttentionItemSchema.parse({
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

const snapshot = AttentionSnapshotSchema.parse({
  v: 1,
  sessionId: SESSION,
  items: [item],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: AT,
});
const second = AttentionItemSchema.parse({ ...item, id: 'A2', subject: 'Choose a region' });
const twoWaiting = AttentionSnapshotSchema.parse({ ...snapshot, items: [item, second], count: 2 });
const notice = AttentionItemSchema.parse({ ...item, id: 'A3', notice: true, subject: 'Build is green' });
const pinging = AttentionItemSchema.parse({ ...notice, id: 'A4', ping: true });
const due = AttentionItemSchema.parse({ ...item, neededBy: '2026-08-06T12:00:00.000Z' });

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
    should(requested(world)[0]).containDeep({ key: `attention:${SESSION}:stopped:${AT}`, stoppedAt: AT });
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
    const ferretTurn = AttentionItemSchema.parse({ ...item, waitingOn: 'ferret', askedAt: AT });
    const waiting = AttentionSnapshotSchema.parse({ ...snapshot, items: [ferretTurn, notice], count: 2 });

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
    should(requested(world)[0]).containDeep({ key: `attention:${SESSION}:A1:deadline`, deadline: true });
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
    should(requested(world).map(record => record.key)).deepEqual([`attention:${SESSION}:A4:ping`]);
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
});

describe('NotificationService delivered count', () => {
  it('should report the devices a ping reached, and zero for an unpushed notice, an error or an unreadable ledger', async () => {
    // Arrange
    const world = fixture();
    world.push.result = { delivered: 2, failed: 1 };
    const failing = fixture();
    failing.push.notifyHook = async () => {
      throw new Error('push failed');
    };
    const unreadable = fixture();
    await unreadable.service.raised(SESSION, pinging, snapshot);
    unreadable.ledger.failFind = true;

    // Act
    await world.service.raised(SESSION, pinging, snapshot);
    await failing.service.raised(SESSION, pinging, snapshot);

    // Assert
    should(await world.service.attentionDelivered(SESSION, 'A4')).equal(2);
    should(await world.service.attentionDelivered(SESSION, 'A9')).equal(0);
    should(await failing.service.attentionDelivered(SESSION, 'A4')).equal(0);
    should(await unreadable.service.attentionDelivered(SESSION, 'A4')).equal(0);
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
