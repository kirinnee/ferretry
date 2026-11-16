/**
 * WHAT THIS DEVICE HAS DONE TO THE INBOX THAT NO DAEMON HAS HEARD YET (`inbox-local.ts`): each mounted Inbox publishes
 * its hidden keys and its replied overlay, the nav count reads the one merged picture, and an Inbox that leaves
 * withdraws what it published. The merged snapshot keeps its identity until something really changes.
 */
import { describe, expect, it } from 'bun:test';
import type { RepliedEntry, RepliedNotice, RepliedState } from '../../../app/lib/agenda-replied.ts';
import { InboxLocal, type InboxLocalState, inboxLocal } from '../../../app/lib/inbox-local.ts';
import { agendaItem, choices, inboxCard } from '../../support/app/agenda-inbox.tsx';

const cardA = inboxCard(agendaItem('A2', { ask: choices('Ship', 'Hold') }));
const cardB = inboxCard(agendaItem('A3', { ask: choices('Yes', 'No') }));

const entry = (card: typeof cardA): RepliedEntry => ({
  key: card.key,
  card,
  phase: 'replied',
  repliedAt: 1_000,
  waitingSince: '2026-08-01T10:00:00.000Z',
  words: 'on it',
  taken: false,
  undoUntil: 6_000,
  settled: false,
  reveal: false,
});

const noticeFor = (card: typeof cardA): RepliedNotice => ({ key: card.key, card, kind: 'read', until: 9_000 });

const replied = (over: Partial<RepliedState> = {}): RepliedState => ({
  entries: [],
  notice: null,
  restores: [],
  ...over,
});

const state = (hidden: readonly string[], repliedState: RepliedState = replied()): InboxLocalState => ({
  hidden: new Set(hidden),
  replied: repliedState,
});

describe('InboxLocal', () => {
  it('holds nothing until an Inbox publishes, and the same nothing every time it is read', () => {
    const local = new InboxLocal();
    const first = local.getSnapshot();
    expect(first.hidden.size).toBe(0);
    expect(first.replied).toEqual({ entries: [], notice: null, restores: [] });
    expect(local.getSnapshot()).toBe(first);
  });

  it('serves a lone Inbox its own published state, untouched', () => {
    const local = new InboxLocal();
    const owner = {};
    const mine = state([cardA.key], replied({ entries: [entry(cardA)] }));
    local.publish(owner, mine);
    expect(local.getSnapshot()).toBe(mine);
  });

  it('tells its listeners once per change and stops telling one that unsubscribed', () => {
    const local = new InboxLocal();
    const owner = {};
    let heard = 0;
    const unsubscribe = local.subscribe(() => {
      heard += 1;
    });
    local.publish(owner, state([cardA.key]));
    expect(heard).toBe(1);
    local.publish(owner, state([cardB.key]));
    expect(heard).toBe(2);
    unsubscribe();
    local.publish(owner, state([]));
    expect(heard).toBe(2);
  });

  it('keeps the snapshot and says nothing when an Inbox republishes the very same overlay', () => {
    const local = new InboxLocal();
    const owner = {};
    const hidden = new Set([cardA.key]);
    const repliedState = replied({ entries: [entry(cardA)] });
    let heard = 0;
    local.subscribe(() => {
      heard += 1;
    });
    local.publish(owner, { hidden, replied: repliedState });
    const before = local.getSnapshot();
    local.publish(owner, { hidden, replied: repliedState });
    expect(local.getSnapshot()).toBe(before);
    expect(heard).toBe(1);
  });

  it('publishes again when only the hidden set or only the replied overlay is a new one', () => {
    const local = new InboxLocal();
    const owner = {};
    const hidden = new Set([cardA.key]);
    const repliedState = replied();
    local.publish(owner, { hidden, replied: repliedState });
    local.publish(owner, { hidden: new Set([cardA.key]), replied: repliedState });
    expect(local.getSnapshot().hidden).not.toBe(hidden);
    const nextReplied = replied({ entries: [entry(cardB)] });
    local.publish(owner, { hidden: local.getSnapshot().hidden, replied: nextReplied });
    expect(local.getSnapshot().replied).toBe(nextReplied);
  });

  it('says nothing when an owner that published nothing withdraws', () => {
    const local = new InboxLocal();
    let heard = 0;
    local.subscribe(() => {
      heard += 1;
    });
    local.publish({}, null);
    expect(heard).toBe(0);
    expect(local.getSnapshot().hidden.size).toBe(0);
  });

  it('merges two Inboxes: every hidden key, every reply, the first notice, every restore', () => {
    const local = new InboxLocal();
    const one = {};
    const two = {};
    const noticeOne = noticeFor(cardA);
    local.publish(
      one,
      state([cardA.key], replied({ entries: [entry(cardA)], restores: [{ key: cardA.key, text: 'a' }] })),
    );
    local.publish(
      two,
      state(
        [cardB.key],
        replied({ entries: [entry(cardB)], notice: noticeOne, restores: [{ key: cardB.key, text: 'b' }] }),
      ),
    );
    const merged = local.getSnapshot();
    expect([...merged.hidden].sort()).toEqual([cardA.key, cardB.key].sort());
    expect(merged.replied.entries.map(each => each.key)).toEqual([cardA.key, cardB.key]);
    expect(merged.replied.notice).toBe(noticeOne);
    expect(merged.replied.restores).toEqual([
      { key: cardA.key, text: 'a' },
      { key: cardB.key, text: 'b' },
    ]);
  });

  it('merges to no notice when no Inbox holds one', () => {
    const local = new InboxLocal();
    local.publish({}, state([cardA.key]));
    local.publish({}, state([cardB.key]));
    expect(local.getSnapshot().replied.notice).toBeNull();
  });

  it('drops what an Inbox published when it withdraws, back to the lone one and then to nothing', () => {
    const local = new InboxLocal();
    const one = {};
    const two = {};
    const stateOne = state([cardA.key]);
    let heard = 0;
    local.subscribe(() => {
      heard += 1;
    });
    local.publish(one, stateOne);
    local.publish(two, state([cardB.key]));
    expect(local.getSnapshot().hidden.size).toBe(2);
    local.publish(two, null);
    expect(local.getSnapshot()).toBe(stateOne);
    local.publish(one, null);
    expect(local.getSnapshot().hidden.size).toBe(0);
    expect(local.getSnapshot().replied.entries).toEqual([]);
    expect(heard).toBe(4);
  });

  it('lets a listener unsubscribe while it is being told without skipping the others', () => {
    const local = new InboxLocal();
    const heard: string[] = [];
    const stop = local.subscribe(() => {
      heard.push('first');
      stop();
    });
    local.subscribe(() => heard.push('second'));
    local.publish({}, state([cardA.key]));
    local.publish({}, state([cardB.key]));
    expect(heard).toEqual(['first', 'second', 'second']);
  });
});

describe('inboxLocal', () => {
  it("is the app's one, starting empty", () => {
    expect(inboxLocal).toBeInstanceOf(InboxLocal);
    expect(inboxLocal.getSnapshot().hidden.size).toBe(0);
  });
});
