import { describe, it } from 'bun:test';
import type { BoardTask, BoardTaskEvent, BoardTaskView, PrLink, QueuedMessage } from '@ferretry/protocol';
import should from 'should';
import {
  applyPrUpdate,
  BoardIndex,
  BoardSweep,
  boardCheckMessage,
  EMPTY_SWEEP_MEMORY,
  planSweep,
  reopenMessage,
  type SweepBoard,
  type SweepMemory,
} from '../../../src/lib/board/index.ts';
import { QueueingSends, type QueueRequest, type SendOutcome } from '../../../src/lib/index.ts';
import { parseSessionId } from '../../../src/lib/session-id.ts';
import { detectOrphanedCards, planOrphanEscalations } from '../../../src/lib/warden/index.ts';
import { boardOf, orphanView } from '../warden/board-fixtures.ts';
import { session, NOW as WARDEN_NOW } from '../warden/sweep-harness.ts';
import { card, FakeSessions, lanes, liveSession, NOW, PROJECT, rosterOf } from './support.ts';

/**
 * THE NO-PREPEND CONTRACT (the owner, 2026-10-30: "there should not be any append or prepend on any
 * feature"). The board and the Warden type into a ferret's chat only what somebody has to act on, as a
 * plain sentence: no `[ferretry]` / `[board]` tag in front, no "No reply needed" footer behind. Who sent it
 * is the queue item's `by`, which the app shows as a sender chip. A card's move or done is news, and news
 * queues nothing: the board shows the state and the card's history keeps it.
 */

const HOUR = 60 * 60_000;
const ago = (ms: number): string => new Date(Date.parse(NOW) - ms).toISOString();
const laneSets = new Map([[PROJECT, lanes(PROJECT)]]);

const view = (stored: Partial<BoardTask> = {}, derived: Partial<BoardTaskView> = {}): BoardTaskView => ({
  ...card(stored),
  lastTouchedAt: null,
  touchedBy: null,
  activity: 'idle',
  rollup: {
    children: 0,
    byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
    active: 0,
    lastTouchedAt: null,
  },
  suggestedLane: null,
  waitingOnOwner: [],
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
  ...derived,
});

const pr = (overrides: Partial<PrLink> = {}): PrLink => ({
  url: 'https://github.com/kirinnee/ferretry/pull/940',
  number: 940,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'pending',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: NOW,
  ...overrides,
});

/** Every message the board and the Warden still send, produced by the code that sends it. */
const keptMessages = (): Readonly<Record<string, string>> => {
  const blocked = view(
    { id: 'F20', assignee: 'child', dependsOn: [{ task: { id: 'F18' }, until: 'shipped' }] },
    { blockedBy: [] },
  );
  const sweep = planSweep(
    { v: 1, sweptAt: ago(HOUR), nudged: {}, seen: { F20: { blockedBy: ['/F18'] } } },
    {
      views: [
        view({ id: 'F18', laneId: 'merged' }),
        blocked,
        view({ id: 'F412', laneId: 'implement' }, { activity: 'stale', lastTouchedAt: ago(3 * HOUR) }),
      ],
      laneSets,
    },
    rosterOf(['lead', 'child'].map(id => liveSession(id))),
    NOW,
  );
  const withPr = card({
    id: 'F1',
    laneId: 'review',
    links: { prs: [pr()], branch: null, commits: [], docs: [] },
  });
  const prNudge = (state: 'open' | 'closed', checks: 'pending' | 'failing') =>
    applyPrUpdate(
      withPr,
      {
        link: [],
        observed: [{ url: pr().url, state, draft: false, checks, mergedAt: null, mergeSha: null }],
        releases: [],
        runningVersion: null,
      },
      {
        now: NOW,
        actor: { kind: 'daemon' },
        standing: 'daemon',
        laneSet: lanes(),
        index: new BoardIndex([withPr], 'machine-1'),
        laneSets,
      },
    ).nudges;
  const prNudges = [...prNudge('closed', 'pending'), ...prNudge('open', 'failing')];
  const orphanBoard = boardOf(orphanView({ title: 'Ship the thing' }));
  const orphanFleet = [session({ id: 'worker', status: 'stopped' }), session({ id: 'lead', status: 'running' })];
  const orphan = planOrphanEscalations({
    orphans: detectOrphanedCards(orphanBoard, orphanFleet, WARDEN_NOW),
    board: orphanBoard,
    fleet: orphanFleet,
    memory: {},
    enabled: true,
    clientName: 'fy',
  }).tell.find(tell => tell.kind === 'message');
  const stale = sweep.nudges.find(nudge => nudge.kind === 'stale');
  const unblocked = sweep.nudges.find(nudge => nudge.kind === 'unblocked');
  if (stale === undefined || unblocked === undefined || orphan?.kind !== 'message' || prNudges.length !== 2) {
    throw new Error('a producer under contract did not produce its message');
  }
  return {
    'board sweep: stale nudge': stale.message,
    'board sweep: go-ahead to the assignee': unblocked.message,
    'board turn-end check': boardCheckMessage('fy'),
    'board reopen (owner)': reopenMessage({ id: 'F412' }, { kind: 'owner' }, 'not good'),
    'board reopen (ferret)': reopenMessage({ id: 'F412' }, { kind: 'ferret', sessionId: 'lead' }, 'not good'),
    'board PR closed unmerged': prNudges.find(nudge => nudge.reason === 'closed-unmerged')?.message ?? '',
    'board PR CI red': prNudges.find(nudge => nudge.reason === 'ci-failing')?.message ?? '',
    'warden orphaned card': orphan.message,
  };
};

describe('what the board and the Warden still type into a chat', () => {
  it('should be plain sentences: no tag in front, no footer behind', () => {
    for (const [producer, message] of Object.entries(keptMessages())) {
      should(message.trimStart().startsWith('[')).be.false(`${producer} starts with a tag: ${message}`);
      should(message).not.match(/\[(?:ferretry|board|warden|agenda)\]/iu, `${producer} carries a tag: ${message}`);
      should(message.includes('No reply needed')).be.false(`${producer} carries a footer: ${message}`);
      should(message.includes('This notice is from Ferretry')).be.false(`${producer} carries a footer: ${message}`);
      should(message.trim()).not.be.empty();
    }
  });

  it('should read as the owner asked for them', () => {
    const messages = keptMessages();

    should(messages['board sweep: stale nudge']).equal(
      '&F412 has had no activity for 3h in Implement. Move it, note why, block it, or drop it.',
    );
    should(messages['board sweep: go-ahead to the assignee']).equal('&F20 can go ahead: &F18 merged.');
    should(messages['warden orphaned card']).startWith('Your card &F1 “Ship the thing” has nobody on it.');
  });
});

describe('board news', () => {
  const ferret = (sessionId: string) => ({ kind: 'ferret' as const, sessionId });
  const at = ago(60_000);
  const moved = (seq: number, from: string, to: string, extra: object = {}): BoardTaskEvent =>
    ({
      seq,
      at,
      actor: ferret('child'),
      type: 'moved',
      from,
      to,
      backward: false,
      reason: null,
      ...extra,
    }) as BoardTaskEvent;

  it('should queue nothing for a move, a done, a block, a drop, a reopen or an ask, to the lead or anyone', async () => {
    // Arrange
    const child = view(
      {
        id: 'F2',
        parent: { id: 'F1' },
        assignee: 'child',
        laneId: 'review',
        history: [
          { seq: 1, at: ago(HOUR), actor: ferret('lead'), type: 'created', laneId: 'todo' },
          moved(2, 'todo', 'implement'),
          { seq: 3, at, actor: ferret('child'), type: 'blocked', reason: 'vendor' },
          { seq: 4, at, actor: ferret('child'), type: 'unblocked', reason: null },
          moved(5, 'implement', 'review', { auto: true, trigger: 'signal.done', reason: 'done: shipped it' }),
          {
            seq: 6,
            at,
            actor: { kind: 'owner' },
            type: 'reopened',
            from: 'review',
            to: 'implement',
            reason: 'not good',
            ask: { text: 'again', source: 'owner' },
          },
          moved(7, 'implement', 'review'),
        ],
      },
      { blockedBy: [{ id: 'F9' }], waitingOnOwner: [{ sessionId: 'child', id: 'A9' }] },
    );
    const dropped = view({ id: 'F3', parent: { id: 'F1' }, dropped: { reason: 'superseded', at } });
    const swept: SweepBoard = { views: [view({ id: 'F1', assignee: 'lead' }), child, dropped], laneSets };
    const memory: SweepMemory = {
      v: 1,
      sweptAt: ago(HOUR),
      nudged: {},
      seen: { F1: { blockedBy: [] }, F2: { blockedBy: [] }, F3: { blockedBy: [] } },
    };
    const sent: string[] = [];
    const sweep = new BoardSweep({
      board: { sweepBoard: async () => swept },
      sessions: new FakeSessions(),
      memory: { read: async () => memory, write: async () => undefined },
      nudges: { send: async (sessionId, message) => void sent.push(`${sessionId}: ${message}`) },
      clock: { now: () => NOW },
      diagnostics: { warn: () => undefined },
    });

    // Act
    const report = await sweep.tick();
    const baseline = planSweep(EMPTY_SWEEP_MEMORY, swept, rosterOf([liveSession('lead')]), NOW);

    // Assert
    should(sent).eql([]);
    should(report).eql({ nudged: [], unblocked: [] });
    should(baseline.nudges).eql([]);
  });
});

describe('who a kept message is from', () => {
  const ID = parseSessionId('session-1');
  const AT = '2026-10-30T16:30:00.000Z';

  const front = (feature: string) => {
    const enqueued: QueueRequest[] = [];
    const sends = new QueueingSends(
      {
        queue: {
          enqueue: async (_id, request) => {
            enqueued.push(request);
            const message: QueuedMessage = {
              v: 1,
              id: request.id,
              sender: request.sender,
              text: request.text,
              attachmentIds: [],
              enqueuedAt: AT,
              state: 'queued',
              stateAt: AT,
              revision: 1,
            };
            return { message, created: true };
          },
        },
        deliverer: { enqueued: async () => undefined },
        direct: { send: async () => ({ disposition: 'delivered' }) as SendOutcome, authorize: async () => undefined },
        target: async () => ({ id: ID, status: 'running', mode: 'auto', turn: 1 }),
        ledger: { list: async () => [] },
        clock: { now: () => AT },
        sleep: async () => undefined,
      },
      'daemon',
      feature,
    );
    return { sends, enqueued };
  };

  it("should carry Ferretry and the feature as the queue item's metadata, and the words untouched", async () => {
    // Arrange
    const messages = keptMessages();
    const board = front('Board');
    const warden = front('Warden');

    // Act
    for (const [producer, message] of Object.entries(messages)) {
      const sends = producer.startsWith('warden') ? warden.sends : board.sends;
      await sends.send({ id: ID, sendId: producer, message });
    }

    // Assert
    should(board.enqueued.length + warden.enqueued.length).equal(Object.keys(messages).length);
    for (const request of board.enqueued) {
      should(request.by).eql({ kind: 'ferretry', feature: 'Board' });
      should(request.text).equal(messages[request.id]);
    }
    should(warden.enqueued).have.length(1);
    should(warden.enqueued[0]?.by).eql({ kind: 'ferretry', feature: 'Warden' });
    should(warden.enqueued[0]?.text).equal(messages['warden orphaned card']);
  });
});
