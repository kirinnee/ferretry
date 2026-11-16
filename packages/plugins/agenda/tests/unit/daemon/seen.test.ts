import { describe, expect, it } from 'bun:test';
import { PUSH_SEEN_MAX_TAGS, type SeenFile } from '../../../contract/index.ts';
import { InstantSchema } from '@ferretry/std';
import { emptySeen, markSeen, type SeenStore, tagsToClear } from '../../../daemon/lib/seen.ts';

describe('tagsToClear', () => {
  it('clears the ask’s own buzz, and the ferret’s stop line once nothing else keeps it true', () => {
    expect(tagsToClear('f1', 'A1', { askBuzzed: true, stopBuzzed: true, othersWaiting: false })).toEqual([
      'agenda-f1:A1',
      'agenda-f1',
    ]);
  });

  it('keeps the stop line while another ask still waits, and clears nothing for an ask that never buzzed', () => {
    expect(tagsToClear('f1', 'A1', { askBuzzed: true, stopBuzzed: true, othersWaiting: true })).toEqual([
      'agenda-f1:A1',
    ]);
    expect(tagsToClear('f1', 'A1', { askBuzzed: false, stopBuzzed: false, othersWaiting: false })).toEqual([]);
    expect(tagsToClear('f1', 'A1', { askBuzzed: false, stopBuzzed: true, othersWaiting: false })).toEqual([
      'agenda-f1',
    ]);
  });

  it('never names more tags than a push may clear', () => {
    expect(PUSH_SEEN_MAX_TAGS).toBeGreaterThanOrEqual(2);
  });
});

const at = (value: string) => InstantSchema.parse(value);

const memoryStore = (start: SeenFile = emptySeen()): SeenStore & { held: () => SeenFile } => {
  let held = start;
  return {
    read: async () => held,
    update: async change => {
      held = change(held);
    },
    held: () => held,
  };
};

describe('markSeen', () => {
  it('starts from an empty file and records when each ask was seen, per ferret', async () => {
    const store = memoryStore();
    await markSeen(store, 'f1', 'A1', at('2026-11-07T12:00:00.000Z'));
    await markSeen(store, 'f1', 'A2', at('2026-11-07T12:01:00.000Z'));
    await markSeen(store, 'f2', 'A1', at('2026-11-07T12:02:00.000Z'));
    expect(store.held()).toEqual({
      format: 1,
      seen: {
        f1: { A1: at('2026-11-07T12:00:00.000Z'), A2: at('2026-11-07T12:01:00.000Z') },
        f2: { A1: at('2026-11-07T12:02:00.000Z') },
      },
    });
  });

  it('is idempotent for the same instant', async () => {
    const store = memoryStore();
    await markSeen(store, 'f1', 'A1', at('2026-11-07T12:00:00.000Z'));
    const once = store.held();
    await markSeen(store, 'f1', 'A1', at('2026-11-07T12:00:00.000Z'));
    expect(store.held()).toEqual(once);
  });
});
