import { describe, expect, test } from 'bun:test';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { memoryStore } from '../../../src/storage/records.ts';

const pairing = (daemon: string) => ({
  daemon,
  machine: 'laptop',
  deviceId: `dev-${daemon}`,
  address: 'http://127.0.0.1:40245',
});
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('S12 DaemonList.onUnpaired', () => {
  test('S12 fires once per unpair, AFTER the device key is forgotten and the record is gone', async () => {
    const order: string[] = [];
    let list!: DaemonList;
    let release: () => void = () => {};
    const forgetting = new Promise<void>(resolve => {
      release = resolve;
    });
    list = new DaemonList({
      storage: memoryStore(),
      now: () => 1,
      forget: async daemon => {
        order.push(`key:${daemon}`);
        await forgetting;
        order.push(`key-gone:${daemon}`);
      },
    });
    list.onUnpaired(daemon =>
      order.push(`unpaired:${daemon}:${list.get(daemon) === undefined ? 'record-gone' : 'record-kept'}`),
    );
    list.add(pairing('d1'));
    list.remove('d1');
    await settle();
    expect(order).toEqual(['key:d1']); // the plugins wait for the key to be deleted
    release();
    await settle();
    expect(order).toEqual(['key:d1', 'key-gone:d1', 'unpaired:d1:record-gone']);
    list.remove('d1'); // already gone: nothing fires again
    await settle();
    expect(order).toHaveLength(3);
  });

  test('S12 a re-pair of the same daemon never fires it', async () => {
    const seen: string[] = [];
    const list = new DaemonList({ storage: memoryStore(), now: () => 1 });
    list.onUnpaired(daemon => seen.push(daemon));
    list.add(pairing('d1'));
    list.add(pairing('d1'));
    await settle();
    expect(seen).toEqual([]);
  });

  test('S12 an eviction past the limit fires it for the evicted daemon', async () => {
    const seen: string[] = [];
    let t = 0;
    const list = new DaemonList({ storage: memoryStore(), now: () => (t += 1) });
    list.onUnpaired(daemon => seen.push(daemon));
    for (let i = 0; i < 21; i += 1) list.add(pairing(`d${i}`));
    await settle();
    expect(seen).toEqual(['d0']);
  });

  test('S12 a throwing key deletion and a throwing listener cost only themselves', async () => {
    const seen: string[] = [];
    const list = new DaemonList({
      storage: memoryStore(),
      now: () => 1,
      forget: () => {
        throw new Error('no key store');
      },
    });
    const stop = list.onUnpaired(() => {
      throw new Error('a plugin failed');
    });
    list.onUnpaired(daemon => seen.push(daemon));
    list.add(pairing('d1'));
    list.remove('d1');
    await settle();
    expect(seen).toEqual(['d1']);
    stop();
  });

  test('S12 a rejected key deletion still tells the plugins', async () => {
    const seen: string[] = [];
    const list = new DaemonList({ storage: memoryStore(), now: () => 1, forget: () => Promise.reject(new Error('x')) });
    list.onUnpaired(daemon => seen.push(daemon));
    list.add(pairing('d1'));
    list.remove('d1');
    await settle();
    expect(seen).toEqual(['d1']);
  });
});
