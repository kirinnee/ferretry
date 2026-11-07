import { describe, expect, test } from 'bun:test';
import { DaemonList, daemonOrigin, groupByMachine, MAX_DAEMONS } from '../../../src/daemons/daemon-list.ts';
import { APP_STORAGE } from '../../../src/storage/names.ts';
import { memoryStore } from '../../../src/storage/records.ts';

const clock = () => {
  let t = 1000;
  return () => (t += 1);
};

const pairing = (daemon: string, machine = 'laptop') => ({
  daemon,
  machine,
  deviceId: `dev-${daemon}`,
  address: 'http://127.0.0.1:40245',
});

describe('daemonOrigin', () => {
  test('keeps an origin and refuses anything more', () => {
    expect(daemonOrigin('https://box.example:8443/')).toBe('https://box.example:8443');
    for (const bad of ['ftp://x', 'https://u:p@x', 'https://x/path', 'https://x/?q=1', 'nope']) {
      expect(() => daemonOrigin(bad)).toThrow();
    }
  });
});

describe('DaemonList', () => {
  test('a pairing is saved as a format 1 record and read back', () => {
    const storage = memoryStore();
    const list = new DaemonList({ storage, now: clock() });
    list.add(pairing('d1'));
    const stored = JSON.parse(storage.entries()[APP_STORAGE.daemons] ?? '{}');
    expect(stored.format).toBe(1);
    const again = new DaemonList({ storage, now: clock() });
    expect(again.snapshot().daemons.map(d => d.daemon)).toEqual(['d1']);
    expect(again.snapshot().selected).toBe('d1');
  });

  test('a re-pair keeps the label and clears the daemon caches first', () => {
    const cleared: string[] = [];
    const list = new DaemonList({ storage: memoryStore(), now: clock() });
    list.registerCache({ clearDaemon: d => cleared.push(d) });
    list.add({ ...pairing('d1'), label: 'Work' });
    list.add(pairing('d1'));
    expect(list.get('d1')?.label).toBe('Work');
    expect(cleared).toEqual(['d1', 'd1']);
  });

  test('removing a pairing forgets its device key and moves the selection', () => {
    const forgotten: string[] = [];
    const list = new DaemonList({ storage: memoryStore(), now: clock(), forget: d => forgotten.push(d) });
    list.add(pairing('d1'));
    list.add(pairing('d2'));
    list.remove('d2');
    expect(forgotten).toEqual(['d2']);
    expect(list.snapshot().selected).toBe('d1');
  });

  test('the oldest pairing past the maximum is evicted and forgotten', () => {
    const forgotten: string[] = [];
    const list = new DaemonList({ storage: memoryStore(), now: clock(), forget: d => forgotten.push(d) });
    for (let i = 0; i <= MAX_DAEMONS; i += 1) list.add(pairing(`d${i}`));
    expect(list.snapshot().daemons).toHaveLength(MAX_DAEMONS);
    expect(forgotten).toEqual(['d0']);
  });

  test('a damaged entry is dropped, the rest kept; an old key is never read', () => {
    const storage = memoryStore({
      [APP_STORAGE.daemons]: JSON.stringify({
        format: 1,
        value: {
          selected: 'd9',
          daemons: [{ daemon: 'bad' }, { ...pairing('d1'), carriers: [], pairedAt: 1, lastSelectedAt: 1 }],
        },
      }),
      'fy-connections-v2': JSON.stringify({ v: 2, connections: [pairing('old')] }),
    });
    const list = new DaemonList({ storage, now: clock() });
    expect(list.snapshot()).toMatchObject({ selected: 'd1', daemons: [{ daemon: 'd1' }] });
  });

  test('rename, select, carriers and machine name', () => {
    const list = new DaemonList({ storage: memoryStore(), now: clock() });
    list.add(pairing('d1'));
    list.add(pairing('d2'));
    list.rename('d1', '  Home  ');
    expect(list.get('d1')?.label).toBe('Home');
    list.rename('d1', '');
    expect(list.get('d1')?.label).toBeUndefined();
    list.select('d1');
    expect(list.snapshot().selected).toBe('d1');
    list.setCarriers('d1', [{ kind: 'direct' }]);
    expect(list.get('d1')?.carriers).toEqual([{ kind: 'direct' }]);
    list.learnMachine('d1', 'studio');
    expect(list.get('d1')?.machine).toBe('studio');
  });

  test('groups by machine, case-insensitively, sorted', () => {
    const list = new DaemonList({ storage: memoryStore(), now: clock() });
    list.add({ ...pairing('a', 'Laptop'), label: 'Work' });
    list.add(pairing('b', 'box'));
    list.add({ ...pairing('c', 'laptop'), label: 'Home' });
    expect(groupByMachine(list.snapshot().daemons).map(g => [g.machine, g.daemons.map(d => d.daemon)])).toEqual([
      ['box', ['b']],
      ['laptop', ['c', 'a']],
    ]);
  });
});
