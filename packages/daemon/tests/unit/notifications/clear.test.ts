import { describe, it } from 'bun:test';
import {
  agendaItemPushTag,
  agendaSessionPushTag,
  type AgendaItem,
  AgendaItemSchema,
  type AgendaSnapshot,
  PUSH_CLEAR_MAX_TAGS,
  PUSH_SEEN_MAX_TAGS,
  PushPayloadSchema,
  type PushPayload,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import type { AgendaLedger } from '../../../src/lib/agenda/index.ts';
import {
  AgendaAlertClearer,
  agendaAlertLane,
  alertStillWanted,
  alertsToClear,
  clearNotificationKey,
  clearPushPayload,
  type DeliveredAlert,
  type NotificationLedgerEntry,
  type NotificationRecord,
  type NotificationSerialExecutor,
  NotificationRecordSchema,
  uncoveredAlerts,
} from '../../../src/lib/notifications/index.ts';
import type { PushDispatch } from '../../../src/lib/push/types.ts';

const AT = '2026-11-03T09:00:00.000Z';
const LATER = '2026-11-03T10:00:00.000Z';
const SESSION = 'session-1';
const OTHER = 'session-2';

const item = (id: string, extra: Partial<AgendaItem> = {}): AgendaItem =>
  AgendaItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Secret ask words ${id}`,
    why: 'Only the owner can decide.',
    waitingSince: AT,
    howToResolve: 'Choose.',
    ask: { kind: 'open-question' },
    raisedBy: 'agent',
    raisedBySession: SESSION,
    raisedByName: 'Ada',
    ...extra,
  });

const resolved = (open: AgendaItem): ResolvedAgendaItem =>
  ({
    ...open,
    resolvedAt: LATER,
    disposition: 'done',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
  }) as unknown as ResolvedAgendaItem;

const snapshotOf = (items: readonly AgendaItem[], done: readonly ResolvedAgendaItem[] = []): AgendaSnapshot => ({
  v: 1,
  sessionId: SESSION,
  items: [...items],
  resolved: [...done],
  count: items.length,
  parseErrors: 0,
  updatedAt: AT,
});

const SNOOZED = { reason: 'snoozed' as const, at: AT, until: LATER };
const RESTING = { reason: 'replied' as const, at: AT };
const GATE = {
  cardId: 'F412',
  laneId: 'released',
  laneName: 'Released · to test',
  entry: 7,
  projectId: 'p-1',
  options: [{ id: 'done', label: 'Done', outcome: 'close' as const }],
};

/** A one-time code card: an input card, whose line a legacy high stop may have shown. */
const code = (id: string, extra: Partial<AgendaItem> = {}): AgendaItem =>
  ({ ...item(id, extra), kind: 'input', ask: undefined, input: { requestId: 'a'.repeat(32) } }) as AgendaItem;

const alert = (agendaId: string, extra: Partial<DeliveredAlert> = {}): DeliveredAlert => ({
  key: `agenda:${SESSION}:${agendaId}:ping`,
  agendaId,
  stop: false,
  tag: agendaItemPushTag(SESSION, agendaId),
  ...extra,
});

describe('the tags agenda pushes go out under', () => {
  it("should give each item its own tag and a stop the ferret's", () => {
    // Act / Assert
    should(agendaItemPushTag(SESSION, 'A3')).equal('attention-session-1:A3');
    should(agendaSessionPushTag(SESSION)).equal('attention-session-1');
  });
});

describe('whether an item still wants its alerts', () => {
  it("should keep an item on the owner's turn and an unread notice", () => {
    // Act / Assert
    should(alertStillWanted(item('A1'))).be.true();
    should(alertStillWanted(item('A2', { notice: true }))).be.true();
  });

  it("should let go of a snoozed, resting or ferret's-turn item and a snoozed notice", () => {
    // Act / Assert
    should(alertStillWanted(item('A1', { parked: SNOOZED }))).be.false();
    should(alertStillWanted(item('A1', { parked: RESTING }))).be.false();
    should(alertStillWanted(item('A1', { waitingOn: 'ferret', askedAt: AT }))).be.false();
    should(alertStillWanted(item('A2', { notice: true, parked: SNOOZED }))).be.false();
  });
});

describe('which alerts come down (the owner: "if an agenda went to sleep … dismiss all notifications")', () => {
  it('should clear an answered or resolved item, which has left the open items', () => {
    // Arrange
    const snapshot = snapshotOf([item('A2')], [resolved(item('A1'))]);

    // Act
    const clears = alertsToClear(SESSION, [alert('A1'), alert('A2')], snapshot);

    // Assert
    should(clears).deepEqual([{ tags: ['attention-session-1:A1'], covers: ['agenda:session-1:A1:ping'] }]);
  });

  it.each([
    ['snoozed', { parked: SNOOZED }],
    ['resting', { parked: RESTING }],
    ["on the ferret's turn", { waitingOn: 'ferret' as const, askedAt: AT }],
  ])('should clear an item that is %s', (_name, state) => {
    // Arrange
    const snapshot = snapshotOf([item('A1', state), item('A2')]);

    // Act
    const clears = alertsToClear(SESSION, [alert('A1')], snapshot);

    // Assert
    should(clears.flatMap(clear => clear.tags)).deepEqual(['attention-session-1:A1']);
  });

  it("should clear nothing while the item is still on the owner's turn", () => {
    // Act / Assert
    should(alertsToClear(SESSION, [alert('A1')], snapshotOf([item('A1')]))).deepEqual([]);
  });

  it('should clear nothing for an item that never buzzed', () => {
    // Act / Assert
    should(alertsToClear(SESSION, [], snapshotOf([], [resolved(item('A1'))]))).deepEqual([]);
  });

  it('should take every push of one item down under its tags, once each', () => {
    // Arrange
    const pushes = [
      alert('A1'),
      alert('A1', { key: `agenda:${SESSION}:A1:deadline` }),
      alert('A1', { key: `agenda:${SESSION}:A1:phone-approval:0`, tag: 'pa-pa_0123456789abcdef01234567' }),
    ];

    // Act
    const clears = alertsToClear(SESSION, pushes, snapshotOf([]));

    // Assert
    should(clears).deepEqual([
      {
        tags: ['attention-session-1:A1', 'pa-pa_0123456789abcdef01234567'],
        covers: pushes.map(push => push.key),
      },
    ]);
  });

  it("should keep a stop's push up while an item it counts still needs the owner", () => {
    // Arrange
    const stop = alert('A1', {
      key: `agenda:${SESSION}:stopped:${AT}`,
      stop: true,
      tag: agendaSessionPushTag(SESSION),
    });

    // Act
    const clears = alertsToClear(SESSION, [stop], snapshotOf([item('A2')], [resolved(item('A1'))]));

    // Assert
    should(clears).deepEqual([]);
  });

  it("should take a stop's push down once nothing it could count is on the owner's turn", () => {
    // Arrange
    const stop = alert('A1', {
      key: `agenda:${SESSION}:stopped:${AT}`,
      stop: true,
      tag: agendaSessionPushTag(SESSION),
    });
    // A gate item never counts towards a stop, so it does not hold the stop's line up.
    const gate = { ...item('A3'), gate: GATE } as AgendaItem;

    // Act
    const clears = alertsToClear(SESSION, [stop], snapshotOf([gate, item('A2', { parked: SNOOZED })]));

    // Assert
    should(clears).deepEqual([{ tags: ['attention-session-1'], covers: [stop.key] }]);
  });

  it('should treat a push alert with no tag as shown under the session tag', () => {
    // Arrange
    const old = alert('A1', { key: `attention:${SESSION}:A1:ping`, tag: undefined });
    const { tag: _tag, ...untagged } = old;

    // Act
    const held = alertsToClear(SESSION, [untagged], snapshotOf([item('A2')]));
    const cleared = alertsToClear(SESSION, [untagged], snapshotOf([]));

    // Assert
    should(held).deepEqual([]);
    should(cleared).deepEqual([{ tags: ['attention-session-1'], covers: [old.key] }]);
  });

  it('should clear only the opened item, though it still waits, and the stop when it was the last', () => {
    // Arrange
    const stop = alert('A1', {
      key: `agenda:${SESSION}:stopped:${AT}`,
      stop: true,
      tag: agendaSessionPushTag(SESSION),
    });
    const board = snapshotOf([item('A1'), item('A2')]);

    // Act
    const one = alertsToClear(SESSION, [alert('A1'), alert('A2'), stop], board, 'A1');
    const last = alertsToClear(SESSION, [alert('A1'), stop], snapshotOf([item('A1')]), 'A1');

    // Assert
    should(one).deepEqual([{ tags: ['attention-session-1:A1'], covers: ['agenda:session-1:A1:ping'] }]);
    should(last).deepEqual([
      { tags: ['attention-session-1:A1', 'attention-session-1'], covers: ['agenda:session-1:A1:ping', stop.key] },
    ]);
  });

  it(`should split a burst into clears of at most ${PUSH_CLEAR_MAX_TAGS} tags`, () => {
    // Arrange
    const ids = Array.from({ length: PUSH_CLEAR_MAX_TAGS + 2 }, (_, index) => `A${index + 1}`);

    // Act
    const clears = alertsToClear(
      SESSION,
      ids.map(id => alert(id)),
      snapshotOf([]),
    );

    // Assert
    should(clears.map(clear => clear.tags.length)).deepEqual([PUSH_CLEAR_MAX_TAGS, 2]);
    should(clears.flatMap(clear => clear.covers)).have.length(ids.length);
  });
});

describe('the clear payload (lead: "content-free end to end")', () => {
  it('should hold only version, kind, eventKey, sessionId and tags', () => {
    // Act
    const payload = clearPushPayload(SESSION, 'clear:session-1:agenda:session-1:A1:ping', ['attention-session-1:A1']);

    // Assert
    should(Object.keys(payload).sort()).deepEqual(['eventKey', 'kind', 'sessionId', 'tags', 'version']);
    should(PushPayloadSchema.parse(payload)).deepEqual(payload);
  });

  it('should give every clear its own key, from the instant and how many clears the ledger held', () => {
    // Act / Assert
    should(clearNotificationKey(SESSION, LATER, 3)).equal(`clear:session-1:${LATER}:3`);
  });
});

class MemoryLedger {
  readonly records: NotificationRecord[] = [];
  failAppend = false;

  constructor(seed: readonly NotificationRecord[] = []) {
    this.records.push(...seed.map(record => NotificationRecordSchema.parse(record)));
  }

  async entries(): Promise<readonly NotificationLedgerEntry[]> {
    return this.records.flatMap(record => {
      if (record.phase !== 'requested') return [];
      const outcome = this.records.find(other => other.phase === 'outcome' && other.key === record.key);
      return [{ requested: record, ...(outcome?.phase === 'outcome' ? { outcome } : {}) }];
    });
  }

  async append(record: NotificationRecord): Promise<void> {
    if (this.failAppend) throw new Error('ledger cannot be written');
    // As the file ledger reads it: a second request for one key is skipped, so a clear that reused one is a bug.
    if (
      record.phase === 'requested' &&
      this.records.some(other => other.phase === 'requested' && other.key === record.key)
    )
      throw new Error(`a second request for ${record.key}`);
    this.records.push(NotificationRecordSchema.parse(record));
  }
}

/** A push the ledger records as delivered: its request and its outcome. */
const pushed = (
  agendaId: string,
  identity: { readonly ping?: true; readonly stoppedAt?: string; readonly deadline?: true } = { ping: true },
  options: {
    readonly sessionId?: string;
    readonly delivered?: number;
    readonly tag?: string | null;
    /** When it was asked for and landed: AT, an hour before the clearer's clock, unless said. */
    readonly at?: string;
  } = {},
): NotificationRecord[] => {
  const sessionId = options.sessionId ?? SESSION;
  const key =
    identity.stoppedAt !== undefined
      ? `agenda:${sessionId}:stopped:${identity.stoppedAt}`
      : `agenda:${sessionId}:${agendaId}:${identity.deadline === true ? 'deadline' : 'ping'}`;
  const tag =
    options.tag === null
      ? {}
      : {
          tag:
            options.tag ??
            (identity.stoppedAt === undefined
              ? agendaItemPushTag(sessionId, agendaId)
              : agendaSessionPushTag(sessionId)),
        };
  return [
    NotificationRecordSchema.parse({
      v: 1,
      phase: 'requested',
      key,
      at: options.at ?? AT,
      origin: 'agenda',
      attribution: `attention:agent:${sessionId}`,
      sessionId,
      agendaId,
      ...identity,
      ...tag,
      sent: { kind: 'attention', interactive: true, title: 'Secret title', body: 'Secret body' },
      enrolled: 1,
    }),
    NotificationRecordSchema.parse({
      v: 1,
      phase: 'outcome',
      key,
      at: options.at ?? AT,
      delivered: options.delivered ?? 1,
      failed: 0,
    }),
  ];
};

const ledgerOf = (
  sessionId: string,
  open: readonly AgendaItem[],
  done: readonly ResolvedAgendaItem[] = [],
): AgendaLedger => ({
  sessionId,
  nextId: open.length + done.length + 1,
  entries: [
    ...open.map(entry => ({
      lifecycle: 'active' as const,
      origin: { kind: 'agent' as const, sessionId, name: null },
      item: entry,
    })),
    ...done.map(entry => ({
      lifecycle: 'addressed' as const,
      origin: { kind: 'agent' as const, sessionId, name: null },
      item: entry,
    })),
  ],
  updatedAt: AT,
});

interface World {
  readonly clearer: AgendaAlertClearer;
  readonly ledger: MemoryLedger;
  readonly boards: Map<string, AgendaLedger>;
  readonly sent: PushDispatch<PushPayload>[];
  failPush: boolean;
  /** The ferret's lanes, one at a time per key, as the daemon shares them with its pushes. */
  readonly lanes: NotificationSerialExecutor;
  /** Runs once as the clearer reads a board, and is gone after. */
  beforeBoard?: (() => Promise<void>) | undefined;
}

/** One at a time per key, in the order asked: the daemon's lanes. */
const laneExecutor = (): NotificationSerialExecutor => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run: <T>(key: string, work: () => Promise<T>): Promise<T> => {
      const next = (tails.get(key) ?? Promise.resolve()).then(work, work);
      tails.set(
        key,
        next.catch(() => undefined),
      );
      return next;
    },
  };
};

const world = (seed: readonly NotificationRecord[] = []): World => {
  const ledger = new MemoryLedger(seed);
  const boards = new Map<string, AgendaLedger>();
  const sent: PushDispatch<PushPayload>[] = [];
  const lanes = laneExecutor();
  const state: World = {
    ledger,
    boards,
    sent,
    failPush: false,
    lanes,
    clearer: new AgendaAlertClearer({
      ledger,
      boards: {
        read: async sessionId => {
          const hook = state.beforeBoard;
          state.beforeBoard = undefined;
          await hook?.();
          return boards.get(sessionId) ?? null;
        },
      },
      push: {
        notify: async dispatch => {
          if (state.failPush) throw new Error('push service down');
          sent.push(dispatch);
          return { delivered: 1, failed: 0 };
        },
      },
      serial: lanes,
      clock: { now: () => LATER },
    }),
  };
  return state;
};

/** A board change, as the fanout tells it; the clearer reads only the board, never this. */
const CHANGE = { change: 'answered', actor: { kind: 'human' }, via: 'pwa', snapshot: snapshotOf([]) } as never;

describe('AgendaAlertClearer (the owner: "when on 1 device is alr replied or resolved. then it should dismiss on other phones")', () => {
  it('should send one clear when a pushed item is answered, and none on the next change', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent).have.length(1);
    should(test.sent[0]?.payload).deepEqual({
      version: 1,
      kind: 'clear',
      eventKey: `clear:session-1:${LATER}:1`,
      sessionId: SESSION,
      tags: ['attention-session-1:A1'],
    });
    should(test.sent[0]).not.have.property('exceptDevice');
  });

  it("should never put the item's words, title or link in the clear it composes", async () => {
    // Arrange
    const test = world([...pushed('A1'), ...pushed('A2', { stoppedAt: AT })]);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    const json = JSON.stringify(test.sent.map(dispatch => dispatch.payload));
    should(test.sent.length).be.above(0);
    for (const dispatch of test.sent)
      should(Object.keys(dispatch.payload).sort()).deepEqual(['eventKey', 'kind', 'sessionId', 'tags', 'version']);
    for (const secret of ['Secret ask words', 'Secret title', 'Secret body', 'Only the owner', '/session/'])
      should(json).not.containEql(secret);
  });

  it("should send nothing while the item is still on the owner's turn", async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent).deepEqual([]);
  });

  it('should clear a snoozed item, and clear its next push again after it wakes and is handled', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1', { parked: SNOOZED })]));
    await test.clearer.changed(SESSION, CHANGE);
    for (const record of pushed('A1', { deadline: true })) await test.ledger.append(record);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent.map(dispatch => dispatch.payload.eventKey)).deepEqual([
      `clear:session-1:${LATER}:1`,
      `clear:session-1:${LATER}:2`,
    ]);
  });

  it('should not clear again after a restart, because the clear is in the ledger', async () => {
    // Arrange
    const first = world(pushed('A1'));
    first.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));
    await first.clearer.changed(SESSION, CHANGE);
    const restarted = world(first.ledger.records);
    restarted.boards.set(SESSION, first.boards.get(SESSION) as AgendaLedger);

    // Act
    await restarted.clearer.changed(SESSION, CHANGE);

    // Assert
    should(first.sent).have.length(1);
    should(restarted.sent).deepEqual([]);
  });

  it("should ignore a push that reached no device and another ferret's pushes", async () => {
    // Arrange
    const test = world([
      ...pushed('A1', { ping: true }, { delivered: 0 }),
      ...pushed('A1', { ping: true }, { sessionId: OTHER }),
    ]);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent).deepEqual([]);
  });

  it('should send nothing, and say nothing, when the ledger cannot be written', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));
    test.ledger.failAppend = true;

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent).deepEqual([]);
  });

  it('should count a clear the push service refused as made, so a retry storm never follows', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));
    test.failPush = true;

    // Act
    await test.clearer.changed(SESSION, CHANGE);
    test.failPush = false;
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent).deepEqual([]);
    should(test.ledger.records.filter(record => record.key.startsWith('clear:'))).have.length(1);
  });

  it('should read an empty board as nothing waiting', async () => {
    // Arrange
    const test = world(pushed('A1'));

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent.map(dispatch => dispatch.payload)).containDeep([{ tags: ['attention-session-1:A1'] }]);
  });
});

describe('AgendaAlertClearer.seen (the owner opened the item in the app)', () => {
  it('should clear the opened item on every device but the one it was opened on', async () => {
    // Arrange
    const test = world([...pushed('A1'), ...pushed('A2')]);
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1'), item('A2')]));

    // Act
    const outcome = await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Assert
    should(outcome).deepEqual({ found: true, tags: ['attention-session-1:A1'] });
    should(test.sent).have.length(1);
    should(test.sent[0]?.exceptDevice).equal('device-1');
    should(test.sent[0]?.payload).containDeep({ tags: ['attention-session-1:A1'] });
    should(test.ledger.records.find(record => record.key.startsWith('clear:'))).containDeep({ opened: 'A1' });
  });

  it('should reach every device when nobody holding one opened it (the owner at the machine)', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));

    // Act
    await test.clearer.seen(SESSION, 'A1');

    // Assert
    should(test.sent[0]).not.have.property('exceptDevice');
  });

  it('should answer nothing for an item that has no alert up, and not clear it twice', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1'), item('A2')]));

    // Act
    const quiet = await test.clearer.seen(SESSION, 'A2', 'device-1');
    const first = await test.clearer.seen(SESSION, 'A1', 'device-1');
    const again = await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Assert
    should([quiet, first, again]).deepEqual([
      { found: true, tags: [] },
      { found: true, tags: ['attention-session-1:A1'] },
      { found: true, tags: [] },
    ]);
    should(test.sent).have.length(1);
  });

  it('should refuse an item that is not on that board, open or closed', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));

    // Act
    const missing = await test.clearer.seen(SESSION, 'A9', 'device-1');
    const closed = await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Assert
    should(missing).deepEqual({ found: false });
    should(closed).deepEqual({ found: true, tags: ['attention-session-1:A1'] });
  });
});

describe('uncoveredAlerts', () => {
  it('should read a push recorded before tags were, under the old key spelling, as untagged', () => {
    // Arrange
    const [requested, outcome] = pushed('A1', { ping: true }, { tag: null });
    const legacy = { ...requested, key: `attention:${SESSION}:A1:ping` } as NotificationRecord;
    const entries = [{ requested: legacy, outcome }] as NotificationLedgerEntry[];

    // Act
    const alerts = uncoveredAlerts(SESSION, entries);

    // Assert
    // Every tag it may have gone out under: the session's, and the item's (a high push), each covered on its own.
    should(alerts).deepEqual([
      { key: `agenda:${SESSION}:A1:ping`, agendaId: 'A1', stop: false },
      { key: `agenda:${SESSION}:A1:ping#item`, agendaId: 'A1', stop: false, tag: 'attention-session-1:A1' },
    ]);
  });

  it('should skip a push still in flight and one that errored', () => {
    // Arrange
    const [requested, outcome] = pushed('A1');
    const errored = { ...outcome, error: 'push service down' } as NotificationRecord;

    // Act
    const inFlight = uncoveredAlerts(SESSION, [{ requested } as NotificationLedgerEntry]);
    const failed = uncoveredAlerts(SESSION, [{ requested, outcome: errored } as NotificationLedgerEntry]);

    // Assert
    should(inFlight).deepEqual([]);
    should(failed).deepEqual([]);
  });
});

describe('a legacy push (recorded before tags were; review round 1)', () => {
  it("should clear a high code alert's item tag though another item still waits, and its session tag only later", async () => {
    // Arrange — a high push went out under the item's tag, but the ledger did not record which.
    const test = world(pushed('A1', { ping: true }, { tag: null }));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A2')], [resolved(item('A1'))]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1')), resolved(item('A2'))]));
    await test.clearer.changed(SESSION, CHANGE);
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1:A1'],
      ['attention-session-1'],
    ]);
  });

  it("should clear an approve-on-phone push under its approval's tag, read from the item", async () => {
    // Arrange
    const [requested, outcome] = pushed('A1', { ping: true }, { tag: null });
    const approval = NotificationRecordSchema.parse({
      ...requested,
      key: `agenda:${SESSION}:A1:phone-approval:0`,
      ping: undefined,
      phoneApproval: 0,
    });
    const landed = NotificationRecordSchema.parse({ ...outcome, key: approval.key });
    const card = { ...item('A1'), kind: 'info', phoneApproval: { id: 'pa_0123456789abcdef01234567' } } as AgendaItem;
    const test = world([approval, landed]);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(card)]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['pa-pa_0123456789abcdef01234567'],
    ]);
  });

  it('should clear a legacy stop under every code card that no longer waits, whenever it was handled (review rounds 3–4)', async () => {
    // Arrange — the ledger names the stop's oldest item, A1, but a high stop showed a code card's tag. A2 was snoozed
    // and woken since (its waiting time moved past the stop) and A4 was resolved before the stop's record was written.
    const EARLIER = '2026-11-03T08:00:00.000Z';
    const gone = { ...resolved(code('A4', { waitingSince: EARLIER })), resolvedAt: EARLIER } as ResolvedAgendaItem;
    const test = world(pushed('A1', { stoppedAt: AT }, { tag: null }));
    test.boards.set(
      SESSION,
      ledgerOf(
        SESSION,
        [{ ...code('A3', { waitingSince: LATER }), gate: GATE } as AgendaItem],
        [resolved(item('A1')), resolved(code('A2', { waitingSince: LATER })), gone],
      ),
    );

    // Act
    await test.clearer.changed(SESSION, CHANGE);

    // Assert — A3 still waits on the owner, so its line is still true and stays.
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1', 'attention-session-1:A2', 'attention-session-1:A4'],
    ]);
  });

  it('should give every part of a split legacy burst its own key, and count a stop cleared only by its last part', async () => {
    // Arrange — three untagged stops; nine code cards handled since, each a tag any of them may have shown.
    const stops = ['08:00', '08:20', '08:40'].map(at => `2026-11-03T${at}:00.000Z`);
    const cards = Array.from({ length: 9 }, (_, index) => resolved(code(`A${index + 2}`)));
    const test = world(stops.flatMap(at => pushed('A1', { stoppedAt: at }, { tag: null })));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1')), ...cards]));

    // Act
    await test.clearer.changed(SESSION, CHANGE);
    await test.clearer.changed(SESSION, CHANGE);

    // Assert
    const records = test.ledger.records.flatMap(record =>
      record.phase === 'requested' && record.origin === 'agenda-clear' ? [record] : [],
    );
    should(records.map(record => record.tags.length)).deepEqual([PUSH_CLEAR_MAX_TAGS, 10 - PUSH_CLEAR_MAX_TAGS]);
    should(new Set(records.map(record => record.key)).size).equal(2);
    should(records.map(record => record.covers.length)).deepEqual([0, 3]);
  });

  it('should leave an approve-on-phone push uncovered when its item is gone from the board', () => {
    // Act / Assert
    should(
      alertsToClear(SESSION, [{ key: 'k', agendaId: 'A1', stop: false, approval: true }], snapshotOf([])),
    ).deepEqual([]);
  });
});

describe('a push still on its way when its item is handled or opened (review round 1)', () => {
  /** A push recorded as requested, with no outcome yet. */
  /** A push recorded as requested, with no outcome yet: asked for at the clearer's own clock. */
  const onItsWay = (agendaId: string): NotificationRecord[] =>
    pushed(agendaId, { ping: true }, { at: LATER }).slice(0, 1);
  const landing = (agendaId: string): NotificationRecord =>
    pushed(agendaId, { ping: true }, { at: LATER })[1] as NotificationRecord;

  it('should clear it once it lands, after the item was answered while it was on its way', async () => {
    // Arrange
    const test = world(onItsWay('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));
    await test.clearer.changed(SESSION, CHANGE);
    const before = test.sent.length;

    // Act
    await test.ledger.append(landing('A1'));
    await test.clearer.recheck(SESSION);

    // Assert
    should(before).equal(0);
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1:A1'],
    ]);
  });

  it('should honour an open made while it was on its way, on every device: the opener closed only what was showing', async () => {
    // Arrange — the item still waits on the owner; only the open says its line should come down.
    const test = world(onItsWay('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));
    const opened = await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Act
    await test.ledger.append(landing('A1'));
    await test.clearer.recheck(SESSION);
    await test.clearer.recheck(SESSION);

    // Assert
    should(opened).deepEqual({ found: true, tags: [] });
    should(test.sent).have.length(1);
    should(test.sent[0]).not.have.property('exceptDevice');
    should(test.sent[0]?.payload).containDeep({ tags: ['attention-session-1:A1'] });
  });

  it('should honour an open of the last item for a stop on its way, and not while another item still waits (review round 3)', async () => {
    // Arrange — a grouped stop is on its way; the owner opens an item before it lands.
    const stopOnItsWay = pushed('A1', { stoppedAt: AT }, { at: LATER }).slice(0, 1);
    const stopLanding = pushed('A1', { stoppedAt: AT }, { at: LATER })[1] as NotificationRecord;
    const last = world(stopOnItsWay);
    last.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));
    const notLast = world(stopOnItsWay);
    notLast.boards.set(SESSION, ledgerOf(SESSION, [item('A1'), item('A2')]));

    // Act
    for (const test of [last, notLast]) {
      await test.clearer.seen(SESSION, 'A1', 'device-1');
      await test.ledger.append(stopLanding);
      await test.clearer.recheck(SESSION);
    }

    // Assert
    should(last.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1'],
    ]);
    should(notLast.sent).deepEqual([]);
  });

  it("should keep waiting while the push has not landed, and forget an open for another ferret's push", async () => {
    // Arrange
    const test = world([...onItsWay('A1'), ...pushed('A9', { ping: true }, { sessionId: OTHER }).slice(0, 1)]);
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));
    test.boards.set(OTHER, ledgerOf(OTHER, [item('A9')]));
    await test.clearer.seen(SESSION, 'A1', 'device-1');
    await test.clearer.seen(OTHER, 'A9', 'device-1');

    // Act
    await test.clearer.recheck(SESSION);

    // Assert
    should(test.sent).deepEqual([]);
  });

  it('should remember no more opens than its bound, forgetting the oldest first', async () => {
    // Arrange — 260 items, each with a push on its way, each opened.
    const ids = Array.from({ length: 260 }, (_, index) => `A${index + 1}`);
    const test = world(ids.flatMap(onItsWay));
    test.boards.set(
      SESSION,
      ledgerOf(
        SESSION,
        ids.map(id => item(id)),
      ),
    );
    for (const id of ids) await test.clearer.seen(SESSION, id, 'device-1');

    // Act — the oldest open's push and the newest one's both land.
    await test.ledger.append(landing('A1'));
    await test.ledger.append(landing('A260'));
    await test.clearer.recheck(SESSION);

    // Assert
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1:A260'],
    ]);
  });

  it('should drop an open whose push is gone from the ledger', async () => {
    // Arrange
    const test = world(onItsWay('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));
    for (let index = 0; index < 300; index += 1) await test.clearer.seen(SESSION, 'A1', `device-${index}`);
    test.ledger.records.splice(0, test.ledger.records.length);

    // Act
    await test.clearer.recheck(SESSION);

    // Assert
    should(test.sent).deepEqual([]);
  });
});

describe('an open made while a push is being sent in its lane (review round 6)', () => {
  for (const [what, records, tag] of [
    ['an item push', pushed('A1', { ping: true }, { at: LATER }), 'attention-session-1:A1'],
    ['a stop, for the last item', pushed('A1', { stoppedAt: AT }, { at: LATER }), 'attention-session-1'],
  ] as const) {
    it(`should clear ${what} that landed while the open waited on every device, the opener's too`, async () => {
      // Arrange — the push is recorded and being sent, holding the ferret's lane, when the owner opens A1.
      const [requested, outcome] = records;
      const test = world([requested as NotificationRecord]);
      test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));
      let release = (): void => undefined;
      const transport = new Promise<void>(resolve => {
        release = resolve;
      });
      const sending = test.lanes.run(agendaAlertLane(SESSION), async () => {
        await transport;
        await test.ledger.append(outcome as NotificationRecord);
      });
      // Act — the open waits for the lane; the push lands (shown after the open) before the open runs.
      const opening = test.clearer.seen(SESSION, 'A1', 'device-1');
      release();
      await sending;
      const answer = await opening;

      // Assert
      should(answer).deepEqual({ found: true, tags: [] });
      should(test.sent).have.length(1);
      should(test.sent[0]).not.have.property('exceptDevice');
      should(test.sent[0]?.payload).containDeep({ tags: [tag] });
    });
  }
});

describe('pushes from before an open, and from before this release (review round 7)', () => {
  const DAYS_AGO = '2026-11-01T09:00:00.000Z';
  const JUST_NOW = '2026-11-03T09:59:45.000Z';

  it('should leave a push that had landed before the open to the clear that skips the opener (review round 8)', async () => {
    // Arrange — A1's push landed 15 s before the open: the owner most likely just tapped it on this phone.
    const test = world([...pushed('A1', { ping: true }, { at: JUST_NOW }), ...pushed('A1', { deadline: true })]);
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));

    // Act
    const answer = await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Assert — one clear, never on the phone in the owner's hand; its page closes the item's own line itself.
    should(test.sent.map(dispatch => dispatch.exceptDevice)).deepEqual(['device-1']);
    should(answer).deepEqual({ found: true, tags: ['attention-session-1:A1'] });
  });

  it('should forget a push that never landed long ago: it is not on its way any more', async () => {
    // Arrange — recorded half an hour before the open, and no outcome ever.
    const test = world(pushed('A1', { ping: true }, { at: '2026-11-03T09:30:00.000Z' }).slice(0, 1));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')]));
    await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Act
    await test.ledger.append(pushed('A1', { ping: true }, { at: '2026-11-03T09:30:00.000Z' })[1] as NotificationRecord);
    await test.clearer.recheck(SESSION);

    // Assert
    should(test.sent).deepEqual([]);
  });

  it('should send nothing at start for pushes from before tags were, however recent, and clear them on a change (review round 8)', async () => {
    // Arrange — the first start after upgrade: sixty finished ferrets, each with an untagged push under two days old.
    const others = Array.from({ length: 60 }, (_, index) => `session-old-${index}`);
    const test = world([
      ...others.flatMap(sessionId => pushed('A1', { ping: true }, { tag: null, sessionId })),
      ...pushed('A1', { ping: true }, { tag: null }),
    ]);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));

    // Act
    await test.clearer.sweep();
    const atStart = test.sent.length;
    await test.clearer.changed(SESSION, CHANGE);

    // Assert — its own ferret's next change clears it, under every tag it may have used.
    should(atStart).equal(0);
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1', 'attention-session-1:A1'],
    ]);
  });

  it('should leave a push from before tags were up once it is two days old, but clear a tagged one of any age', async () => {
    // Arrange — on the first start after upgrade, the whole history is uncovered.
    const test = world([
      ...pushed('A1', { ping: true }, { tag: null, at: DAYS_AGO }),
      ...pushed('A2', { ping: true }, { at: DAYS_AGO }),
      ...pushed('A3', { ping: true }, { tag: null, at: DAYS_AGO, sessionId: OTHER }),
    ]);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1')), resolved(item('A2'))]));

    // Act
    await test.clearer.sweep();

    // Assert — the other ferret had nothing young enough to look at, so its board was never read.
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1:A2'],
    ]);
    should(uncoveredAlerts(OTHER, await test.ledger.entries())).have.length(2);
  });
});

describe('an open that names more tags than one answer carries (review round 5)', () => {
  it(`should answer at most ${PUSH_SEEN_MAX_TAGS} tags, and send the rest to every device, the opener's too`, async () => {
    // Arrange — a legacy stop, and more code cards handled since than one answer may name.
    const cards = Array.from({ length: PUSH_SEEN_MAX_TAGS + 20 }, (_, index) => resolved(code(`A${index + 2}`)));
    const test = world(pushed('A1', { stoppedAt: AT }, { tag: null }));
    test.boards.set(SESSION, ledgerOf(SESSION, [item('A1')], cards));

    // Act
    const outcome = await test.clearer.seen(SESSION, 'A1', 'device-1');

    // Assert
    const tags = outcome.found ? outcome.tags : [];
    const skipped = test.sent.filter(dispatch => dispatch.exceptDevice === 'device-1');
    should(tags.length).be.belowOrEqual(PUSH_SEEN_MAX_TAGS);
    should(skipped.flatMap(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual(tags);
    should(test.sent.length).be.above(skipped.length);
    should(new Set(test.sent.flatMap(dispatch => (dispatch.payload as { tags: string[] }).tags)).size).equal(
      cards.length + 1,
    );
  });
});

describe('a push raised while a clear reads the board (review round 5)', () => {
  it('should send the clear before the newer push about the item, and never cover that push', async () => {
    // Arrange — A1's push is up and A1 is handled; as the clear reads the board, A1 wakes and its push is sent.
    const test = world(pushed('A1'));
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));
    const seenBefore: number[] = [];
    let woke: Promise<void> = Promise.resolve();
    test.beforeBoard = async () => {
      // As NotificationService sends it: in the ferret's lane, recorded and landed there.
      woke = test.lanes.run(agendaAlertLane(SESSION), async () => {
        seenBefore.push(test.sent.length);
        for (const record of pushed('A1', { deadline: true })) await test.ledger.append(record);
      });
    };

    // Act
    await test.clearer.changed(SESSION, CHANGE);
    await woke;

    // Assert — the older clear went first, and the woken push is still up, uncovered.
    should(seenBefore).deepEqual([1]);
    should(uncoveredAlerts(SESSION, await test.ledger.entries()).map(alert => alert.key)).deepEqual([
      `agenda:${SESSION}:A1:deadline`,
    ]);
  });
});

describe('AgendaAlertClearer.sweep (a board that changed while the daemon was down)', () => {
  it('should look once at every ferret with an alert still up, and at nobody else', async () => {
    // Arrange
    const reads: string[] = [];
    const test = world([...pushed('A1'), ...pushed('A2', { ping: true }, { sessionId: OTHER, delivered: 0 })]);
    test.boards.set(SESSION, ledgerOf(SESSION, [], [resolved(item('A1'))]));
    const read = test.boards.get.bind(test.boards);
    test.boards.get = (id: string) => {
      reads.push(id);
      return read(id);
    };

    // Act
    await test.clearer.sweep();

    // Assert
    should(reads).deepEqual([SESSION]);
    should(test.sent.map(dispatch => (dispatch.payload as { tags: string[] }).tags)).deepEqual([
      ['attention-session-1:A1'],
    ]);
  });

  it('should do nothing when the ledger cannot be read', async () => {
    // Arrange
    const test = world(pushed('A1'));
    test.ledger.entries = async () => {
      throw new Error('ledger cannot be read');
    };

    // Act / Assert
    await test.clearer.sweep();
    should(test.sent).deepEqual([]);
  });
});
