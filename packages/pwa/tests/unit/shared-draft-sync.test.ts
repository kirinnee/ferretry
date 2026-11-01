import { describe, expect, test } from 'bun:test';
import {
  applyTextOp,
  composeTextOps,
  diffToTextOp,
  normalizeTextOp,
  SHARED_DRAFT_EDIT_BUDGET,
  sharedDraftFrameBytes,
  type SharedDraftClientFrame,
  type SharedDraftServerFrame,
  type TextOp,
  transformTextOps,
} from '@ferretry/protocol';
import {
  applyDisconnect,
  applyLocalText,
  applyResync,
  splitTextOp,
  applyServerFrame,
  initialSharedDraftState,
  type SharedDraftSyncState,
} from '../../src/lib/shared-draft-sync.ts';

const G = 'gen-1';
const AT = '2026-11-01T00:00:00.000Z';

const counter = (prefix: string) => {
  let next = 0;
  return () => `${prefix}${++next}`;
};

const snapshot = (text: string, rev = 0, epoch = 0): SharedDraftServerFrame => ({
  kind: 'snapshot',
  snapshot: { v: 1, sessionId: 's1', generation: G, epoch, rev, text, items: [], updatedAt: AT },
});

const applied = (text: TextOp, rev: number, epoch = 0) => ({
  generation: G,
  epoch,
  rev,
  text,
  add: [],
  remove: [],
});

/** A connected copy, already at `text`. */
const synced = (text: string, rev = 0): SharedDraftSyncState =>
  applyServerFrame(initialSharedDraftState(text), snapshot(text, rev), counter('x')).state;

describe('applyLocalText', () => {
  test('sends the first edit at once, and folds what follows into one edit behind it', () => {
    const ids = counter('e');
    const first = applyLocalText(synced('hi', 3), 'hi!', ids);
    const second = applyLocalText(first.state, 'hi!!', ids);
    const third = applyLocalText(second.state, 'hi!!?', ids);

    expect(first.send).toEqual([
      { kind: 'edit', id: 'e1', edit: { generation: G, epoch: 0, base: 3, text: [2, '!'] } },
    ]);
    expect(second.send).toEqual([]);
    expect(third.state.buffer).toEqual({ op: [3, '!?'], sent: false });
    expect(third.state.text).toBe('hi!!?');
  });

  test('marks a send, even when the text was already empty', () => {
    const ids = counter('e');
    const sent = applyLocalText(synced('go', 1), '', ids, true);
    const nothing = applyLocalText(synced('', 1), '', ids, true);
    expect(sent.send).toMatchObject([{ edit: { text: [-2], sent: true } }]);
    expect(nothing.send).toMatchObject([{ edit: { text: [], sent: true } }]);
  });

  test('keeps a send marked when it is folded behind an edit in flight', () => {
    const ids = counter('e');
    const typing = applyLocalText(synced('a'), 'ab', ids);
    const sent = applyLocalText(typing.state, '', ids, true);
    expect(sent.state.buffer).toEqual({ op: [-2], sent: true });
  });

  test('changes nothing for the same text, and only holds the text before the first snapshot', () => {
    const ids = counter('e');
    const same = applyLocalText(synced('a'), 'a', ids);
    const early = applyLocalText(initialSharedDraftState(''), 'typed before connecting', ids);
    expect(same.send).toEqual([]);
    expect(early).toEqual({ state: { text: 'typed before connecting', resyncing: false }, send: [] });
  });
});

describe('applyServerFrame', () => {
  test('adopts the daemon draft on first contact, and offers back different words it held', () => {
    const ids = counter('e');
    const empty = applyServerFrame(initialSharedDraftState(''), snapshot('from the phone', 4), ids);
    const different = applyServerFrame(initialSharedDraftState('old laptop words'), snapshot('from the phone', 4), ids);
    const blank = applyServerFrame(initialSharedDraftState('   '), snapshot('from the phone', 4), ids);

    expect(empty.state).toEqual({
      text: 'from the phone',
      position: { generation: G, epoch: 0, rev: 4 },
      resyncing: false,
    });
    expect(different.state.text).toBe('from the phone');
    expect(different.conflict).toBe('old laptop words');
    expect(blank.conflict).toBeUndefined();
  });

  test('pushes what this device held when the daemon has nothing yet', () => {
    const step = applyServerFrame(initialSharedDraftState('kept locally'), snapshot(''), counter('e'));
    expect(step.state.text).toBe('kept locally');
    expect(step.send).toEqual([
      { kind: 'edit', id: 'e1', edit: { generation: G, epoch: 0, base: 0, text: ['kept locally'] } },
    ]);
  });

  test("applies another device's edit past this device's unanswered typing, and reports it for the caret", () => {
    // Arrange — "hello" at rev 1; this device typed " world" (in flight) and "!" (buffered).
    const ids = counter('e');
    let state = applyLocalText(synced('hello', 1), 'hello world', ids).state;
    state = applyLocalText(state, 'hello world!', ids).state;

    // Act — the phone's "oh " at the start arrives as rev 2.
    const step = applyServerFrame(state, { kind: 'edit', applied: applied(['oh ', 5], 2), epoch: 0, rev: 2 }, ids);

    // Assert
    expect(step.state.text).toBe('oh hello world!');
    expect(step.remote).toEqual(['oh ', 12]);
    expect(step.state.position?.rev).toBe(2);
    expect(step.state.inflight?.op).toEqual([8, ' world']);
  });

  test('sends the buffered edit once the one in flight is answered, against the new revision', () => {
    const ids = counter('e');
    let state = applyLocalText(synced('a', 1), 'ab', ids).state;
    state = applyLocalText(state, 'abc', ids).state;
    const step = applyServerFrame(
      state,
      { kind: 'ack', id: 'e1', applied: applied([1, 'b'], 2), epoch: 0, rev: 2 },
      ids,
    );
    expect(step.send).toEqual([{ kind: 'edit', id: 'e2', edit: { generation: G, epoch: 0, base: 2, text: [2, 'c'] } }]);
    const idle = applyServerFrame(
      step.state,
      { kind: 'ack', id: 'e2', applied: applied([2, 'c'], 3), epoch: 0, rev: 3 },
      ids,
    );
    expect(idle.state).toEqual({ text: 'abc', position: { generation: G, epoch: 0, rev: 3 }, resyncing: false });
  });

  test("takes its own edit, replayed after a reconnect, as answered — and ignores answers that aren't its", () => {
    const ids = counter('e');
    const state = applyLocalText(synced('', 0), 'train', ids).state;
    const replayed = applyServerFrame(
      state,
      { kind: 'edit', id: 'e1', applied: applied(['train'], 1), epoch: 0, rev: 1 },
      ids,
    );
    const stray = applyServerFrame(state, { kind: 'ack', id: 'zzz', applied: applied([], 1), epoch: 0, rev: 1 }, ids);
    expect(replayed.state.inflight).toBeUndefined();
    expect(replayed.state.text).toBe('train');
    expect(stray.state).toBe(state);
  });

  test('resends an edit the LAST stream left unanswered on ready, moved to where the copy now stands', () => {
    const ids = counter('e');
    let state = applyLocalText(synced('ab', 1), 'abX', ids).state;
    state = applyDisconnect(state);
    state = applyServerFrame(state, { kind: 'edit', applied: applied(['>', 2], 2), epoch: 0, rev: 2 }, ids).state;
    const step = applyServerFrame(state, { kind: 'ready' }, ids);
    expect(step.send).toEqual([{ kind: 'edit', id: 'e1', edit: { generation: G, epoch: 0, base: 2, text: [3, 'X'] } }]);
    // Resent once: a second ready (or the next stream's) does not send it again while it is on its way.
    expect(applyServerFrame(step.state, { kind: 'ready' }, ids).send).toEqual([]);
    expect(applyServerFrame(synced('a'), { kind: 'ready' }, ids).send).toEqual([]);
    expect(applyDisconnect(synced('a'))).toEqual(synced('a'));
  });

  test('never sends the first-contact edit twice: it goes with the snapshot, and ready leaves it alone', () => {
    const ids = counter('e');
    const pushed = applyServerFrame(initialSharedDraftState('mine'), snapshot(''), ids);
    expect(pushed.send).toHaveLength(1);
    expect(applyServerFrame(pushed.state, { kind: 'ready' }, ids).send).toEqual([]);
  });

  test('on a refusal holds everything, asks for the whole draft, and offers back what it could not merge', () => {
    const ids = counter('e');
    const state = applyLocalText(synced('a', 1), 'a typed', ids).state;
    const refused = applyServerFrame(state, { kind: 'error', id: 'e1', code: 'shared_draft_stale', message: 'x' }, ids);
    const held = applyLocalText(refused.state, 'a typed more', ids);
    const back = applyServerFrame(held.state, snapshot('', 0, 1), ids);

    expect(refused.resync).toBe(true);
    expect(held.send).toEqual([]);
    expect(back.state.text).toBe('');
    expect(back.conflict).toBe('a typed more');
    expect(applyServerFrame(state, { kind: 'error', id: 'other', code: 'x', message: 'x' }, ids).state).toBe(state);
  });

  test('ignores frames for other people, and edits before it knows its position', () => {
    const ids = counter('e');
    const state = synced('a');
    expect(applyServerFrame(state, { kind: 'presence', peer: 'p', device: 'Phone', typing: true }, ids).state).toBe(
      state,
    );
    expect(applyServerFrame(state, { kind: 'left', peer: 'p' }, ids).state).toBe(state);
    const blind = initialSharedDraftState('x');
    expect(applyServerFrame(blind, { kind: 'edit', applied: applied(['y'], 1), epoch: 0, rev: 1 }, ids).state).toBe(
      blind,
    );
    expect(applyServerFrame(blind, { kind: 'ready' }, ids).state).toBe(blind);
  });
});

/**
 * The daemon's sequencing rule, restated: transform an edit past history since its base, apply it,
 * answer the composer that made it with an ack and everyone else with an edit.
 */
class Sequencer {
  text = '';
  readonly history: TextOp[] = [];
  readonly inboxes = new Map<string, SharedDraftServerFrame[]>();

  receive(from: string, frame: SharedDraftClientFrame): void {
    if (frame.kind !== 'edit') return;
    let op = frame.edit.text ?? [this.text.length];
    for (const earlier of this.history.slice(frame.edit.base)) op = transformTextOps(earlier, op)[1];
    op = normalizeTextOp(op);
    this.text = applyTextOp(this.text, op);
    this.history.push(op);
    const rev = this.history.length;
    for (const [client, inbox] of this.inboxes)
      inbox.push(
        client === from
          ? { kind: 'ack', id: frame.id, applied: applied(op, rev), epoch: 0, rev }
          : { kind: 'edit', applied: applied(op, rev), epoch: 0, rev },
      );
  }
}

const random = (seed: number) => {
  let state = seed;
  return (bound: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % bound;
  };
};

describe('two and three devices typing at once', () => {
  test('every copy ends on the same text as the daemon (500 seeded runs)', () => {
    for (let seed = 1; seed <= 500; seed += 1) {
      const next = random(seed);
      const names = next(2) === 0 ? ['phone', 'laptop'] : ['phone', 'laptop', 'tablet'];
      const server = new Sequencer();
      const clients = new Map<string, SharedDraftSyncState>();
      const outboxes = new Map<string, SharedDraftClientFrame[]>();
      const ids = new Map(names.map(name => [name, counter(`${name}-`)]));
      for (const name of names) {
        server.inboxes.set(name, [snapshot('')]);
        clients.set(name, initialSharedDraftState(''));
        outboxes.set(name, []);
      }
      const deliverDown = (name: string): void => {
        const frame = server.inboxes.get(name)?.shift();
        if (frame === undefined) return;
        const step = applyServerFrame(clients.get(name) as SharedDraftSyncState, frame, ids.get(name) as () => string);
        clients.set(name, step.state);
        outboxes.get(name)?.push(...step.send);
      };
      for (const name of names) deliverDown(name);
      for (let action = 0; action < 60; action += 1) {
        const name = names[next(names.length)] as string;
        const choice = next(3);
        if (choice === 0) {
          const state = clients.get(name) as SharedDraftSyncState;
          const at = next(state.text.length + 1);
          const cut = next(2) === 0 ? next(Math.min(3, state.text.length - at) + 1) : 0;
          const text = `${state.text.slice(0, at)}${'xyz'[next(3)]}${state.text.slice(at + cut)}`;
          const step = applyLocalText(state, text, ids.get(name) as () => string);
          clients.set(name, step.state);
          outboxes.get(name)?.push(...step.send);
        } else if (choice === 1) {
          const frame = outboxes.get(name)?.shift();
          if (frame !== undefined) server.receive(name, frame);
        } else deliverDown(name);
      }
      // Drain everything.
      for (let round = 0; round < 1_000; round += 1) {
        let moved = false;
        for (const name of names) {
          const frame = outboxes.get(name)?.shift();
          if (frame !== undefined) {
            server.receive(name, frame);
            moved = true;
          }
          if ((server.inboxes.get(name)?.length ?? 0) > 0) {
            deliverDown(name);
            moved = true;
          }
        }
        if (!moved) break;
      }
      for (const name of names) {
        const text = clients.get(name)?.text;
        if (text !== server.text)
          throw new Error(`seed ${seed}: ${name} has ${JSON.stringify(text)}, daemon ${JSON.stringify(server.text)}`);
      }
    }
  });
});

describe('edits too big for one frame (review L2)', () => {
  test('splitTextOp: the two halves, run in turn, are exactly the edit, and the first inserts no more than asked (2,000 seeded)', () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const next = random(seed * 31);
      const before = 'ab😀c"d'.repeat(next(4));
      const after = `${before.slice(0, next(before.length + 1))}${'x😀"\\'.repeat(next(5))}${before.slice(next(before.length + 1))}`;
      const op = diffToTextOp(before, after);
      const budget = next(6);
      const [first, second] = splitTextOp(op, budget);
      const inserted = first.reduce<number>((total, c) => total + (typeof c === 'string' ? c.length : 0), 0);
      if (inserted > budget) throw new Error(`seed ${seed}: first inserts ${inserted} > ${budget}`);
      if (applyTextOp(applyTextOp(before, first), second) !== after) throw new Error(`seed ${seed}: halves differ`);
      expect(composeTextOps(first, second).length).toBeGreaterThanOrEqual(0);
    }
  });

  test('never cuts a surrogate pair', () => {
    const [first, second] = splitTextOp(['😀😀'], 3);
    expect(first).toEqual(['😀']);
    expect(second).toEqual([2, '😀']);
  });

  test('sends a paste of 16,000 quote marks as several edits, each within the budget, ending on the same text', () => {
    const ids = counter('e');
    const quotes = '"'.repeat(16_000);
    let step = applyLocalText(synced('', 0), quotes, ids);
    const frames = [...step.send];
    let rev = 0;
    let server = '';
    while (step.state.inflight !== undefined) {
      const frame = step.send[0] ?? frames.at(-1);
      expect(sharedDraftFrameBytes(frame)).toBeLessThanOrEqual(SHARED_DRAFT_EDIT_BUDGET);
      const edit = frame?.kind === 'edit' ? frame.edit : undefined;
      server = applyTextOp(server, edit?.text ?? []);
      rev += 1;
      step = applyServerFrame(
        step.state,
        { kind: 'ack', id: step.state.inflight.id, applied: applied(edit?.text ?? [], rev), epoch: 0, rev },
        ids,
      );
      frames.push(...step.send);
    }
    expect(rev).toBeGreaterThan(1);
    expect(server).toBe(quotes);
    expect(step.state.text).toBe(quotes);
  });

  test('keeps a send marked on the last part only', () => {
    const ids = counter('e');
    const quotes = '"'.repeat(16_000);
    const typed = applyLocalText(synced('', 0), 'x', ids).state;
    const queued = applyLocalText(typed, quotes, ids).state;
    const step = applyServerFrame(queued, { kind: 'ack', id: 'e1', applied: applied(['x'], 1), epoch: 0, rev: 1 }, ids);
    expect(step.send[0]).toMatchObject({ edit: { base: 1 } });
    expect((step.send[0] as { edit: { sent?: boolean } }).edit.sent).toBeUndefined();
    expect(step.state.buffer).toBeDefined();
  });

  test('a stream closed for a frame too big starts again from the whole draft, offering back what was unanswered', () => {
    const ids = counter('e');
    const state = applyResync(applyLocalText(synced('a', 1), 'a typed', ids).state);
    expect(state.inflight).toBeUndefined();
    expect(state.resyncing).toBe(true);
    expect(applyServerFrame(state, snapshot('a', 2), ids).conflict).toBe('a typed');
  });
});
