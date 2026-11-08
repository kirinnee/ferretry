/**
 * The download-link route table, called directly: who may call each route (a ferret only reads), when a governed
 * caller must prove a fresh passkey, and how a refusal or a bad id is answered.
 */
import { describe, expect, it } from 'bun:test';
import { catalogLinkRoutes, type CatalogLinkSubsystem } from '../../../daemon/lib/routes/catalog-links.ts';
import { CatalogLinkRefusal } from '../../../daemon/lib/catalog-links/refusal.ts';
import { type Answered, bodyOf, callRoute, recordingService } from '../../support/route-driver.ts';

const LINK = `lnk_${'l'.repeat(22)}`;
const ITEM = `itm_${'i'.repeat(22)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const ID = { linkId: LINK };

function table(failWith?: Error) {
  const { service, calls } = recordingService<CatalogLinkSubsystem['links']>(failWith);
  return { routes: catalogLinkRoutes({ links: service }), calls };
}

const status = (answered: Answered) =>
  answered.error === undefined ? answered.response.status : answered.error.status;

describe('catalog link routes', () => {
  it('lets anyone with the grant read the store, the list and one link', async () => {
    const { routes, calls } = table();
    expect(bodyOf(await callRoute(routes, 'GET', '/v1/catalog-links/store', { ferret: true }))).toEqual({
      called: 'storeStatus',
    });
    await callRoute(routes, 'GET', '/v1/catalog-links', { ferret: true });
    await callRoute(routes, 'GET', '/v1/catalog-links/:linkId', { params: ID, ferret: true });
    expect(calls.map(call => call.name)).toEqual(['storeStatus', 'list', 'get']);
  });

  it('filters the list by one item, and refuses any other parameter or an id that could never be one', async () => {
    const { routes, calls } = table();
    await callRoute(routes, 'GET', '/v1/catalog-links', { query: [['itemId', ITEM]] });
    expect(calls[0]?.args).toEqual([ITEM]);
    const unknown = await callRoute(routes, 'GET', '/v1/catalog-links', { query: [['other', '1']] });
    expect(unknown.error?.code).toBe('unknown_parameter');
    const bad = await callRoute(routes, 'GET', '/v1/catalog-links', { query: [['itemId', 'nope']] });
    expect(bad.error?.code).toBe('invalid_item_id');
  });

  it('answers 404 for a link id that could never be one', async () => {
    const { routes } = table();
    const answered = await callRoute(routes, 'GET', '/v1/catalog-links/:linkId', { params: { linkId: 'nope' } });
    expect(answered.error?.status).toBe(404);
    expect(answered.error?.code).toBe('link_unknown');
  });

  it('previews for the owner and never for a ferret', async () => {
    const { routes, calls } = table();
    const body = { itemId: ITEM, version: 1 };
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-links/preview', { body }))).toBe(200);
    expect(calls.map(call => call.name)).toEqual(['preview']);
    const refused = await callRoute(routes, 'POST', '/v1/catalog-links/preview', { body, ferret: true });
    expect(refused.error?.status).toBe(403);
    expect(refused.error?.message).toContain('preview a download link');
  });

  it('mints for the owner (201), and asks a governed caller for a fresh passkey first', async () => {
    const { routes, calls } = table();
    const body = { item: { itemId: ITEM, version: 1, digest: DIGEST }, kind: 'public', expires: '7d' };
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-links', { body }))).toBe(201);
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-links', { body, governed: { fresh: true } }))).toBe(201);
    const needed = await callRoute(routes, 'POST', '/v1/catalog-links', { body, governed: { fresh: false } });
    expect(status(needed)).toBe(403);
    expect(needed.error === undefined && JSON.parse(needed.response.body).demand.act).toBe('share-link');
    expect(calls.map(call => call.name)).toEqual(['mint', 'mint']);
    expect((await callRoute(routes, 'POST', '/v1/catalog-links', { body, ferret: true })).error?.status).toBe(403);
  });

  it('moves a link only with a fresh passkey, and never for a ferret', async () => {
    const { routes, calls } = table();
    const body = { version: 2, from: 1, digest: DIGEST };
    const path = '/v1/catalog-links/:linkId/version';
    expect(status(await callRoute(routes, 'PUT', path, { params: ID, body }))).toBe(200);
    const needed = await callRoute(routes, 'PUT', path, { params: ID, body, governed: { fresh: false } });
    expect(status(needed)).toBe(403);
    expect(needed.error === undefined && JSON.parse(needed.response.body).error).toContain('moving a download link');
    expect((await callRoute(routes, 'PUT', path, { params: ID, body, ferret: true })).error?.status).toBe(403);
    expect(calls.map(call => call.name)).toEqual(['move']);
  });

  it('changes a link: a change that reaches further needs a fresh passkey, one that narrows asks nothing', async () => {
    const wider = recordingService<CatalogLinkSubsystem['links']>();
    const routes = catalogLinkRoutes({
      links: {
        ...wider.service,
        widens: async (_id: string, request: { expires?: string }) => request.expires === 'never',
        update: wider.service.update,
      } as CatalogLinkSubsystem['links'],
    });
    const path = '/v1/catalog-links/:linkId';
    const narrowing = await callRoute(routes, 'PATCH', path, {
      params: ID,
      body: { expires: '1d' },
      governed: { fresh: false },
    });
    expect(status(narrowing)).toBe(200);
    const widening = await callRoute(routes, 'PATCH', path, {
      params: ID,
      body: { expires: 'never' },
      governed: { fresh: false },
    });
    expect(status(widening)).toBe(403);
    expect(widening.error === undefined && JSON.parse(widening.response.body).error).toContain('reach further');
    const allowed = await callRoute(routes, 'PATCH', path, {
      params: ID,
      body: { expires: 'never' },
      governed: { fresh: true },
    });
    expect(status(allowed)).toBe(200);
    expect(wider.calls.map(call => call.name)).toEqual(['update', 'update']);
    expect(
      (await callRoute(routes, 'PATCH', path, { params: ID, body: { expires: '1d' }, ferret: true })).error?.status,
    ).toBe(403);
  });

  it('answers a refusal raised while checking whether a change widens, and passes anything else through', async () => {
    const refusing = catalogLinkRoutes({
      links: {
        ...recordingService<CatalogLinkSubsystem['links']>().service,
        widens: async () => {
          throw new CatalogLinkRefusal('link_unknown', 'no such link');
        },
      } as CatalogLinkSubsystem['links'],
    });
    const answered = await callRoute(refusing, 'PATCH', '/v1/catalog-links/:linkId', {
      params: ID,
      body: { expires: '1d' },
    });
    expect(answered.error?.status).toBe(404);
    expect(answered.error?.code).toBe('link_unknown');
    const broken = catalogLinkRoutes({
      links: {
        ...recordingService<CatalogLinkSubsystem['links']>().service,
        widens: async () => {
          throw new Error('disk gone');
        },
      } as CatalogLinkSubsystem['links'],
    });
    await expect(
      callRoute(broken, 'PATCH', '/v1/catalog-links/:linkId', { params: ID, body: { expires: '1d' } }),
    ).rejects.toThrow('disk gone');
  });

  it('copies and turns off for the owner only', async () => {
    const { routes, calls } = table();
    expect(status(await callRoute(routes, 'POST', '/v1/catalog-links/:linkId/copy', { params: ID }))).toBe(200);
    expect(status(await callRoute(routes, 'DELETE', '/v1/catalog-links/:linkId', { params: ID }))).toBe(200);
    expect(
      (await callRoute(routes, 'POST', '/v1/catalog-links/:linkId/copy', { params: ID, ferret: true })).error?.message,
    ).toContain('copy a download link');
    expect(
      (await callRoute(routes, 'DELETE', '/v1/catalog-links/:linkId', { params: ID, ferret: true })).error?.message,
    ).toContain('turn off a download link');
    expect(calls.map(call => call.name)).toEqual(['copy', 'revoke']);
  });

  it('answers a refusal with its own status and code, and lets any other failure through', async () => {
    const refusing = table(new CatalogLinkRefusal('links_full', 'too many links'));
    const answered = await callRoute(refusing.routes, 'GET', '/v1/catalog-links');
    expect(answered.error?.status).toBe(409);
    expect(answered.error?.code).toBe('links_full');
    const broken = table(new Error('disk gone'));
    await expect(callRoute(broken.routes, 'GET', '/v1/catalog-links')).rejects.toThrow('disk gone');
  });
});
