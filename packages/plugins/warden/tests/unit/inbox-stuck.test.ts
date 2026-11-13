import { describe, it } from 'bun:test';
import type { QueuedMessage } from '../../daemon/lib/protocol.ts';
import should from 'should';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import {
  detectInboxStuck,
  INBOX_STUCK_HORIZON_MS,
  INBOX_STALE_QUEUE_MS,
  INBOX_STUCK_LIMITS_MS,
  type InboxSend,
  inboxDueMs,
  inboxExpired,
  inboxStuckAnomaly,
  inboxStuckCandidates,
  inboxStuckForInvestigation,
  inboxStuckNoticeLine,
  inboxStuckOf,
  inboxUrgency,
  planInboxStuck,
  unstickActs,
  type WardenSessionView,
} from '../../daemon/lib/index.ts';

/**
 * A ferret whose messages wait in Ferretry's own queue far past due — ryu's eleven stalls and elta's draft wait
 * of 2026-11-02 to 11-04, read from the same facts the Warden reads: the session's queue and its send ledger.
 */

const NOW = Date.parse('2026-11-02T14:00:00.000Z');
const MINUTE = 60_000;
const iso = (ms: number): Instant => instantFromEpochMs(ms);

const ferret = (
  id: string,
  state: Partial<WardenSessionView['state']> = {},
  config: Partial<WardenSessionView['config']> = {},
): WardenSessionView => ({
  config: { id, mode: 'auto', teammate: id, ...config },
  state: { status: 'running', ...state },
  hasLiveMonitor: true,
});

/** A message as the queue's fold answers it, accepted `agoMin` minutes before now. */
const message = (id: string, agoMin: number, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
  v: 1,
  id,
  sender: 'agent',
  from: 'mvg65xrd-7836f69d',
  fromName: 'jaeda',
  text: `message ${id}`,
  attachmentIds: [],
  enqueuedAt: iso(NOW - agoMin * MINUTE),
  state: 'queued',
  stateAt: iso(NOW - agoMin * MINUTE),
  revision: 1,
  ...over,
});

const send = (sendId: string, over: Partial<InboxSend> = {}): InboxSend => ({
  sendId,
  path: 'turn-file',
  fate: 'accepted',
  ...over,
});

/**
 * ryu at 11-02 08:12: in a declared wait (status `waiting`, no turn state), maryjane's message handed to the send
 * path — `typing` — whose ledger row is `accepted` with nothing typed; four messages and a wake behind it.
 */
const ryu = ferret('ryu', { status: 'waiting' });
const ryuQueue = (agoMin: number): readonly QueuedMessage[] => [
  message('read-before', agoMin + 5, { state: 'read' }),
  message('8e8d7aaf', agoMin, { fromName: 'maryjane', state: 'typing', stateAt: iso(NOW - agoMin * MINUTE) }),
  message('622a6e69', agoMin - 2, { fromName: 'maryjane' }),
  message('9d86f78a', agoMin - 5, { fromName: 'sarina' }),
  message('wake', agoMin - 10, { sender: 'daemon', from: undefined, fromName: undefined }),
];
const ryuSends = [send('read-before', { fate: 'delivered' }), send('8e8d7aaf')];

describe('inbox_stuck: what is undelivered, and when it is stuck', () => {
  it('should flag ryu: a hung hand-over in a declared wait, the oldest message, the count and the send in the way', () => {
    const flag = inboxStuckOf(ryu, ryuQueue(30), ryuSends, NOW);

    should(flag?.kind).equal('inbox_stuck');
    should(flag?.cause).equal('hung_handover');
    should(flag?.messageId).equal('8e8d7aaf');
    should(flag?.blockingSendId).equal('8e8d7aaf');
    should(flag?.waiting).equal(4);
    should(flag?.idleMinutes).equal(30);
    should(flag?.since).equal(iso(NOW - 30 * MINUTE));
    should(flag?.subject).equal('inbox:ryu:8e8d7aaf');
    should(flag?.status).equal('waiting');
    should(flag?.detail).match(/^4 messages undelivered .* oldest \(action from maryjane\) has waited 30m past due/);
    should(flag?.detail).match(/never typed and nothing is watching it/);
  });

  it('should wait each urgency out: 10 minutes for a blocker or a person, 20 for an action or the daemon, 45 for an FYI', () => {
    const view = ferret('f');
    const at = (minutes: number, over: Partial<QueuedMessage>) =>
      inboxStuckOf(view, [message('m', minutes, over)], [], NOW)?.messageId;

    should(INBOX_STUCK_LIMITS_MS).eql({ blocker: 10 * MINUTE, action: 20 * MINUTE, fyi: 45 * MINUTE });
    should(at(9, { label: 'blocker' })).be.undefined();
    should(at(10, { label: 'blocker' })).equal('m');
    should(at(10, { sender: 'human', from: undefined })).equal('m');
    should(at(10, { replyExpected: true })).equal('m');
    should(at(10, { interrupt: true })).equal('m');
    should(at(19, {})).be.undefined();
    should(at(20, {})).equal('m');
    should(at(20, { sender: 'daemon' })).equal('m');
    should(at(44, { label: 'fyi' })).be.undefined();
    should(at(45, { label: 'fyi' })).equal('m');
  });

  it('should count a held message from the end of its hold, and a blocker from its arrival whatever its hold', () => {
    const held = message('m', 25, { holdUntil: iso(NOW - 10 * MINUTE) });

    should(inboxDueMs(held)).equal(NOW - 10 * MINUTE);
    should(inboxStuckOf(ferret('f'), [held], [], NOW)).be.undefined();
    should(inboxDueMs({ ...held, label: 'blocker' })).equal(NOW - 25 * MINUTE);
    should(inboxStuckOf(ferret('f'), [held], [], NOW + 10 * MINUTE)?.idleMinutes).equal(20);
  });

  it('should say who the oldest message is from: a person, Ferretry, a named ferret or an unnamed one', () => {
    const from = (over: Partial<QueuedMessage>) => inboxStuckOf(ferret('f'), [message('m', 30, over)], [], NOW)?.detail;

    should(from({ sender: 'human', from: undefined, fromName: undefined })).match(/\(blocker from you\)/);
    should(from({ sender: 'daemon', from: undefined, fromName: undefined })).match(/\(action from Ferretry\)/);
    should(from({})).match(/\(action from jaeda\)/);
    should(from({ fromName: undefined })).match(/\(action from a ferret\)/);
  });

  it('should read a message’s urgency as the queue does', () => {
    should(inboxUrgency(message('m', 1, { label: 'fyi' }))).equal('fyi');
    should(inboxUrgency(message('m', 1, { label: 'action' }))).equal('action');
    should(inboxUrgency(message('m', 1))).equal('action');
    should(inboxUrgency(message('m', 1, { sender: 'daemon', label: 'fyi' }))).equal('action');
    should(inboxUrgency(message('m', 1, { sender: 'human' }))).equal('blocker');
  });

  it('should leave out what the queue holds on purpose: an FYI to a stopped ferret, and a question waiting on its answer', () => {
    const stopped = ferret('f', { status: 'completed' });
    const fyi = message('fyi', 120, { label: 'fyi', waitReason: 'stopped' });

    should(inboxStuckOf(stopped, [fyi], [], NOW)).be.undefined();
    should(inboxStuckOf(stopped, [{ ...fyi, waitReason: undefined }], [], NOW)).be.undefined();
    should(inboxStuckOf(ferret('f'), [fyi], [], NOW)).be.undefined();
    should(inboxStuckOf(ferret('f'), [message('q', 120, { waitReason: 'question' })], [], NOW)).be.undefined();
    // An action to a stopped ferret should have revived it.
    should(inboxStuckOf(stopped, [message('act', 30)], [], NOW)?.cause).equal('no_reason');
  });

  it('should never count a message that has left the queue, or one so old it is wreckage', () => {
    const gone = (['delivered', 'unconfirmed', 'read', 'cancelled', 'failed'] as const).map(state =>
      message(state, 120, { state }),
    );
    const ancient = message('ancient', INBOX_STUCK_HORIZON_MS / MINUTE + 1);

    should(inboxStuckOf(ferret('f'), gone, [], NOW)).be.undefined();
    should(inboxStuckOf(ferret('f'), [ancient], [], NOW)).be.undefined();
  });

  it('should name elta’s cause: a draft wait that names no send of ours', () => {
    const elta = ferret('elta', { status: 'running', turnState: 'your-turn' });
    const queue = Array.from({ length: 28 }, (_, index) => message(`m${index}`, 300 - index, { waitReason: 'draft' }));
    const flag = inboxStuckOf(elta, queue, [send('22e0c438', { path: 'direct', fate: 'unaccounted' })], NOW);

    should(flag?.cause).equal('draft_unattributed');
    should(flag?.waiting).equal(28);
    should(flag?.messageId).equal('m0');
    should(flag).not.have.property('blockingSendId');
  });

  it('should name the send of ours the box holds, from the wait or from a typing message the tracker sees typed', () => {
    const behind = message('m', 30, { waitReason: 'draft', waitBehind: 'send-63' });
    const typing = message('t', 30, { state: 'typing' });

    should(inboxStuckOf(ferret('f'), [behind], [], NOW)).match({ cause: 'draft_own', blockingSendId: 'send-63' });
    should(inboxStuckOf(ferret('f'), [typing], [send('t', { typedNotSent: true })], NOW)).match({
      cause: 'draft_own',
      blockingSendId: 't',
    });
  });

  it('should name a person’s send the screen would not let be typed as an unreadable screen, not a hung hand-over', () => {
    const typing = message('t', 30, { sender: 'human', from: undefined, state: 'typing' });

    should(inboxStuckOf(ferret('f'), [typing], [send('t', { untyped: true })], NOW)).match({
      cause: 'unreadable',
      blockingSendId: 't',
    });
  });

  it('should name a send held for a refused revive, found by the id a combined turn was sent under', () => {
    const member = message('m2', 30, { state: 'typing', deliveredAs: 'm1' });
    const lead = message('m1', 31, { state: 'typing', deliveredAs: 'm1' });
    const flag = inboxStuckOf(ferret('f'), [lead, member], [send('m1', { path: 'revive-queue', held: true })], NOW);

    should(flag).match({ cause: 'held_for_revive', blockingSendId: 'm1', messageId: 'm1', waiting: 2 });
  });

  it('should carry the queue’s own long wait as the cause: a dialog, an unreadable screen, a launch', () => {
    for (const reason of ['dialog', 'unreadable', 'launching'] as const)
      should(inboxStuckOf(ferret('f'), [message('m', 30, { waitReason: reason })], [], NOW)?.cause).equal(reason);
  });

  it('should leave the Warden’s own fields off the anomaly every other surface reads', () => {
    const flag = inboxStuckOf(ryu, ryuQueue(30), ryuSends, NOW);
    const anomaly = flag === undefined ? undefined : inboxStuckAnomaly(flag);

    should(anomaly).not.have.properties(['messageId', 'cause', 'waiting', 'blockingSendId']);
    should(anomaly).match({ kind: 'inbox_stuck', sessionId: 'ryu', subject: 'inbox:ryu:8e8d7aaf' });
  });
});

describe('inbox_stuck: which ferrets are read', () => {
  it('should read every autonomous ferret whatever its status, never an interactive one or a warden', () => {
    const fleet = [
      ferret('parked', { status: 'waiting' }),
      ferret('done', { status: 'completed' }),
      ferret('mine', {}, { mode: 'interactive' }),
      ferret('warden', {}, { label: 'fleet-warden' }),
      ferret('child', {}, { parent: 'warden' }),
    ];

    should(inboxStuckCandidates(fleet).map(view => view.config.id)).eql(['parked', 'done']);
  });

  it('should flag only the candidates whose queue and ledger could both be read', () => {
    const queues = new Map([
      ['ryu', ryuQueue(30)],
      ['unread-ledger', ryuQueue(30)],
    ]);
    const ledgers = new Map([['ryu', ryuSends]]);
    const found = detectInboxStuck([ryu, ferret('unread-ledger'), ferret('unread-queue')], queues, ledgers, NOW);

    should(found.flags.map(flag => flag.sessionId)).eql(['ryu']);
    should(found.expired).be.empty();
  });

  it('should tell an inbox past the horizon from a drained one', () => {
    const view = ferret('old');
    const ancient = [message('m', INBOX_STUCK_HORIZON_MS / MINUTE + 1)];

    should(inboxExpired(view, ancient, NOW)).be.true();
    should(inboxExpired(view, [message('m', 30)], NOW)).be.false();
    should(inboxExpired(view, [message('m', INBOX_STUCK_HORIZON_MS / MINUTE + 1, { state: 'read' })], NOW)).be.false();
    should(detectInboxStuck([view], new Map([['old', ancient]]), new Map([['old', []]]), NOW)).eql({
      flags: [],
      expired: ['old'],
    });
    // The horizon, plus the longest a message may be held to combine (`fyiMaxHoldMs` at most a day).
    should(INBOX_STALE_QUEUE_MS).equal(INBOX_STUCK_HORIZON_MS + 24 * 60 * MINUTE);
  });
});

describe('inbox_stuck: what the Warden does', () => {
  it('should re-check a hung hand-over with the tracker’s look, an unattributed draft with the verified finish too', () => {
    should(unstickActs('hung_handover')).eql(['tracker_look', 'delivery_look']);
    should(unstickActs('unreadable')).eql(['tracker_look', 'delivery_look']);
    should(unstickActs('draft_unattributed')).eql(['tracker_look', 'finish_own_draft', 'delivery_look']);
    should(unstickActs('draft_own')).eql(['finish_own_draft', 'delivery_look']);
    for (const cause of ['held_for_revive', 'dialog', 'launching', 'no_reason'] as const)
      should(unstickActs(cause)).eql(['delivery_look']);
  });

  it('should re-check a new episode once, notice it a sweep later, and re-check again only for a new oldest message', () => {
    const stuck = [{ sessionId: 'ryu', messageId: '8e8d7aaf', cause: 'hung_handover' as const }];

    should(planInboxStuck({ stuck, memory: {}, enabled: true }).steps).eql([
      { kind: 'unstick', sessionId: 'ryu', messageId: '8e8d7aaf', cause: 'hung_handover' },
    ]);
    const rechecked = { ryu: { messageId: '8e8d7aaf', cause: 'hung_handover' as const, unstuckAt: iso(NOW) } };
    should(planInboxStuck({ stuck, memory: rechecked, enabled: true }).steps).eql([
      { kind: 'notice', sessionId: 'ryu', messageId: '8e8d7aaf' },
    ]);
    const noticed = { ryu: { ...rechecked.ryu, noticedAt: iso(NOW) } };
    should(planInboxStuck({ stuck, memory: noticed, enabled: true }).steps).be.empty();
    const moved = [{ sessionId: 'ryu', messageId: '622a6e69', cause: 'hung_handover' as const }];
    should(planInboxStuck({ stuck: moved, memory: noticed, enabled: true }).steps).eql([
      { kind: 'unstick', sessionId: 'ryu', messageId: '622a6e69', cause: 'hung_handover' },
    ]);
  });

  it('should take a drained ferret off, even while the Warden is off, and do nothing else while it is off', () => {
    const memory = { ryu: { messageId: 'm', cause: 'hung_handover' as const, noticedAt: iso(NOW) } };
    const stuck = [{ sessionId: 'elta', messageId: 'm0', cause: 'draft_unattributed' as const }];

    should(planInboxStuck({ stuck, memory, enabled: false })).eql({ steps: [], recovered: ['ryu'] });
    // A queue that could not be read proves nothing: the ferret stays as it stands.
    should(planInboxStuck({ stuck, memory, enabled: true, unread: new Set(['ryu']) }).recovered).be.empty();
  });

  it('should hand to an investigation only a ferret already on the notice for this episode, as its own assignment', () => {
    const flag = inboxStuckOf(ryu, ryuQueue(30), ryuSends, NOW);
    const flags = flag === undefined ? [] : [flag];
    const noticed = { ryu: { messageId: '8e8d7aaf', cause: 'hung_handover' as const, noticedAt: iso(NOW) } };

    should(inboxStuckForInvestigation(flags, {})).be.empty();
    should(inboxStuckForInvestigation(flags, { ryu: { messageId: '8e8d7aaf', cause: 'hung_handover' } })).be.empty();
    should(inboxStuckForInvestigation(flags, { ryu: { ...noticed.ryu, messageId: 'older' } })).be.empty();
    should(inboxStuckForInvestigation(flags, { ryu: { ...noticed.ryu, investigatedAt: iso(NOW) } })).be.empty();
    const handed = inboxStuckForInvestigation(flags, noticed);
    should(handed).have.length(1);
    should(handed[0]).match({ kind: 'inbox_stuck', sessionId: 'ryu', assignedWarden: true });
    should(handed[0]).not.have.property('cause');
  });

  it('should write one plain notice line: who, how many, how long, why, and the send in the way', () => {
    const flag = inboxStuckOf(ryu, ryuQueue(30), ryuSends, NOW);

    should(flag === undefined ? '' : inboxStuckNoticeLine(flag)).equal(
      'ryu (ryu): 4 messages waiting, oldest 30m past due — a message handed to the send path was never typed and nothing is watching it (send 8e8d7aaf); the safe re-check did not move it',
    );
  });
});

describe('B187 a queue behind a working turn that never ends', () => {
  const working = (quietMin: number | undefined): WardenSessionView =>
    ferret('nelly', {
      turnState: 'working',
      turnStateAt: iso(NOW - 50 * MINUTE),
      ...(quietMin === undefined ? {} : { frameQuietSince: iso(NOW - quietMin * MINUTE) }),
    });

  it('B187 a queue behind a working turn with a quiet frame is flagged turn_never_ends', () => {
    const queued = [message('m1', 30)];
    const flag = inboxStuckOf(working(25), queued, [], NOW);

    should(flag).match({ cause: 'turn_never_ends', messageId: 'm1', waiting: 1 });
    should(flag?.detail).match(/screen has not changed/);
    // Named in place of an unattributed draft too, and acted on with a tracker look then a delivery look.
    should(inboxStuckOf(working(25), [message('m1', 30, { waitReason: 'draft' })], [], NOW)?.cause).equal(
      'turn_never_ends',
    );
    should(unstickActs('turn_never_ends')).eql(['tracker_look', 'delivery_look']);
    // A draft of ours or a dialog is still named for what it is.
    should(
      inboxStuckOf(working(25), [message('m1', 30, { waitReason: 'draft', waitBehind: 's1' })], [], NOW)?.cause,
    ).equal('draft_own');
    should(inboxStuckOf(working(25), [message('m1', 30, { waitReason: 'dialog' })], [], NOW)?.cause).equal('dialog');
  });

  it('B187 a queue behind a working turn whose frame moves is not flagged turn_never_ends', () => {
    const queued = [message('m1', 30)];

    // Moved within the urgency limit (an action's is 20 m), no frame fact at all, or not working: no new cause.
    should(inboxStuckOf(working(5), queued, [], NOW)?.cause).equal('no_reason');
    should(inboxStuckOf(working(undefined), queued, [], NOW)?.cause).equal('no_reason');
    should(
      inboxStuckOf(
        ferret('nelly', { turnState: 'your-turn', frameQuietSince: iso(NOW - 25 * MINUTE) }),
        queued,
        [],
        NOW,
      )?.cause,
    ).equal('no_reason');
    should(
      inboxStuckOf(ferret('nelly', { turnState: 'working', frameQuietSince: 'not a date' }), queued, [], NOW)?.cause,
    ).equal('no_reason');
  });
});
