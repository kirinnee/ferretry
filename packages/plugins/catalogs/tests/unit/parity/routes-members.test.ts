/**
 * The Catalogs-owned R rows for people: shares and members on the owner's table, and what a member's browser reads and
 * does over its own session (`/v1/shared/…`). Every route is driven through the real daemon half on the kernel's test
 * host: the owner's through its dispatch, a member's over a REAL member session on the kernel's session layer.
 * One test per row, named by its id.
 */
import { describe, expect, test } from 'bun:test';
import {
  browser,
  catalogsFixture,
  type CatalogsFixture,
  joinWith,
  makeCatalog,
  memberSession,
  mintShare,
  mcpServer,
  unlock,
  unlockOnly,
} from '../../support/daemon-host.ts';

const ferret = { kind: 'ferret', id: 'F1936' } as const;
const SOURCE = { kind: 'mcp', mcp: 'pdf-tools' } as const;
const CONCLUDED = 4440;

async function publisher() {
  const fx = await catalogsFixture({ mcp: [mcpServer('pdf-tools')] });
  const catalog = await makeCatalog(fx, 'Team recipes');
  const preview = await fx.host.request('POST', `/v1/catalogs/${catalog}/items/preview`, { body: { source: SOURCE } });
  const added = await fx.host.request('POST', `/v1/catalogs/${catalog}/items`, {
    body: { source: SOURCE, digest: preview.json<{ digest: string }>().digest },
  });
  return { fx, catalog, itemId: added.json<{ itemId: string }>().itemId };
}

/** A joined, unlocked member session on a publisher that lists one item. */
async function unlockedMember() {
  const world = await publisher();
  const who = await browser();
  const joined = await joinWith(world.fx, who, (await mintShare(world.fx, { catalogIds: [world.catalog] })).code);
  const end = await memberSession(world.fx, who, joined.keyId);
  await unlock(end);
  return { ...world, who, joined, end };
}

const members = async (fx: CatalogsFixture) =>
  (await fx.host.request('GET', '/v1/catalog-members')).json<{
    members: { memberId: string; label: string; keys: { keyId: string }[]; catalogs?: unknown[] }[];
  }>().members;

describe('the share and member routes', () => {
  test('R-0268 POST /v1/catalog-shares makes a share link, shown once; a ferret cannot', async () => {
    const { fx, catalog } = await publisher();
    const body = {
      catalogIds: [catalog],
      member: { kind: 'new', label: 'Alice' },
      expiresIn: '1h',
      uses: { kind: 'single' },
    };
    expect((await fx.host.request('POST', '/v1/catalog-shares', { body, as: ferret })).status).toBe(403);
    const minted = await fx.host.request('POST', '/v1/catalog-shares', { body });
    expect(minted.status).toBe(201);
    expect(minted.json<{ code: string }>().code).toMatch(/^fy_share_/u);
    expect((await fx.host.request('POST', '/v1/catalog-shares', { body: { ...body, catalogIds: [] } })).status).toBe(
      400,
    );
  });

  test('R-0069 GET /v1/catalog-shares lists every share and how it stands, and never shows a code', async () => {
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    const listed = await fx.host.request('GET', '/v1/catalog-shares', { as: ferret });
    expect(listed.status).toBe(200);
    expect(listed.json()).toMatchObject({ shares: [{ shareId: share.shareId }] });
    expect(listed.body).not.toContain(share.code);
  });

  test('R-0011 DELETE /v1/catalog-shares/:shareId ends a share so its code stops working', async () => {
    const { fx, catalog } = await publisher();
    const share = await mintShare(fx, { catalogIds: [catalog] });
    expect((await fx.host.request('DELETE', `/v1/catalog-shares/${share.shareId}`, { as: ferret })).status).toBe(403);
    expect((await fx.host.request('DELETE', `/v1/catalog-shares/${share.shareId}`)).status).toBe(200);
    const end = await fx.open().handshake();
    await end.join(await browser(), share.code);
    expect(end.records[0]?.message.t).not.toBe('joined');
    expect((await fx.host.request('DELETE', '/v1/catalog-shares/shr_nope')).status).toBe(404);
  });

  test('R-0068 GET /v1/catalog-members lists everyone who joined with their catalogs and browsers, or one by name', async () => {
    const { fx, catalog } = await publisher();
    await joinWith(
      fx,
      await browser(),
      (await mintShare(fx, { catalogIds: [catalog], member: { kind: 'new', label: 'Alice' } })).code,
    );
    const listed = await fx.host.request('GET', '/v1/catalog-members', { as: ferret });
    expect(listed.status).toBe(200);
    expect(listed.json()).toMatchObject({ members: [{ label: 'Alice', keys: [expect.anything()] }] });
    const byName = await fx.host.request('GET', '/v1/catalog-members', { query: { name: 'Alice' } });
    expect(byName.status).toBe(200);
    expect((await fx.host.request('GET', '/v1/catalog-members', { query: { who: 'x' } })).status).toBe(400);
  });

  test('R-0218 PATCH /v1/catalog-members/:memberId changes a person’s name', async () => {
    const { fx, catalog } = await publisher();
    const joined = await joinWith(fx, await browser(), (await mintShare(fx, { catalogIds: [catalog] })).code);
    expect(
      (await fx.host.request('PATCH', `/v1/catalog-members/${joined.memberId}`, { body: { label: 'Bob' }, as: ferret }))
        .status,
    ).toBe(403);
    const renamed = await fx.host.request('PATCH', `/v1/catalog-members/${joined.memberId}`, {
      body: { label: 'Bob' },
    });
    expect(renamed.status).toBe(200);
    expect((await members(fx)).map(member => member.label)).toEqual(['Bob']);
  });

  test('R-0010 DELETE /v1/catalog-members/:memberId/keys/:keyId removes one browser and signs it out', async () => {
    const { fx, catalog } = await publisher();
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const end = await memberSession(fx, who, joined.keyId);
    const removed = await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/keys/${joined.keyId}`);
    expect(removed.status).toBe(200);
    await end.pump();
    expect(end.end?.code).toBeDefined();
    expect((await members(fx))[0]?.keys).toEqual([]);
    expect((await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/keys/mk_nope`)).status).toBe(404);
  });

  test('R-0009 DELETE /v1/catalog-members/:memberId/catalogs/:catalogId stops a person reading one catalog', async () => {
    const { fx, catalog } = await publisher();
    const joined = await joinWith(fx, await browser(), (await mintShare(fx, { catalogIds: [catalog] })).code);
    const taken = await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/catalogs/${catalog}`);
    expect(taken.status).toBe(200);
    expect(JSON.stringify((await members(fx))[0])).not.toContain(catalog);
    expect(
      (await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}/catalogs/${catalog}`, { as: ferret }))
        .status,
    ).toBe(403);
  });

  test('R-0008 DELETE /v1/catalog-members/:memberId removes a person: their browsers are signed out and their shares end', async () => {
    const { fx, catalog } = await publisher();
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const end = await memberSession(fx, who, joined.keyId);
    const gone = await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`);
    expect(gone.status).toBe(200);
    await end.pump();
    expect(end.end?.code).toBeDefined();
    expect(await members(fx)).toEqual([]);
    expect((await fx.host.request('DELETE', `/v1/catalog-members/${joined.memberId}`)).status).toBe(404);
  });
});

describe('the member routes, over a member session', () => {
  test('R-0386 R-0387 POST /v1/shared/unlock/options then /unlock opens a locked key, and a locked key is told to unlock first', async () => {
    const { fx, catalog } = await publisher();
    const who = await browser();
    const joined = await joinWith(fx, who, (await mintShare(fx, { catalogIds: [catalog] })).code);
    const end = await memberSession(fx, who, joined.keyId);
    expect((await end.ask('GET', '/v1/shared/me')).body.code).toBe('member_locked');
    expect((await unlockOnly(end)).status).toBe(404);
    await unlock(end);
    expect((await end.ask('GET', '/v1/shared/me')).status).toBe(200);
    expect((await unlockOnly(end)).status).toBe(200);
  });

  test('R-0191 GET /v1/shared/me answers who this browser is and what it may read', async () => {
    const { end, catalog } = await unlockedMember();
    const me = await end.ask('GET', '/v1/shared/me');
    expect(me.status).toBe(200);
    expect(JSON.stringify(me.body)).toContain(catalog);
  });

  test('R-0190 R-0189 R-0188 a member reads a catalog’s signed manifest, an item’s versions and one frozen version', async () => {
    const { end, catalog, itemId } = await unlockedMember();
    const manifest = await end.ask('GET', `/v1/shared/catalogs/${catalog}/manifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.body).toMatchObject({ sig: expect.any(String), manifest: { catalogId: catalog } });
    const versions = await end.ask('GET', `/v1/shared/catalogs/${catalog}/items/${itemId}/versions`);
    expect(versions.status).toBe(200);
    const frozen = await end.ask('GET', `/v1/shared/catalogs/${catalog}/items/${itemId}/1`);
    expect(frozen.status).toBe(200);
    expect(frozen.body).toMatchObject({ itemId, itemVersion: 1 });
    const stranger = await end.ask('GET', `/v1/shared/catalogs/cat_${'z'.repeat(22)}/manifest`);
    expect(stranger.status).toBeGreaterThanOrEqual(400);
  });

  test('R-0385 POST /v1/shared/redeem adds the catalogs of a code the owner made for this member', async () => {
    const { fx, joined, end } = await unlockedMember();
    const other = await makeCatalog(fx, 'Other');
    const mine = await mintShare(fx, { catalogIds: [other], member: { kind: 'existing', memberId: joined.memberId } });
    const answer = await end.ask('POST', '/v1/shared/redeem', { code: mine.code });
    expect(answer.status).toBe(200);
    expect(answer.body.added).toEqual([{ catalogId: other, name: 'Other' }]);
    expect((await end.ask('POST', '/v1/shared/redeem', { code: `fy_share_${'x'.repeat(22)}` })).status).toBe(409);
  });

  test('R-0030 DELETE /v1/shared/me/keys/self removes this browser’s own key and ends its session', async () => {
    const { fx, joined, end } = await unlockedMember();
    const answer = await end.ask('DELETE', '/v1/shared/me/keys/self');
    await end.pump();
    expect(answer.status).toBe(200);
    expect(answer.body.keyId).toBe(joined.keyId);
    expect(end.end?.code).toBe(CONCLUDED);
    expect(JSON.stringify(await members(fx))).not.toContain(joined.keyId);
  });
});
