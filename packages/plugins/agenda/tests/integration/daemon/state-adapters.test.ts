import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { BUZZES, MODES, SEEN, type BuzzRecord } from '../../../contract/index.ts';
import { StateBuzzLedger } from '../../../daemon/adapters/state-buzz-ledger.ts';
import { StateModeStore, StateSeenStore } from '../../../daemon/adapters/state-stores.ts';

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
  const state = folder.port([SEEN, BUZZES, MODES]);
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
