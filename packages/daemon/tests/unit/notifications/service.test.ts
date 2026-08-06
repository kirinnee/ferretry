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
} from '../../../src/lib/notifications/types.ts';
import type { PushDispatch } from '../../../src/lib/push/types.ts';

const AT = '2026-08-06T10:00:00.000Z';
const SESSION = 'session-1';
const OTHER = 'session-2';
const HUMAN = { kind: 'human' as const };
const AGENT = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const REQUEST = { body: 'The release is ready for review.' };

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
  readonly values = new Map<string, { name: string; interactive: boolean }>([
    [SESSION, { name: 'Release agent', interactive: true }],
    [OTHER, { name: 'Second agent', interactive: false }],
  ]);
  failure?: Error;

  async describe(sessionId: string): Promise<{ readonly name: string; readonly interactive: boolean } | undefined> {
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

async function notify(world: ReturnType<typeof fixture>, requestId = 'req-1') {
  return await world.service.notifyDirect(SESSION, REQUEST, AGENT, `peer:${SESSION}`, requestId);
}

describe('NotificationService direct delivery', () => {
  it('should write ahead, push once, then settle with the actual counts', async () => {
    // Arrange
    const callLog: string[] = [];
    const world = fixture({ callLog });
    world.push.result = { delivered: 1, failed: 1 };

    // Act
    const actual = await notify(world);

    // Assert
    should(actual).deepEqual({ ok: true, value: { sessionId: SESSION, delivered: 1 } });
    should(callLog).deepEqual(['append:requested', 'push', 'append:outcome']);
    should(world.ledger.records).have.length(2);
    should(world.ledger.records[0]).containDeep({
      phase: 'requested',
      origin: 'direct',
      attribution: `peer:${SESSION}`,
      sessionId: SESSION,
      request: { body: REQUEST.body, title: null, kind: null },
      sent: { kind: 'question', interactive: true, title: 'Release agent', body: REQUEST.body },
      enrolled: 2,
    });
    should(world.ledger.records[1]).containDeep({ phase: 'outcome', delivered: 1, failed: 1 });
  });

  it('should replay a settled call without another push', async () => {
    // Arrange
    const world = fixture();
    const first = await notify(world);

    // Act
    const replay = await notify(world);

    // Assert
    should(replay).deepEqual(first);
    should(world.push.calls).equal(1);
    should(world.sessions.calls).deepEqual([SESSION]);
  });

  it('should serialize concurrent duplicates across the complete delivery', async () => {
    // Arrange
    const world = fixture();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => {
      started = resolve;
    });
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    world.push.notifyHook = async () => {
      started();
      await held;
      return { delivered: 1, failed: 0 };
    };

    // Act
    const first = notify(world);
    await entered;
    const second = notify(world);
    release();
    const [one, two] = await Promise.all([first, second]);

    // Assert
    should(one).deepEqual(two);
    should(world.push.calls).equal(1);
    should(world.ledger.records).have.length(2);
  });

  it('should replay after a fresh service is constructed over the same durable records', async () => {
    // Arrange
    const firstWorld = fixture();
    const first = await notify(firstWorld);
    const ledger = new MemoryLedger([], firstWorld.ledger.records);
    const secondWorld = fixture({ ledger });

    // Act
    const replay = await notify(secondWorld);

    // Assert
    should(replay).deepEqual(first);
    should(secondWorld.push.calls).equal(0);
    should(secondWorld.sessions.calls).be.empty();
  });

  it('should refuse one id reused with a different body, actor, or session', async () => {
    // Arrange
    const variants = [
      async (world: ReturnType<typeof fixture>) =>
        await world.service.notifyDirect(SESSION, { body: 'Different body' }, AGENT, `peer:${SESSION}`, 'req-1'),
      async (world: ReturnType<typeof fixture>) =>
        await world.service.notifyDirect(SESSION, REQUEST, HUMAN, 'admin-cli', 'req-1'),
      async (world: ReturnType<typeof fixture>) =>
        await world.service.notifyDirect(OTHER, REQUEST, HUMAN, 'admin-cli', 'req-1'),
    ];

    // Act + Assert
    for (const variant of variants) {
      const world = fixture();
      await notify(world);
      world.sessions.calls.length = 0;
      const actual = await variant(world);
      should(actual).containDeep({ ok: false, error: { code: 'invalid' } });
      should(world.push.calls).equal(1);
      should(world.sessions.calls).be.empty();
    }
  });

  it('should block delivery when requested evidence cannot be appended', async () => {
    // Arrange
    const world = fixture();
    world.ledger.failRequested = true;

    // Act
    const actual = await notify(world);

    // Assert
    should(actual).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(world.push.calls).equal(0);
    should(world.ledger.records).be.empty();
    should(world.ledger.appends.map(record => record.phase)).deepEqual(['requested']);
  });

  it('should answer true counts when outcome append fails and block every later retry', async () => {
    // Arrange
    const world = fixture();
    world.ledger.failOutcome = true;
    world.push.result = { delivered: 1, failed: 1 };

    // Act
    const first = await notify(world);
    const replay = await notify(world);

    // Assert
    should(first).deepEqual({ ok: true, value: { sessionId: SESSION, delivered: 1 } });
    should(replay).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(world.push.calls).equal(1);
    should(world.ledger.records.map(record => record.phase)).deepEqual(['requested']);
  });

  it('should record a thrown delivery and re-raise it without another push', async () => {
    // Arrange
    const world = fixture();
    world.push.notifyHook = async () => {
      throw new Error('push transport unavailable');
    };

    // Act
    const first = await notify(world);
    const replay = await notify(world);

    // Assert
    should(first).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(replay).deepEqual(first);
    should(world.push.calls).equal(1);
    should(world.ledger.records[1]).containDeep({ phase: 'outcome', error: 'push transport unavailable' });
  });

  it('should remain corrupt when recording a delivery error also fails', async () => {
    // Arrange
    const world = fixture();
    world.ledger.failOutcome = true;
    world.push.notifyHook = async () => {
      throw '';
    };

    // Act
    const actual = await notify(world);

    // Assert
    should(actual).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(actual.ok ? '' : actual.error.message).match(/unknown notification delivery error/u);
    should(world.ledger.records.map(record => record.phase)).deepEqual(['requested']);
  });

  it('should fail closed when the ledger cannot be read', async () => {
    // Arrange
    const world = fixture();
    world.ledger.failFind = true;

    // Act
    const actual = await notify(world);

    // Assert
    should(actual).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(world.push.calls).equal(0);
    should(world.sessions.calls).be.empty();
  });

  it('should settle and replay zero delivery without trying again', async () => {
    // Arrange
    const world = fixture();
    world.push.enrolled = 4;
    world.push.result = { delivered: 0, failed: 0 };

    // Act
    const first = await notify(world);
    const replay = await notify(world);

    // Assert
    should(first).deepEqual({ ok: true, value: { sessionId: SESSION, delivered: 0 } });
    should(replay).deepEqual(first);
    should(world.push.calls).equal(1);
    should(world.ledger.records[0]).containDeep({ phase: 'requested', enrolled: 4 });
  });

  it('should authorize confinement before any ledger or session access', async () => {
    // Arrange
    const world = fixture();

    // Act
    const invalid = await world.service.notifyDirect('../escape', REQUEST, HUMAN, 'admin-cli', 'invalid');
    const empty = await world.service.notifyDirect(SESSION, REQUEST, HUMAN, 'admin-cli', '   ');
    const forbidden = await world.service.notifyDirect(
      SESSION,
      REQUEST,
      { kind: 'agent', sessionId: OTHER, name: 'Mallory' },
      `peer:${OTHER}`,
      'forbidden',
    );

    // Assert
    should(invalid).containDeep({ ok: false, error: { code: 'invalid' } });
    should(empty).containDeep({ ok: false, error: { code: 'invalid' } });
    should(forbidden).containDeep({ ok: false, error: { code: 'forbidden' } });
    should(world.ledger.finds).be.empty();
    should(world.ledger.appends).be.empty();
    should(world.sessions.calls).be.empty();
  });

  it('should refuse an unknown session only for a new notification', async () => {
    // Arrange
    const world = fixture();
    world.sessions.values.delete(SESSION);

    // Act
    const actual = await notify(world);

    // Assert
    should(actual).containDeep({ ok: false, error: { code: 'not-found' } });
    should(world.ledger.records).be.empty();
    should(world.push.calls).equal(0);
  });

  it('should replay without reading a deleted, renamed, or mode-flipped session', async () => {
    // Arrange / Act + Assert
    for (const mutate of [
      (sessions: Sessions) => sessions.values.delete(SESSION),
      (sessions: Sessions) => sessions.values.set(SESSION, { name: 'Renamed', interactive: true }),
      (sessions: Sessions) => sessions.values.set(SESSION, { name: 'Release agent', interactive: false }),
    ]) {
      const world = fixture();
      const first = await notify(world);
      mutate(world.sessions);
      world.sessions.calls.length = 0;
      const replay = await notify(world);
      should(replay).deepEqual(first);
      should(world.sessions.calls).be.empty();
      should(world.push.calls).equal(1);
    }
  });

  it('should refuse a dangling request without consulting mutable session state', async () => {
    // Arrange
    const world = fixture();
    world.ledger.failOutcome = true;
    await notify(world);
    world.sessions.calls.length = 0;
    world.sessions.failure = new Error('session directory must not be read');

    // Act
    const actual = await notify(world);

    // Assert
    should(actual).containDeep({ ok: false, error: { code: 'corrupt' } });
    should(world.sessions.calls).be.empty();
    should(world.push.calls).equal(1);
  });

  it('should thread authoritative auto and interactive modes into push dispatch', async () => {
    // Arrange
    const world = fixture();

    // Act
    await world.service.notifyDirect(SESSION, REQUEST, HUMAN, 'admin-cli', 'interactive');
    await world.service.notifyDirect(OTHER, REQUEST, HUMAN, 'admin-cli', 'auto');

    // Assert
    should(world.push.dispatches.map(dispatch => dispatch.interactive)).deepEqual([true, false]);
  });
});

describe('NotificationService attention presentation', () => {
  it('should deliver different item ids, and replay the same item id', async () => {
    // Arrange
    const world = fixture();
    const second = AttentionItemSchema.parse({ ...item, id: 'A2', subject: 'Choose a region' });
    const secondSnapshot = AttentionSnapshotSchema.parse({
      ...snapshot,
      items: [item, second],
      count: 2,
    });

    // Act
    await world.service.attentionRaised(SESSION, item, snapshot);
    await world.service.raised(SESSION, second, secondSnapshot);
    await world.service.attentionRaised(SESSION, item, snapshot);

    // Assert
    should(world.push.calls).equal(2);
    should(world.ledger.records.filter(record => record.phase === 'requested').map(record => record.key)).deepEqual([
      `attention:${SESSION}:A1`,
      `attention:${SESSION}:A2`,
    ]);
    should(world.ledger.records[0]).containDeep({
      origin: 'attention',
      attentionId: 'A1',
      attribution: `attention:agent:${SESSION}`,
      sent: { body: item.why, interactive: true },
    });
  });

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
      await should(world.service.attentionRaised(SESSION, item, snapshot)).be.fulfilled();
    }
    should(missing.push.calls).equal(0);
    should(unreadable.push.calls).equal(0);
    should(requestedFailure.push.calls).equal(0);
    should(pushFailure.push.calls).equal(1);
    should(outcomeFailure.push.calls).equal(1);
  });
});
