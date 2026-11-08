/**
 * The share and member route table, called directly: a ferret only lists, a governed caller proves a fresh passkey
 * to add access, and a bad id or a refusal is answered with its own status.
 */
import { describe, expect, it } from 'bun:test';
import { CatalogMemberRefusal } from '../../../daemon/lib/catalog-members/refusal.ts';
import { catalogMemberRoutes, type CatalogMemberSubsystem } from '../../../daemon/lib/routes/catalog-members.ts';
import { type Answered, callRoute, recordingService } from '../../support/route-driver.ts';

const SHARE = `shr_${'s'.repeat(22)}`;
const MEMBER = `mbr_${'m'.repeat(22)}`;
const KEY = `mk_${'k'.repeat(22)}`;
const CATALOG = `cat_${'c'.repeat(22)}`;
const MINT = {
  catalogIds: [CATALOG],
  member: { kind: 'new', label: 'alice' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

function table(failWith?: Error) {
  const { service, calls } = recordingService<CatalogMemberSubsystem['members']>(failWith);
  return { routes: catalogMemberRoutes({ members: service }), calls };
}

const status = (answered: Answered) =>
  answered.error === undefined ? answered.response.status : answered.error.status;

describe('catalog member routes', () => {
  it('mints for the owner (201), and asks a governed caller for a fresh passkey first', async () => {
    const { routes, calls } = table();
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-shares', { body: MINT }))).toBe(201);
    expect(
      status(await callRoute(routes, 'POST', '/v1/catalog-shares', { body: MINT, governed: { fresh: true } })),
    ).toBe(201);
    const needed = await callRoute(routes, 'POST', '/v1/catalog-shares', { body: MINT, governed: { fresh: false } });
    expect(status(needed)).toBe(403);
    expect(needed.error === undefined && JSON.parse(needed.response.body).demand.act).toBe('share-catalog');
    expect(calls.map(call => call.name)).toEqual(['mint', 'mint']);
    expect(
      (await callRoute(routes, 'POST', '/v1/catalog-shares', { body: MINT, ferret: true })).error?.message,
    ).toContain('share a catalog');
  });

  it('approves a new passkey only with a fresh passkey, and takes the approval back with none', async () => {
    const { routes, calls } = table();
    const path = '/v1/catalog-shares/:shareId/new-passkey';
    const params = { shareId: SHARE };
    expect(status(await callRoute(routes, 'PUT', path, { params }))).toBe(200);
    expect(status(await callRoute(routes, 'PUT', path, { params, governed: { fresh: false } }))).toBe(403);
    expect((await callRoute(routes, 'PUT', path, { params, ferret: true })).error?.status).toBe(403);
    expect((await callRoute(routes, 'PUT', path, { params: { shareId: 'nope' } })).error?.code).toBe('share_unknown');
    expect(status(await callRoute(routes, 'DELETE', path, { params }))).toBe(200);
    expect((await callRoute(routes, 'DELETE', path, { params, ferret: true })).error?.status).toBe(403);
    expect(calls.map(call => [call.name, call.args])).toEqual([
      ['markNewPasskey', [SHARE, true]],
      ['markNewPasskey', [SHARE, false]],
    ]);
  });

  it('lists shares for anyone with the grant, and ends one for the owner only', async () => {
    const { routes, calls } = table();
    expect(status(await callRoute(routes, 'GET', '/v1/catalog-shares', { ferret: true }))).toBe(200);
    expect(
      status(await callRoute(routes, 'DELETE', '/v1/catalog-shares/:shareId', { params: { shareId: SHARE } })),
    ).toBe(200);
    expect(
      (await callRoute(routes, 'DELETE', '/v1/catalog-shares/:shareId', { params: { shareId: SHARE }, ferret: true }))
        .error?.message,
    ).toContain('end a share');
    expect(calls.map(call => call.name)).toEqual(['listShares', 'endShare']);
  });

  it('lists people, looks one up by name, and refuses any other parameter or a name that could never be one', async () => {
    const { routes, calls } = table();
    await callRoute(routes, 'GET', '/v1/catalog-members', { ferret: true });
    await callRoute(routes, 'GET', '/v1/catalog-members', { query: [['name', 'alice']] });
    expect(calls.map(call => call.args)).toEqual([[undefined], ['alice']]);
    expect((await callRoute(routes, 'GET', '/v1/catalog-members', { query: [['who', 'x']] })).error?.code).toBe(
      'unknown_parameter',
    );
    const bad = await callRoute(routes, 'GET', '/v1/catalog-members', { query: [['name', '   ']] });
    expect(bad.error?.status).toBe(400);
    expect(bad.error?.code).toBe('invalid_name');
  });

  it('renames, removes a person and removes a browser or a catalog for the owner only', async () => {
    const { routes, calls } = table();
    const member = { memberId: MEMBER };
    expect(
      status(
        await callRoute(routes, 'PATCH', '/v1/catalog-members/:memberId', { params: member, body: { label: 'bob' } }),
      ),
    ).toBe(200);
    expect(status(await callRoute(routes, 'DELETE', '/v1/catalog-members/:memberId', { params: member }))).toBe(200);
    expect(
      status(
        await callRoute(routes, 'DELETE', '/v1/catalog-members/:memberId/keys/:keyId', {
          params: { ...member, keyId: KEY },
        }),
      ),
    ).toBe(200);
    expect(
      status(
        await callRoute(routes, 'DELETE', '/v1/catalog-members/:memberId/catalogs/:catalogId', {
          params: { ...member, catalogId: CATALOG },
        }),
      ),
    ).toBe(200);
    expect(calls.map(call => call.name)).toEqual(['renameMember', 'revokeMember', 'removeKey', 'removeCatalog']);
    for (const [method, path] of [
      ['PATCH', '/v1/catalog-members/:memberId'],
      ['DELETE', '/v1/catalog-members/:memberId'],
      ['DELETE', '/v1/catalog-members/:memberId/keys/:keyId'],
      ['DELETE', '/v1/catalog-members/:memberId/catalogs/:catalogId'],
    ] as const)
      expect(
        (await callRoute(routes, method, path, { params: { ...member, keyId: KEY, catalogId: CATALOG }, ferret: true }))
          .error?.status,
      ).toBe(403);
  });

  it('answers 404 for an id that could never be one, naming what was not found', async () => {
    const { routes } = table();
    const badMember = await callRoute(routes, 'DELETE', '/v1/catalog-members/:memberId', { params: { memberId: 'x' } });
    expect(badMember.error?.code).toBe('member_unknown');
    const badKey = await callRoute(routes, 'DELETE', '/v1/catalog-members/:memberId/keys/:keyId', {
      params: { memberId: MEMBER, keyId: 'x' },
    });
    expect(badKey.error?.code).toBe('member_key_unknown');
    const badCatalog = await callRoute(routes, 'DELETE', '/v1/catalog-members/:memberId/catalogs/:catalogId', {
      params: { memberId: MEMBER, catalogId: 'x' },
    });
    expect(badCatalog.error?.code).toBe('catalog_unknown');
  });

  it('answers a refusal with its own status, code and the person it found, and lets any other failure through', async () => {
    const refusing = table(new CatalogMemberRefusal('member_exists', 'that name is taken', MEMBER));
    const answered = await callRoute(refusing.routes, 'GET', '/v1/catalog-shares');
    expect(answered.error?.status).toBe(409);
    expect(answered.error?.code).toBe('member_exists');
    expect(answered.error?.extra).toEqual({ memberId: MEMBER });
    const withoutPerson = table(new CatalogMemberRefusal('shares_full', 'too many shares'));
    expect((await callRoute(withoutPerson.routes, 'GET', '/v1/catalog-shares')).error?.extra).toBeUndefined();
    const broken = table(new Error('disk gone'));
    await expect(callRoute(broken.routes, 'GET', '/v1/catalog-shares')).rejects.toThrow('disk gone');
  });
});
