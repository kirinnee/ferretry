import { describe, it } from 'bun:test';
import {
  agendaItemPushTag,
  agendaSessionPushTag,
  type AgendaItem,
  AgendaItemSchema,
  type AgendaSnapshot,
  PUSH_CLEAR_MAX_TAGS,
  PushPayloadSchema,
  type PushPayload,
  type ResolvedAgendaItem,
} from '@ferretry/protocol';
import should from 'should';
import type { AgendaLedger } from '../../../src/lib/agenda/index.ts';
import {
  AgendaAlertClearer,
  alertStillWanted,
  alertsToClear,
  clearNotificationKey,
  clearPushPayload,
  type DeliveredAlert,
  type NotificationLedgerEntry,
  type NotificationRecord,
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

  it('should treat a push recorded without a tag as shown under the session tag', () => {
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

  it('should name a clear by the newest push it covers', () => {
    // Act / Assert
    should(clearNotificationKey(SESSION, ['agenda:s:A1:ping', 'agenda:s:A1:deadline'])).equal(
      'clear:session-1:agenda:s:A1:ping',
    );
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
    this.records.push(NotificationRecordSchema.parse(record));
  }
}

/** A push the ledger records as delivered: its request and its outcome. */
const pushed = (
  agendaId: string,
  identity: { readonly ping?: true; readonly stoppedAt?: string; readonly deadline?: true } = { ping: true },
  options: { readonly sessionId?: string; readonly delivered?: number; readonly tag?: string | null } = {},
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
      at: AT,
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
      at: AT,
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
}

const world = (seed: readonly NotificationRecord[] = []): World => {
  const ledger = new MemoryLedger(seed);
  const boards = new Map<string, AgendaLedger>();
  const sent: PushDispatch<PushPayload>[] = [];
  const state: World = {
    ledger,
    boards,
    sent,
    failPush: false,
    clearer: new AgendaAlertClearer({
      ledger,
      boards: { read: async sessionId => boards.get(sessionId) ?? null },
      push: {
        notify: async dispatch => {
          if (state.failPush) throw new Error('push service down');
          sent.push(dispatch);
          return { delivered: 1, failed: 0 };
        },
      },
      serial: { run: async (_key, work) => await work() },
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
      eventKey: 'clear:session-1:agenda:session-1:A1:ping',
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
      'clear:session-1:agenda:session-1:A1:ping',
      'clear:session-1:agenda:session-1:A1:deadline',
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
    should(alerts).deepEqual([{ key: `agenda:${SESSION}:A1:ping`, agendaId: 'A1', stop: false }]);
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
