import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { BUZZES, MODES, NUDGES, REST_NUDGES, SEEN, type BuzzRecord } from '../../../contract/index.ts';
import { StateBuzzLedger } from '../../../daemon/adapters/state-buzz-ledger.ts';
import {
  StateModeStore,
  StateNudgeStore,
  StateRestNudgeStore,
  StateSeenStore,
} from '../../../daemon/adapters/state-stores.ts';

const AT = '2026-11-01T08:00:00.000Z' as BuzzRecord['at'];

const buzz = (key: string, ferret: string): BuzzRecord => ({
  format: 1,
  key,
  at: AT,
  kind: 'card-ask',
  ferret: ferret as never,
  ask: 'A1',
  title: 'Badge colour',
  enrolled: 1,
});

function fixture(folder = new MemoryStateFolder()) {
  const state = folder.port([SEEN, BUZZES, MODES, NUDGES, REST_NUDGES]);
  return { folder, state };
}

describe('StateBuzzLedger over the agenda state folder', () => {
  test('a buzz that was appended is found by key and listed for its own ferret only', async () => {
    const { state } = fixture();
    const ledger = new StateBuzzLedger(state);
    await ledger.append(buzz('k1', 'f1'));
    await ledger.append(buzz('k2', 'f2'));

    expect(await ledger.has('k1')).toBe(true);
    expect(await ledger.has('nope')).toBe(false);
    expect((await ledger.forFerret('f1')).map(record => record.key)).toEqual(['k1']);
  });

  test('a restarted ledger reads the buzzes back from disk instead of buzzing the same moment twice', async () => {
    const { folder, state } = fixture();
    await new StateBuzzLedger(state).append(buzz('k1', 'f1'));

    const again = new StateBuzzLedger(fixture(folder).state);

    expect(await again.has('k1')).toBe(true);
  });

  test('a failed first read refuses the lookup and the next lookup reads again, never remembering the failure', async () => {
    const { folder, state } = fixture();
    await state.append(BUZZES, buzz('k1', 'f1'));
    const ledger = new StateBuzzLedger(state);
    folder.armCrash();
    await state.append(BUZZES, buzz('k2', 'f1')).catch(() => undefined);

    await expect(ledger.has('k1')).rejects.toThrow('simulated crash');
    folder.revive();

    expect(await ledger.has('k1')).toBe(true);
    expect(await ledger.has('k2')).toBe(true);
  });
});

describe('StateSeenStore over the agenda state folder', () => {
  test('reads as an empty seen file when nothing was ever recorded', async () => {
    const store = new StateSeenStore(fixture().state);

    expect(await store.read()).toEqual({ format: 1, seen: {} });
  });

  test('an update is read back by a restarted store', async () => {
    const { folder, state } = fixture();
    await new StateSeenStore(state).update(current => ({ ...current, seen: { f1: { A1: AT } } }));

    expect(await new StateSeenStore(fixture(folder).state).read()).toEqual({ format: 1, seen: { f1: { A1: AT } } });
  });

  test('a damaged seen file refuses the read, with the sentence naming the file, instead of reading as empty', async () => {
    const { folder, state } = fixture();
    folder.plant(SEEN, '{not json');
    const store = new StateSeenStore(state);

    await expect(store.read()).rejects.toThrow('seen.json');
    await expect(store.update(current => current)).rejects.toThrow('seen.json');
  });
});

describe('StateModeStore over the agenda state folder', () => {
  test('records nothing for a ferret that never switched, then the value it was written with', async () => {
    const store = new StateModeStore(fixture().state);
    expect(await store.recorded('f1')).toBeUndefined();

    await store.write('f1', false, AT);
    await store.write('f2', true, AT);

    expect(await store.recorded('f1')).toBe(false);
    expect(await store.recorded('f2')).toBe(true);
  });

  test('a damaged modes file refuses both the read and the write', async () => {
    const { folder, state } = fixture();
    folder.plant(MODES, 'garbage');
    const store = new StateModeStore(state);

    await expect(store.recorded('f1')).rejects.toThrow('modes.json');
    await expect(store.write('f1', true, AT)).rejects.toThrow('modes.json');
  });
});

describe('StateNudgeStore over the agenda state folder', () => {
  const mark = (sendId: string) => ({ sendId, at: AT });

  test('a ferret never nudged has no mark; the first reservation takes one and a restart reads it back', async () => {
    const { folder, state } = fixture();
    const store = new StateNudgeStore(state);
    expect(await store.mark('f1')).toBeUndefined();

    expect(await store.reserve('f1', mark('n1'), undefined)).toBe(true);

    expect(await new StateNudgeStore(fixture(folder).state).mark('f1')).toEqual(mark('n1'));
    expect(await store.mark('f2')).toBeUndefined();
  });

  test('a second reservation loses unless it names the mark it replaces, and a loser changes nothing', async () => {
    const store = new StateNudgeStore(fixture().state);
    await store.reserve('f1', mark('n1'), undefined);

    expect(await store.reserve('f1', mark('n2'), undefined)).toBe(false);
    expect(await store.reserve('f1', mark('n2'), 'other')).toBe(false);
    expect(await store.mark('f1')).toEqual(mark('n1'));
    expect(await store.reserve('f1', mark('n2'), 'n1')).toBe(true);
    expect(await store.mark('f1')).toEqual(mark('n2'));
  });

  test('a loser keeps what another ferret holds', async () => {
    const store = new StateNudgeStore(fixture().state);
    await store.reserve('f1', mark('n1'), undefined);

    expect(await store.reserve('f2', mark('x'), 'n1')).toBe(false);
    expect(await store.mark('f1')).toEqual(mark('n1'));
  });

  test('releasing the nudge that was reserved clears it; releasing any other send leaves it', async () => {
    const store = new StateNudgeStore(fixture().state);
    await store.reserve('f1', mark('n1'), undefined);
    await store.reserve('f2', mark('n9'), undefined);

    await store.release('f1', 'not-it');
    expect(await store.mark('f1')).toEqual(mark('n1'));
    await store.release('f1', 'n1');
    expect(await store.mark('f1')).toBeUndefined();
    expect(await store.mark('f2')).toEqual(mark('n9'));
    await store.release('f3', 'nothing');
  });

  test('a damaged nudges file refuses the read, the reservation and the release', async () => {
    const { folder, state } = fixture();
    folder.plant(NUDGES, 'garbage');
    const store = new StateNudgeStore(state);

    await expect(store.mark('f1')).rejects.toThrow('nudges.json');
    await expect(store.reserve('f1', mark('n1'), undefined)).rejects.toThrow('nudges.json');
    await expect(store.release('f1', 'n1')).rejects.toThrow('nudges.json');
  });
});

describe('StateRestNudgeStore over the agenda state folder', () => {
  const rec = (sendId: string, nudges = 1) => ({ since: AT, nudges, at: AT, sendId });

  test('a ferret never nudged has no records; a reservation is read back by a restarted store, per ferret', async () => {
    const { folder, state } = fixture();
    const store = new StateRestNudgeStore(state);
    expect(await store.records('f1')).toEqual({});

    await store.reserve('f1', { A1: rec('s1'), A2: rec('s1') }, ['A1', 'A2']);

    const restarted = new StateRestNudgeStore(fixture(folder).state);
    expect(await restarted.records('f1')).toEqual({ A1: rec('s1'), A2: rec('s1') });
    expect(await restarted.records('f2')).toEqual({});
  });

  test('a reservation replaces an item’s record, keeps live items, drops the ones no longer on the board, and keeps other ferrets', async () => {
    const store = new StateRestNudgeStore(fixture().state);
    await store.reserve('f1', { A1: rec('s1'), A2: rec('s1') }, ['A1', 'A2']);
    await store.reserve('f2', { A1: rec('x') }, ['A1']);

    await store.reserve('f1', { A1: rec('s2', 2) }, ['A1']);

    expect(await store.records('f1')).toEqual({ A1: rec('s2', 2) });
    expect(await store.records('f2')).toEqual({ A1: rec('x') });
  });

  test('releasing a send restores each item it still holds to its prior record, or to none, and leaves a newer send’s', async () => {
    const store = new StateRestNudgeStore(fixture().state);
    await store.reserve('f1', { A1: rec('s1') }, ['A1', 'A2']);
    await store.reserve('f1', { A1: rec('s2', 2), A2: rec('s2') }, ['A1', 'A2']);

    await store.release('f1', 's2', { A1: rec('s1'), A2: undefined, A3: undefined });
    expect(await store.records('f1')).toEqual({ A1: rec('s1') });

    await store.release('f1', 'not-it', { A1: undefined });
    expect(await store.records('f1')).toEqual({ A1: rec('s1') });
  });

  test('a ferret left with no records leaves the file, and releasing for a ferret with none is a no-op', async () => {
    const { folder, state } = fixture();
    const store = new StateRestNudgeStore(state);
    await store.reserve('f1', { A1: rec('s1') }, ['A1']);
    await store.release('f1', 's1', { A1: undefined });
    await store.release('f9', 's1', { A1: undefined });

    expect(await store.records('f1')).toEqual({});
    expect(await new StateRestNudgeStore(fixture(folder).state).records('f1')).toEqual({});
  });

  test('a damaged rest-nudges file refuses the read, the reservation and the release', async () => {
    const { folder, state } = fixture();
    folder.plant(REST_NUDGES, 'garbage');
    const store = new StateRestNudgeStore(state);

    await expect(store.records('f1')).rejects.toThrow('rest-nudges.json');
    await expect(store.reserve('f1', { A1: rec('s1') }, ['A1'])).rejects.toThrow('rest-nudges.json');
    await expect(store.release('f1', 's1', { A1: undefined })).rejects.toThrow('rest-nudges.json');
    await expect(store.prune(['f1'], {})).rejects.toThrow('rest-nudges.json');
  });

  /** The store over a state port that counts the writes it is asked for. */
  const counted = () => {
    const { folder, state } = fixture();
    const writes = { count: 0 };
    const port = {
      ...state,
      update: (async (...args: Parameters<typeof state.update>) => {
        writes.count += 1;
        return await state.update(...args);
      }) as typeof state.update,
    };
    return { folder, state, store: new StateRestNudgeStore(port), writes };
  };

  test('pruning drops a closed item’s record, a removed ferret’s, and an emptied ferret, in one write, and a restart reads the rest', async () => {
    const { folder, store, writes } = counted();
    await store.reserve('f1', { A1: rec('s1'), A2: rec('s1') }, ['A1', 'A2']);
    await store.reserve('f2', { A1: rec('x') }, ['A1']);
    await store.reserve('f3', { A1: rec('y') }, ['A1']);
    writes.count = 0;

    await store.prune(['f1', 'f2'], { f1: ['A1'], f2: [] });

    expect(writes.count).toBe(1);
    const restarted = new StateRestNudgeStore(fixture(folder).state);
    expect(await restarted.records('f1')).toEqual({ A1: rec('s1') });
    expect(await restarted.records('f2')).toEqual({});
    expect(await restarted.records('f3')).toEqual({});
  });

  test('pruning keeps every record of a ferret on the roster whose board was not read, and writes nothing when nothing is dropped', async () => {
    const { store, writes } = counted();
    await store.reserve('f1', { A1: rec('s1') }, ['A1']);
    writes.count = 0;

    await store.prune(['f1'], {});
    await store.prune(['f1'], { f1: ['A1'] });
    await new StateRestNudgeStore(fixture().state).prune([], {});

    expect(writes.count).toBe(0);
    expect(await store.records('f1')).toEqual({ A1: rec('s1') });
  });

  test('a refused prune write is reported', async () => {
    const { store, state } = counted();
    await store.reserve('f1', { A1: rec('s1') }, ['A1']);
    const refusing = new StateRestNudgeStore({
      ...state,
      update: (async () => ({ ok: false, error: { sentence: 'the state would not take the write' } })) as never,
    });

    await expect(refusing.prune([], {})).rejects.toThrow('the state would not take the write');
  });
});
