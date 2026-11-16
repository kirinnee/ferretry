import { describe, expect, it } from 'bun:test';
import {
  type CatalogRowsSnapshot,
  createCatalogRowsStore,
  readCatalogRows,
} from '../../../../app/features/catalogs/catalog-rows-store.ts';
import { fakeClient } from '../support/catalog-client.ts';
import { installRecord, ownedCatalog } from '../support/catalog-views.ts';

describe('readCatalogRows: the two lists every row shares', () => {
  it('reads the installs and the catalogs, and which catalog one tap adds to', async () => {
    const catalog = ownedCatalog();
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => ({ installs: [installRecord()] }),
      'GET /v1/catalogs': () => ({ catalogs: [catalog], defaultCatalogId: catalog.id }),
    });
    const rows = await readCatalogRows(fake.factory);
    expect(rows.installs.map(install => install.provenance.name)).toEqual(['pdf-tools']);
    expect(rows.catalogs.map(entry => entry.id)).toEqual([catalog.id]);
    expect(rows.defaultCatalogId).toBe(catalog.id);
  });

  it('leaves the default out when the machine has made no catalog', async () => {
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => ({ installs: [] }),
      'GET /v1/catalogs': () => ({ catalogs: [] }),
    });
    expect(await readCatalogRows(fake.factory)).toEqual({ installs: [], catalogs: [] });
  });

  it('shows nothing for a list that cannot be read, and still shows the other', async () => {
    const fake = fakeClient({
      'GET /v1/catalog-installs': () => {
        throw new Error('down');
      },
      'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
    });
    const rows = await readCatalogRows(fake.factory);
    expect(rows.installs).toEqual([]);
    expect(rows.catalogs).toHaveLength(1);
  });

  it('shows nothing at all when the client cannot be reached', async () => {
    const rows = await readCatalogRows(async () => {
      throw new Error('no client');
    });
    expect(rows).toEqual({ installs: [], catalogs: [] });
  });
});

const snapshotOf = (name: string): CatalogRowsSnapshot => ({ installs: [installRecord('skill', name)], catalogs: [] });
const settled = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

describe('createCatalogRowsStore: one read for every row', () => {
  it('reads nothing until a row subscribes, then once however many rows follow', async () => {
    let reads = 0;
    const store = createCatalogRowsStore(async () => {
      reads += 1;
      return snapshotOf('a');
    });
    expect(reads).toBe(0);
    expect(store.get()).toEqual({ installs: [], catalogs: [] });
    let told = 0;
    const stopFirst = store.subscribe(() => {
      told += 1;
    });
    const stopSecond = store.subscribe(() => {
      told += 1;
    });
    await settled();
    expect(reads).toBe(1);
    expect(told).toBe(2);
    expect(store.get().installs[0]?.provenance.name).toBe('a');
    stopFirst();
    stopSecond();
  });

  it('reads again on reload and tells a row that is still there, not one that left', async () => {
    let name = 'a';
    const store = createCatalogRowsStore(async () => snapshotOf(name));
    let stayed = 0;
    let left = 0;
    const stopStayed = store.subscribe(() => {
      stayed += 1;
    });
    const stopLeft = store.subscribe(() => {
      left += 1;
    });
    await settled();
    stopLeft();
    name = 'b';
    store.reload();
    await settled();
    expect([stayed, left]).toEqual([2, 1]);
    expect(store.get().installs[0]?.provenance.name).toBe('b');
    stopStayed();
  });

  it('reads again when a list is mounted afresh, and shows nothing it read for the list that left', async () => {
    let name = 'a';
    let reads = 0;
    const store = createCatalogRowsStore(async () => {
      reads += 1;
      return snapshotOf(name);
    });
    const stopFirst = store.subscribe(() => undefined);
    await settled();
    expect(store.get().installs[0]?.provenance.name).toBe('a');
    stopFirst();
    // The list is gone: what it read is not shown to the next one, which asks the daemon again.
    expect(store.get()).toEqual({ installs: [], catalogs: [] });
    name = 'b';
    const stopSecond = store.subscribe(() => undefined);
    await settled();
    expect(reads).toBe(2);
    expect(store.get().installs[0]?.provenance.name).toBe('b');
    stopSecond();
  });

  it('drops the answer to a read that comes back after its list left', async () => {
    const answers: ((value: CatalogRowsSnapshot) => void)[] = [];
    const store = createCatalogRowsStore(() => new Promise<CatalogRowsSnapshot>(resolve => answers.push(resolve)));
    const stop = store.subscribe(() => undefined);
    stop();
    const stopAgain = store.subscribe(() => undefined);
    answers[1]?.(snapshotOf('new'));
    await settled();
    answers[0]?.(snapshotOf('old'));
    await settled();
    expect(store.get().installs[0]?.provenance.name).toBe('new');
    stopAgain();
  });

  it('keeps what it read while any row of the list is still there', async () => {
    const store = createCatalogRowsStore(async () => snapshotOf('a'));
    const stopStayed = store.subscribe(() => undefined);
    const stopLeft = store.subscribe(() => undefined);
    await settled();
    stopLeft();
    expect(store.get().installs[0]?.provenance.name).toBe('a');
    stopStayed();
  });

  it('drops the answer to an older read when a newer one was asked for', async () => {
    const answers: ((value: CatalogRowsSnapshot) => void)[] = [];
    const store = createCatalogRowsStore(() => new Promise<CatalogRowsSnapshot>(resolve => answers.push(resolve)));
    const stop = store.subscribe(() => undefined);
    store.reload();
    answers[1]?.(snapshotOf('new'));
    await settled();
    answers[0]?.(snapshotOf('old'));
    await settled();
    expect(store.get().installs[0]?.provenance.name).toBe('new');
    stop();
  });
});
