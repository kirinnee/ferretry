import { describe, expect, it } from 'bun:test';
import {
  addExistingItem,
  type CatalogClient,
  getSharedItem,
  listSharedItems,
  makeDefault,
  makeVersionCurrent,
  NO_CATALOG_FEATURES,
  quickAdd,
  readCatalogFeatures,
  readItemChanges,
  setVersionRetired,
  undoQuickAdd,
} from '../../../../src/features/catalogs/catalogs-api.ts';
import { healthOf } from '../../../support/health.ts';
import {
  addedAnswer,
  catalogChanges,
  CATALOG,
  DIGEST,
  ITEM,
  ownedCatalog,
  sharedItem,
  TOKEN,
} from '../../../support/catalog-views.ts';

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

function recorder(answer: unknown): { client: CatalogClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      calls.push({ path, init });
      return schema.parse(answer);
    },
  } as unknown as CatalogClient;
  return { client, calls };
}

const bodyOf = (call: Call | undefined): unknown => JSON.parse(String(call?.init?.body));

describe('the owner calls for the item table and one-tap Add', () => {
  it('reads the shared items', async () => {
    const { client, calls } = recorder({ publisher: `fy_daemon_${'q3Xk'.repeat(10)}Xkq`, items: [sharedItem()] });
    const list = await listSharedItems(client);
    expect(calls[0]?.path).toBe('/v1/catalog-items');
    expect(list.items[0]?.itemId).toBe(ITEM);
  });

  it('makes a catalog the default with a PATCH of role only', async () => {
    const { client, calls } = recorder(ownedCatalog({ role: 'default' }));
    await makeDefault(client, CATALOG);
    expect(calls[0]?.path).toBe(`/v1/catalogs/${CATALOG}`);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(bodyOf(calls[0])).toEqual({ role: 'default' });
  });

  it('sends a source, or an item id, to quick-add', async () => {
    const { client, calls } = recorder(addedAnswer());
    const answer = await quickAdd(client, { source: { kind: 'skill', skill: '/x/SKILL.md' } });
    expect(answer.outcome).toBe('added');
    expect(calls[0]?.path).toBe('/v1/catalog-items/quick-add');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({ source: { kind: 'skill', skill: '/x/SKILL.md' } });
    await quickAdd(client, { itemId: ITEM });
    expect(bodyOf(calls[1])).toEqual({ itemId: ITEM });
  });

  it('undoes with the token the add answered', async () => {
    const { client, calls } = recorder({
      catalogId: CATALOG,
      itemId: ITEM,
      mode: 'retracted',
      revision: 5,
      itemRemoved: false,
    });
    const undone = await undoQuickAdd(client, TOKEN);
    expect(undone.mode).toBe('retracted');
    expect(calls[0]?.path).toBe('/v1/catalog-items/quick-add/undo');
    expect(bodyOf(calls[0])).toEqual({ token: TOKEN });
  });

  it('adds an existing item by id and the version that was reviewed', async () => {
    const { client, calls } = recorder({
      catalogId: CATALOG,
      itemId: ITEM,
      itemVersion: 2,
      digest: DIGEST,
      revision: 5,
      item: ownedCatalog().items[0],
    });
    await addExistingItem(client, CATALOG, ITEM, 2);
    expect(calls[0]?.path).toBe(`/v1/catalogs/${CATALOG}/items`);
    expect(bodyOf(calls[0])).toEqual({ itemId: ITEM, version: 2 });
  });
});

describe('readCatalogFeatures', () => {
  it('reads both flags from the machine', async () => {
    const both = recorder(healthOf('1.0.0', ['catalogs.items.1', 'catalogs.quick-add.1']));
    expect(await readCatalogFeatures(both.client)).toEqual({
      items: true,
      quickAdd: true,
      versions: false,
      versions2: false,
    });
    const versioned = recorder(healthOf('1.0.0', ['catalogs.versions.1', 'catalogs.versions.2']));
    expect(await readCatalogFeatures(versioned.client)).toEqual({
      items: false,
      quickAdd: false,
      versions: true,
      versions2: true,
    });
    const older = recorder(healthOf('1.0.0'));
    expect(await readCatalogFeatures(older.client)).toEqual(NO_CATALOG_FEATURES);
  });

  it('offers nothing when the machine cannot be asked', async () => {
    const client = {
      request: async () => {
        throw new Error('offline');
      },
    } as unknown as CatalogClient;
    expect(await readCatalogFeatures(client)).toEqual(NO_CATALOG_FEATURES);
  });
});

describe('the owner calls for versions', () => {
  it('reads one item, and what changed between two of its versions', async () => {
    const one = recorder(sharedItem());
    expect((await getSharedItem(one.client, ITEM)).itemId).toBe(ITEM);
    expect(one.calls[0]?.path).toBe(`/v1/catalog-items/${ITEM}`);
    const diff = recorder(catalogChanges());
    const changes = await readItemChanges(diff.client, ITEM, 1, 2);
    expect(diff.calls[0]?.path).toBe(`/v1/catalog-items/${ITEM}/changes?from=1&to=2`);
    expect(changes.unchanged).toBe(3);
  });

  it('makes a version current only from the one the person saw', async () => {
    const { client, calls } = recorder({ itemId: ITEM, itemVersion: 1, current: 1, catalogs: [], item: sharedItem() });
    await makeVersionCurrent(client, ITEM, 1, 2);
    expect(calls[0]?.path).toBe(`/v1/catalog-items/${ITEM}/current`);
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(bodyOf(calls[0])).toEqual({ version: 1, from: 2 });
  });

  it('retires and brings back with a PATCH of retired only', async () => {
    const { client, calls } = recorder({ itemId: ITEM, version: 1, changed: true, catalogs: [] });
    await setVersionRetired(client, ITEM, 1, true);
    await setVersionRetired(client, ITEM, 1, false);
    expect(calls[0]?.path).toBe(`/v1/catalog-items/${ITEM}/versions/1`);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(bodyOf(calls[0])).toEqual({ retired: true });
    expect(bodyOf(calls[1])).toEqual({ retired: false });
  });
});
