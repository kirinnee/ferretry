import { describe, expect, test } from 'bun:test';
import type { AttentionItem, AttentionSnapshot, SessionAttentionSummary } from '@ferretry/protocol';
import {
  actionSentence,
  attentionConversationPath,
  attentionFirst,
  attentionSummaryKey,
  attentionTargetFromSearch,
  badgeText,
  DeferredAttentionActions,
  type DeferredTimers,
  DISMISS_ACTION,
  DONE_ACTION,
  directionOfAction,
  type InboxCard,
  inboxCardKey,
  inboxCards,
  inboxOptions,
  replyAction,
  SWIPE_SLOP_PX,
  swipeIntent,
  swipeMap,
  swipeThreshold,
  UNDO_WINDOW_MS,
  unreadCount,
  unreadSessions,
  unreadTotal,
} from '../../src/lib/attention-inbox.ts';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { sessionView } from '../support/sessions.ts';

const STUDIO = 'studio' as DaemonId;
const LAPTOP = 'laptop' as DaemonId;
const at = (minutes: number): string => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();

const summary = (open: number, latest: number, first = 'A1'): SessionAttentionSummary => ({
  open,
  first,
  ask: 'Rebase now?',
  latestAt: at(latest),
});

const waiting = (id: string, attention?: SessionAttentionSummary) =>
  sessionView(id, attention === undefined ? {} : { state: { attention } });

const item = (id: string, minutes: number, ask?: AttentionItem['ask']): AttentionItem =>
  ({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Because.',
    waitingSince: at(minutes),
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'x',
    raisedByName: null,
    ...(ask === undefined ? {} : { ask }),
  }) as AttentionItem;

const board = (sessionId: string, items: readonly AttentionItem[]): AttentionSnapshot => ({
  v: 1,
  sessionId,
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: at(0),
});

const choice = (...labels: string[]): AttentionItem['ask'] => ({
  kind: 'multiple-choice',
  options: labels.map(label => ({ label })),
});

describe('unread conversations', () => {
  test('lists only sessions with open Attention, newest latestAt first, across machines', () => {
    const entries = unreadSessions([
      { daemonId: STUDIO, name: 'Studio', sessions: [waiting('a', summary(1, 5)), waiting('quiet')] },
      { daemonId: LAPTOP, name: 'Laptop', sessions: [waiting('b', summary(2, 9))] },
      { daemonId: 'unread' as DaemonId, name: 'Unread', sessions: null },
    ]);
    expect(entries.map(entry => [entry.daemonId, entry.view.config.id, entry.machineName])).toEqual([
      [LAPTOP, 'b', 'Laptop'],
      [STUDIO, 'a', 'Studio'],
    ]);
    expect(unreadTotal(entries)).toBe(3);
  });

  test('equal instants keep machine order, then session id', () => {
    const entries = unreadSessions([
      { daemonId: STUDIO, name: 'Studio', sessions: [waiting('z', summary(1, 1)), waiting('m', summary(1, 1))] },
      { daemonId: LAPTOP, name: 'Laptop', sessions: [waiting('a', summary(1, 1))] },
    ]);
    expect(entries.map(entry => entry.view.config.id)).toEqual(['m', 'z', 'a']);
  });

  test('badges cap and count from the summary alone', () => {
    expect(unreadCount(waiting('a', summary(4, 1)))).toBe(4);
    expect(unreadCount(waiting('a'))).toBe(0);
    expect(badgeText(7)).toBe('7');
    expect(badgeText(100)).toBe('99+');
  });

  test('attentionFirst lifts unread rows newest first and keeps the rest in order', () => {
    const rows = [waiting('x'), waiting('old', summary(1, 1)), waiting('y'), waiting('new', summary(1, 8))];
    expect(attentionFirst(rows, view => view).map(view => view.config.id)).toEqual(['new', 'old', 'x', 'y']);
    const none = [waiting('x'), waiting('y')];
    expect(attentionFirst(none, view => view)).toBe(none);
  });

  test('a summary key moves with any of its facts', () => {
    expect(attentionSummaryKey(summary(1, 1))).not.toBe(attentionSummaryKey(summary(2, 1)));
    expect(attentionSummaryKey(summary(1, 1))).not.toBe(attentionSummaryKey(summary(1, 2)));
    expect(attentionSummaryKey(summary(1, 1, 'A1'))).not.toBe(attentionSummaryKey(summary(1, 1, 'A2')));
    expect(attentionSummaryKey(summary(1, 1))).toBe(attentionSummaryKey(summary(1, 1)));
  });
});

describe('conversation links', () => {
  test('a conversation opens at an item through the protocol parameter', () => {
    expect(attentionConversationPath(STUDIO, 'ses 1', 'A3')).toBe('/d/studio/session/ses%201?attention=A3');
  });

  test('reads a well-formed item id and refuses anything else', () => {
    expect(attentionTargetFromSearch('?attention=A3')).toBe('A3');
    expect(attentionTargetFromSearch('?attention=a3')).toBeNull();
    expect(attentionTargetFromSearch('?attention=A0')).toBeNull();
    expect(attentionTargetFromSearch('')).toBeNull();
  });
});

describe('inbox cards', () => {
  const entries = unreadSessions([
    { daemonId: STUDIO, name: 'Studio', sessions: [waiting('s', summary(2, 9))] },
    { daemonId: LAPTOP, name: 'Laptop', sessions: [waiting('s', summary(1, 4)), waiting('unread', summary(1, 1))] },
  ]);
  const boards = new Map([
    [`${STUDIO}/s`, board('s', [item('A1', 2), item('A2', 9)])],
    [`${LAPTOP}/s`, board('s', [item('A1', 4)])],
  ]);
  const boardFor = (daemonId: DaemonId, sessionId: string) => boards.get(`${daemonId}/${sessionId}`);

  test('deals every read item newest first, keyed per machine, skipping unread boards', () => {
    const cards = inboxCards(entries, boardFor);
    expect(cards.map(card => [card.daemonId, card.item.id])).toEqual([
      [STUDIO, 'A2'],
      [LAPTOP, 'A1'],
      [STUDIO, 'A1'],
    ]);
    expect(new Set(cards.map(card => card.key)).size).toBe(3);
  });

  test('hides the cards the reader already answered', () => {
    const hidden = new Set([inboxCardKey(STUDIO, 's', 'A2')]);
    expect(inboxCards(entries, boardFor, hidden).map(card => card.item.id)).toEqual(['A1', 'A1']);
  });
});

describe('swipes', () => {
  test('every card swipes right to Done and left to Dismiss — never between its options', () => {
    for (const ask of [
      undefined,
      { kind: 'open-question' } as const,
      { kind: 'permission' } as const,
      choice('A', 'B', 'C', 'D'),
    ]) {
      const map = swipeMap({ ask });
      expect(map.right).toBe(DONE_ACTION);
      expect(map.left).toBe(DISMISS_ACTION);
      expect(map.up).toBeUndefined();
    }
  });

  test('only a clear distance commits, and only toward a mapped direction', () => {
    const width = 360;
    const threshold = swipeThreshold(width);
    const two = swipeMap({ ask: choice('Yes', 'No') });
    expect(swipeIntent(SWIPE_SLOP_PX - 1, 0, width, two)).toEqual({ direction: null, progress: 0, committed: false });
    expect(swipeIntent(threshold - 1, 0, width, two)).toMatchObject({ direction: 'right', committed: false });
    expect(swipeIntent(threshold, 4, width, two)).toMatchObject({ direction: 'right', progress: 1, committed: true });
    expect(swipeIntent(-threshold, 0, width, two)).toMatchObject({ direction: 'left', committed: true });
    // Up has no action on a two-option card, so it never commits; down means nothing at all.
    expect(swipeIntent(0, -threshold * 2, width, two)).toMatchObject({ direction: 'up', committed: false });
    expect(swipeIntent(0, threshold * 2, width, two).committed).toBe(false);
  });

  test('the threshold is bounded for narrow and wide cards', () => {
    expect(swipeThreshold(100)).toBe(96);
    expect(swipeThreshold(2_000)).toBe(160);
  });

  test('finds the swipe an answer sits on by meaning, not by identity', () => {
    const map = swipeMap({});
    expect(directionOfAction(map, { ...DONE_ACTION })).toBe('right');
    expect(directionOfAction(map, { ...DISMISS_ACTION })).toBe('left');
    expect(directionOfAction(map, inboxOptions({ ask: choice('Rebase now', 'Wait') })[0] ?? DONE_ACTION)).toBeNull();
  });

  test('options follow the swipe order', () => {
    expect(inboxOptions({ ask: { kind: 'permission' } }).map(option => option.label)).toEqual(['Approve', 'Reject']);
    expect(inboxOptions({})).toEqual([]);
  });
});

describe('replies', () => {
  test('an open question takes the text as its answer', () => {
    expect(replyAction({ ask: { kind: 'open-question' } }, '  ship it ')).toMatchObject({
      kind: 'respond',
      response: { kind: 'open-question', answer: 'ship it' },
    });
  });

  test('a review takes it as the clarification, every other kind as a Done note', () => {
    expect(replyAction({ ask: { kind: 'answer-review' } }, 'why?')).toMatchObject({
      response: { kind: 'answer-review', verdict: 'clarify', clarification: 'why?' },
    });
    expect(replyAction({ ask: choice('A', 'B') }, 'neither')).toEqual({
      kind: 'resolve',
      label: 'Reply',
      note: 'neither',
    });
    expect(replyAction({}, '   ')).toBeNull();
  });

  test('says what it is holding', () => {
    expect(actionSentence(DISMISS_ACTION, 'A3')).toBe('Dismissed !A3');
    expect(actionSentence(DONE_ACTION, 'A3')).toBe('Marked !A3 done');
    expect(actionSentence({ kind: 'resolve', label: 'Reply', note: 'x' }, 'A3')).toBe('Replied to !A3');
    expect(actionSentence(inboxOptions({ ask: choice('Wait', 'Go') })[0] ?? DONE_ACTION, 'A3')).toBe(
      'Answered !A3: Wait',
    );
  });
});

describe('the undo window', () => {
  const fakeTimers = () => {
    let clock = 0;
    const queue = new Map<number, { at: number; run: () => void }>();
    let next = 0;
    const timers: DeferredTimers = {
      setTimeout: (run, milliseconds) => {
        next += 1;
        queue.set(next, { at: clock + milliseconds, run });
        return next;
      },
      clearTimeout: handle => queue.delete(handle as number),
      now: () => clock,
    };
    const advance = (milliseconds: number): void => {
      clock += milliseconds;
      for (const [handle, timer] of [...queue]) {
        if (timer.at <= clock) {
          queue.delete(handle);
          timer.run();
        }
      }
    };
    return { timers, advance };
  };
  const card = (id: string): InboxCard => ({
    key: inboxCardKey(STUDIO, 's', id),
    daemonId: STUDIO,
    machineName: 'Studio',
    view: waiting('s'),
    item: item(id, 1),
  });
  const settled = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  test('posts nothing until the window closes, then exactly once', async () => {
    const { timers, advance } = fakeTimers();
    const sent: string[] = [];
    const deferred = new DeferredAttentionActions(async (target, action) => {
      sent.push(`${target.item.id}:${action.label}`);
    }, timers);
    deferred.schedule(card('A1'), DONE_ACTION);
    expect(deferred.hiddenKeys().has(card('A1').key)).toBe(true);
    expect(deferred.getSnapshot().pending[0]?.deadline).toBe(UNDO_WINDOW_MS);
    advance(UNDO_WINDOW_MS - 1);
    expect(sent).toEqual([]);
    advance(1);
    expect(sent).toEqual(['A1:Done']);
    expect(deferred.getSnapshot().sending).toEqual([card('A1').key]);
    await settled();
    expect(deferred.getSnapshot()).toEqual({ pending: [], sending: [], failed: [] });
  });

  test('undo takes back the latest answer and nothing is ever posted for it', () => {
    const { timers, advance } = fakeTimers();
    const sent: string[] = [];
    const deferred = new DeferredAttentionActions(async target => {
      sent.push(target.item.id);
    }, timers);
    deferred.schedule(card('A1'), DONE_ACTION);
    deferred.schedule(card('A2'), DISMISS_ACTION);
    expect(deferred.undo()?.card.item.id).toBe('A2');
    expect(deferred.hiddenKeys().has(card('A2').key)).toBe(false);
    advance(UNDO_WINDOW_MS);
    expect(sent).toEqual(['A1']);
    expect(deferred.undo()).toBeNull();
  });

  test('answering the same card again replaces what was held', () => {
    const { timers, advance } = fakeTimers();
    const sent: string[] = [];
    const deferred = new DeferredAttentionActions(async (_target, action) => {
      sent.push(action.label);
    }, timers);
    deferred.schedule(card('A1'), DONE_ACTION);
    advance(3_000);
    deferred.schedule(card('A1'), DISMISS_ACTION);
    advance(3_000);
    expect(sent).toEqual([]);
    advance(2_000);
    expect(sent).toEqual(['Dismiss']);
  });

  test('flush sends everything held at once', () => {
    const { timers } = fakeTimers();
    const sent: string[] = [];
    const deferred = new DeferredAttentionActions(async target => {
      sent.push(target.item.id);
    }, timers);
    deferred.schedule(card('A1'), DONE_ACTION);
    deferred.schedule(card('A2'), DONE_ACTION);
    deferred.flush();
    expect(sent).toEqual(['A1', 'A2']);
  });

  test('a refused answer brings the card back with the reason', async () => {
    const { timers, advance } = fakeTimers();
    const deferred = new DeferredAttentionActions(async () => {
      throw new Error('forbidden');
    }, timers);
    deferred.schedule(card('A1'), DONE_ACTION);
    advance(UNDO_WINDOW_MS);
    await settled();
    expect(deferred.getSnapshot().failed).toMatchObject([{ key: card('A1').key, message: 'forbidden' }]);
    expect(deferred.hiddenKeys().size).toBe(0);
    deferred.schedule(card('A1'), DONE_ACTION);
    expect(deferred.getSnapshot().failed).toEqual([]);
    deferred.clearFailure(card('A1').key);
  });
});
