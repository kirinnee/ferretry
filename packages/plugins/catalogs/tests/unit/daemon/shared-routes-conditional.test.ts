/**
 * The member routes that answer a conditional read: a member who already holds the current revision is told `304`
 * (and nothing is signed), a stale one gets the signed document with its tag, and an unexpected failure is not
 * dressed up as "not offered".
 */
import { describe, expect, it } from 'bun:test';
import { CatalogMemberRefusal } from '../../../daemon/lib/catalog-members/refusal.ts';
import {
  memberFailure,
  sharedRoutes,
  type SharedRouteDeps,
} from '../../../daemon/lib/catalog-members/shared-routes.ts';
import { CatalogRefusal } from '../../../daemon/lib/shared-catalogs/refusal.ts';

const CATALOG = `cat_${'c'.repeat(22)}`;
const ITEM = `itm_${'i'.repeat(22)}`;

function routes(overrides: Partial<SharedRouteDeps['catalogs']> = {}) {
  const signed: string[] = [];
  const catalogs: SharedRouteDeps['catalogs'] = {
    catalogs: async () => [{ id: CATALOG, name: 'Team', revision: 4 }],
    signedManifest: async () => {
      signed.push('manifest');
      return { manifest: { revision: 4 } } as never;
    },
    versionsRevision: async () => 7,
    signedVersions: async () => {
      signed.push('versions');
      return { versions: { revision: 7 } } as never;
    },
    frozenItem: async () => {
      throw new Error('not read here');
    },
    ...overrides,
  };
  const table = sharedRoutes({ catalogs } as unknown as SharedRouteDeps);
  const call = async (path: string, params: Record<string, string>, ifNoneMatch?: string) => {
    const route = table.find(candidate => candidate.path === path);
    if (route === undefined) throw new Error(`no route ${path}`);
    return await route.handle({
      request: { headers: new Map(ifNoneMatch === undefined ? [] : [['if-none-match', ifNoneMatch]]) },
      params: new Map(Object.entries(params)),
      access: { catalogIds: [CATALOG] },
      appSession: 'tab',
      sessionId: 'session',
    } as never);
  };
  return { call, signed };
}

const MANIFEST = '/v1/shared/catalogs/:catalogId/manifest';
const VERSIONS = '/v1/shared/catalogs/:catalogId/items/:itemId/versions';

describe('conditional member reads', () => {
  it('answers 304 with the tag, and signs nothing, when the member already holds the manifest revision', async () => {
    const { call, signed } = routes();
    const answered = await call(MANIFEST, { catalogId: CATALOG }, 'W/"4"');
    expect(answered.status).toBe(304);
    expect(answered.headers.get('etag')).toBe('"4"');
    expect(answered.body).toBe('');
    expect(signed).toEqual([]);
  });

  it('signs the manifest, with its tag, for a member holding another revision or none', async () => {
    const { call, signed } = routes();
    for (const held of [undefined, '"3"']) {
      const answered = await call(MANIFEST, { catalogId: CATALOG }, held);
      expect(answered.status).toBe(200);
      expect(answered.headers.get('etag')).toBe('"4"');
    }
    expect(signed).toEqual(['manifest', 'manifest']);
  });

  it('answers 304 for a version list the member already holds, and signs it for one who does not', async () => {
    const { call, signed } = routes();
    const params = { catalogId: CATALOG, itemId: ITEM };
    const same = await call(VERSIONS, params, '"7"');
    expect(same.status).toBe(304);
    expect(same.headers.get('etag')).toBe('"7"');
    const stale = await call(VERSIONS, params, '"6"');
    expect(stale.status).toBe(200);
    expect(stale.headers.get('etag')).toBe('"7"');
    expect(signed).toEqual(['versions']);
  });

  it('says an item is not offered when the catalog refuses it, and lets any other failure through', async () => {
    const params = { catalogId: CATALOG, itemId: ITEM };
    const refusing = routes({
      versionsRevision: async () => {
        throw new CatalogRefusal('item_withdrawn', 'withdrawn');
      },
    });
    await expect(refusing.call(VERSIONS, params)).rejects.toMatchObject({ status: 404, code: 'item_unknown' });
    const broken = routes({
      versionsRevision: async () => {
        throw new Error('disk gone');
      },
    });
    await expect(broken.call(VERSIONS, params)).rejects.toThrow('disk gone');
  });
});

describe('memberFailure', () => {
  it('leaves a failure that is not the domain refusal as it was, for the kernel to answer 500', () => {
    const unexpected = new Error('disk gone');
    expect(memberFailure(unexpected)).toBe(unexpected);
  });

  it('keeps the domain refusals their code and status', () => {
    expect(memberFailure(new CatalogMemberRefusal('share_refused', 'no'))).toMatchObject({ code: 'share_refused' });
    expect(memberFailure(new CatalogRefusal('catalog_unknown', 'gone'))).toMatchObject({ status: 404 });
    expect(memberFailure(new CatalogRefusal('name_taken', 'taken'))).toMatchObject({ status: 500 });
  });
});
