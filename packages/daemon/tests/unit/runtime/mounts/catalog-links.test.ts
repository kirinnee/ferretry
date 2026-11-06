import { describe, it } from 'bun:test';
import { STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  CatalogLinkRefusal,
  LINK_REFUSALS,
  LINK_STATUS,
  type LinkRefusalCode,
} from '../../../../src/lib/catalog-links/refusal.ts';
import { type CatalogLinkSubsystem, catalogLinkRoutes } from '../../../../src/lib/runtime/mounts/catalog-links.ts';
import { bodyReads, jsonBody, request } from '../../api/support.ts';

const LINK_ID = `lnk_${'l'.repeat(22)}`;
const ITEM = `itm_${'i'.repeat(22)}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;
const URL_SECRET = 'https://app.example.test/l#v1;b=x;k=SECRETKEY';

interface Caller {
  readonly actor: string;
  readonly credential: AuthenticatedCredential;
  readonly governed: boolean;
  readonly proofs?: number;
}
const HOST: Caller = {
  actor: 'admin-cli',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};
const DEVICE: Caller = {
  actor: 'device:d1',
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  governed: true,
};
const FERRET: Caller = {
  actor: 'peer:s1',
  credential: { kind: 'authenticated', tokenClass: 'admin' },
  governed: false,
};

type Links = CatalogLinkSubsystem['links'];
interface Call {
  readonly act: string;
  readonly args: readonly unknown[];
}

class FakeLinks implements Links {
  readonly calls: Call[] = [];
  failure: unknown;
  async storeStatus() {
    return this.#record('storeStatus', { available: true });
  }
  async preview(request: unknown) {
    return this.#record('preview', { digest: DIGEST }, request);
  }
  async mint(request: unknown) {
    return this.#record('mint', { link: { linkId: LINK_ID }, url: URL_SECRET }, request);
  }
  async list(itemId?: string) {
    return this.#record('list', { links: [] }, ...(itemId === undefined ? [] : [itemId]));
  }
  async get(linkId: string) {
    return this.#record('get', { linkId }, linkId);
  }
  async copy(linkId: string) {
    return this.#record('copy', { url: URL_SECRET }, linkId);
  }
  widening = false;
  async move(linkId: string, request: unknown) {
    return this.#record('move', { linkId, version: 2 }, linkId, request);
  }
  async widens(linkId: string, request: unknown) {
    return this.#record('widens', this.widening, linkId, request);
  }
  async update(linkId: string, request: unknown, proven: boolean) {
    return this.#record('update', { linkId }, linkId, request, proven);
  }
  async revoke(linkId: string) {
    return this.#record('revoke', { linkId, state: 'ended' }, linkId);
  }
  #record(act: string, answer: unknown, ...args: unknown[]) {
    this.calls.push({ act, args });
    if (this.failure !== undefined) throw this.failure;
    return answer as never;
  }
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly code?: string;
  readonly message?: string;
  readonly claimedActs: readonly string[];
  readonly noStore: boolean;
}

async function drive(
  links: Links,
  method: string,
  path: string,
  body?: unknown,
  caller: Caller = HOST,
  query: readonly (readonly [string, string])[] = [],
  claim = false,
  governance: CallerGovernance | undefined = undefined,
): Promise<Answer> {
  const found = new ApiRouter(catalogLinkRoutes({ links })).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  const claimedActs: string[] = [];
  const context: RouteContext = {
    request: request({
      method,
      path,
      query,
      headers: { 'content-type': 'application/json' },
      reads: bodyReads(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: found.params,
    actor: caller.actor,
    credential: caller.credential,
    governance:
      governance ??
      ({ governed: caller.governed, decide: () => ({ allowed: true, refusal: 'granted' }) } as CallerGovernance),
    presentation: {
      loopback: !caller.governed,
      adminToken: true,
      actor: caller.actor,
      stepUp: false,
      freshStepUp: false,
    },
    claimFreshStepUp: act => {
      claimedActs.push(String(act));
      return claim && act === STEP_UP_ACTS.shareLink;
    },
    spendFreshStepUp: () => undefined,
  };
  const noStore = found.route.noStore === true;
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown>, claimedActs, noStore };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return {
      status: error.status,
      body: { error: error.message },
      code: error.code,
      message: error.message,
      claimedActs,
      noStore,
    };
  }
}

const MINT = { item: { itemId: ITEM, version: 1, digest: DIGEST }, kind: 'public', expires: '7d' };

describe('the route table', () => {
  const routes = catalogLinkRoutes({ links: new FakeLinks() });
  it('has the nine routes, the fixed paths before :linkId', () => {
    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual([
      'GET /v1/catalog-links/store',
      'POST /v1/catalog-links/preview',
      'GET /v1/catalog-links',
      'POST /v1/catalog-links',
      'GET /v1/catalog-links/:linkId',
      'PUT /v1/catalog-links/:linkId/version',
      'PATCH /v1/catalog-links/:linkId',
      'POST /v1/catalog-links/:linkId/copy',
      'DELETE /v1/catalog-links/:linkId',
    ]);
  });
  it("is the operator's, uncached, behind sharing.use, on every route", () => {
    const narrowing = new Set(['POST ', 'PUT /version', 'PATCH /:linkId', 'POST /copy', 'DELETE /:linkId']);
    for (const route of routes) {
      should(route.minimum).equal('operator');
      should(route.noStore).equal(true);
      const key = `${route.method} ${route.path.replace('/v1/catalog-links', '').replace(/^\/:linkId(?=\/)/, '')}`;
      should(route.capability).deepEqual(
        narrowing.has(key)
          ? { capability: 'sharing', axis: 'use', narrowing: true }
          : { capability: 'sharing', axis: 'use' },
      );
    }
  });
  it('routes /store to the status, not to a link called "store"', () => {
    const found = new ApiRouter(routes).lookup('GET', '/v1/catalog-links/store');
    should(found.kind === 'matched' && found.route.path).equal('/v1/catalog-links/store');
  });
});

describe('reads', () => {
  it('answers the store status, to any caller', async () => {
    const links = new FakeLinks();
    should((await drive(links, 'GET', '/v1/catalog-links/store', undefined, FERRET)).status).equal(200);
    should(links.calls.map(c => c.act)).deepEqual(['storeStatus']);
  });

  it("lists all links, or one item's, and refuses what is not a filter", async () => {
    const links = new FakeLinks();
    should((await drive(links, 'GET', '/v1/catalog-links')).status).equal(200);
    should((await drive(links, 'GET', '/v1/catalog-links', undefined, HOST, [['itemId', ITEM]])).status).equal(200);
    should(links.calls).deepEqual([
      { act: 'list', args: [] },
      { act: 'list', args: [ITEM] },
    ]);
    const stray = await drive(links, 'GET', '/v1/catalog-links', undefined, HOST, [['q', 'x']]);
    should([stray.status, stray.code]).deepEqual([400, 'unknown_parameter']);
    const bad = await drive(links, 'GET', '/v1/catalog-links', undefined, HOST, [['itemId', 'nope']]);
    should([bad.status, bad.code]).deepEqual([400, 'invalid_item_id']);
    should(links.calls).have.length(2);
  });

  it('gets one link by id, and a malformed id is a 404 that never reaches the service', async () => {
    const links = new FakeLinks();
    should((await drive(links, 'GET', `/v1/catalog-links/${LINK_ID}`, undefined, FERRET)).status).equal(200);
    should(links.calls).deepEqual([{ act: 'get', args: [LINK_ID] }]);
    const bad = await drive(links, 'GET', '/v1/catalog-links/not-an-id');
    should([bad.status, bad.code]).deepEqual([404, 'link_unknown']);
    const odd = await drive(links, 'GET', '/v1/catalog-links/%E0%A4%A');
    should([odd.status, odd.code]).deepEqual([404, 'link_unknown']);
    should(links.calls).have.length(1);
  });
});

describe('preview', () => {
  it('hands the service the parsed request', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'POST', '/v1/catalog-links/preview', { itemId: ITEM, version: 1 });
    should(answer.status).equal(200);
    should(links.calls).deepEqual([{ act: 'preview', args: [{ itemId: ITEM, version: 1 }] }]);
  });
  it('refuses a body that is not a selection, and a ferret', async () => {
    const links = new FakeLinks();
    should((await drive(links, 'POST', '/v1/catalog-links/preview', { itemId: ITEM })).status).equal(400);
    const ferret = await drive(links, 'POST', '/v1/catalog-links/preview', { itemId: ITEM, version: 1 }, FERRET);
    should([ferret.status, ferret.code]).deepEqual([403, 'forbidden']);
    should(links.calls).deepEqual([]);
  });
});

describe('minting', () => {
  it('answers 201 with the link and its url, for the machine itself with no proof asked', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'POST', '/v1/catalog-links', MINT);
    should(answer.status).equal(201);
    should(answer.body.url).equal(URL_SECRET);
    should(answer.claimedActs).deepEqual([]);
    should(links.calls.map(c => c.act)).deepEqual(['mint']);
  });

  it('treats a request with no governance as ungoverned', async () => {
    const links = new FakeLinks();
    const found = new ApiRouter(catalogLinkRoutes({ links })).lookup('POST', '/v1/catalog-links');
    if (found.kind !== 'matched') throw new Error('no route');
    const context = {
      request: request({
        method: 'POST',
        path: '/v1/catalog-links',
        query: [],
        headers: { 'content-type': 'application/json' },
        reads: bodyReads(),
        body: JSON.stringify(MINT),
      }),
      params: found.params,
      actor: HOST.actor,
      credential: HOST.credential,
    } as unknown as RouteContext;
    should((await found.route.handle(context)).status).equal(201);
  });

  it('asks a governed device for the passkey for this act alone, and the service is not reached', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'POST', '/v1/catalog-links', MINT, DEVICE);
    should(answer.status).equal(403);
    should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(answer.body.demand).deepEqual({ capability: 'sharing', axis: 'use', act: STEP_UP_ACTS.shareLink });
    should(answer.claimedActs).deepEqual([STEP_UP_ACTS.shareLink]);
    should(links.calls).deepEqual([]);
  });

  it('mints for a device that proved it', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'POST', '/v1/catalog-links', MINT, DEVICE, [], true);
    should(answer.status).equal(201);
    should(links.calls.map(c => c.act)).deepEqual(['mint']);
  });

  it('refuses a ferret before it touches a proof, and a body that is not a link', async () => {
    const links = new FakeLinks();
    const ferret = await drive(links, 'POST', '/v1/catalog-links', MINT, FERRET, [], true);
    should([ferret.status, ferret.code]).deepEqual([403, 'forbidden']);
    should(ferret.claimedActs).deepEqual([]);
    should(
      (await drive(links, 'POST', '/v1/catalog-links', { ...MINT, kind: 'one-time', expires: '7d' })).status,
    ).equal(400);
    should(links.calls).deepEqual([]);
  });
});

const MOVE = { version: 2, from: 1, digest: DIGEST };

describe('moving', () => {
  it('moves for the machine itself with no proof asked', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'PUT', `/v1/catalog-links/${LINK_ID}/version`, MOVE);
    should(answer.status).equal(200);
    should(links.calls).deepEqual([{ act: 'move', args: [LINK_ID, MOVE] }]);
  });
  it('asks a governed device for the passkey, and the service is not reached', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'PUT', `/v1/catalog-links/${LINK_ID}/version`, MOVE, DEVICE);
    should(answer.status).equal(403);
    should(answer.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(answer.claimedActs).deepEqual([STEP_UP_ACTS.shareLink]);
    should(links.calls).deepEqual([]);
    const proven = await drive(links, 'PUT', `/v1/catalog-links/${LINK_ID}/version`, MOVE, DEVICE, [], true);
    should(proven.status).equal(200);
  });
  it('refuses a ferret, a bad id and a body that is not a move', async () => {
    const links = new FakeLinks();
    const ferret = await drive(links, 'PUT', `/v1/catalog-links/${LINK_ID}/version`, MOVE, FERRET, [], true);
    should([ferret.status, ferret.code]).deepEqual([403, 'forbidden']);
    should((await drive(links, 'PUT', '/v1/catalog-links/x/version', MOVE)).code).equal('link_unknown');
    should((await drive(links, 'PUT', `/v1/catalog-links/${LINK_ID}/version`, { version: 2 })).status).equal(400);
    should(links.calls).deepEqual([]);
  });
});

describe('changing', () => {
  const PATH = `/v1/catalog-links/${LINK_ID}`;
  it('changes a narrowing with no proof, and passes proven=false on', async () => {
    const links = new FakeLinks();
    const answer = await drive(links, 'PATCH', PATH, { installCap: 3 }, DEVICE);
    should(answer.status).equal(200);
    should(answer.claimedActs).deepEqual([]);
    should(links.calls.map(c => c.act)).deepEqual(['widens', 'update']);
    should(links.calls[1]?.args).deepEqual([LINK_ID, { installCap: 3 }, false]);
  });
  it('asks a governed device for the passkey when the change widens', async () => {
    const links = new FakeLinks();
    links.widening = true;
    const asked = await drive(links, 'PATCH', PATH, { installCap: null }, DEVICE);
    should(asked.status).equal(403);
    should(asked.body.code).equal(STEP_UP_REQUIRED_CODE);
    should(asked.claimedActs).deepEqual([STEP_UP_ACTS.shareLink]);
    should(links.calls.map(c => c.act)).deepEqual(['widens']);
    const proven = await drive(links, 'PATCH', PATH, { installCap: null }, DEVICE, [], true);
    should(proven.status).equal(200);
    should(links.calls.at(-1)?.args).deepEqual([LINK_ID, { installCap: null }, true]);
  });
  it('maps a refusal while working out the widening, and lets anything else through', async () => {
    const links = new FakeLinks();
    links.failure = new CatalogLinkRefusal('link_unknown', 'no such link');
    const refused = await drive(links, 'PATCH', PATH, { installCap: 3 });
    should([refused.status, refused.code]).deepEqual([LINK_STATUS.link_unknown, 'link_unknown']);
    links.failure = new Error('boom');
    let thrown: unknown;
    try {
      await drive(links, 'PATCH', PATH, { installCap: 3 });
    } catch (error) {
      thrown = error;
    }
    should((thrown as Error).message).equal('boom');
  });
  it('refuses a ferret, a bad id and an empty change', async () => {
    const links = new FakeLinks();
    should((await drive(links, 'PATCH', PATH, { installCap: 3 }, FERRET)).code).equal('forbidden');
    should((await drive(links, 'PATCH', '/v1/catalog-links/x', { installCap: 3 })).code).equal('link_unknown');
    should((await drive(links, 'PATCH', PATH, {})).status).equal(400);
    should(links.calls).deepEqual([]);
  });
});

describe('copy and turn off', () => {
  it('copies for the owner, and refuses a ferret and a bad id', async () => {
    const links = new FakeLinks();
    const ok = await drive(links, 'POST', `/v1/catalog-links/${LINK_ID}/copy`);
    should(ok.status).equal(200);
    should(ok.body.url).equal(URL_SECRET);
    should((await drive(links, 'POST', `/v1/catalog-links/${LINK_ID}/copy`, undefined, FERRET)).code).equal(
      'forbidden',
    );
    should((await drive(links, 'POST', '/v1/catalog-links/x/copy')).code).equal('link_unknown');
    should(links.calls).deepEqual([{ act: 'copy', args: [LINK_ID] }]);
  });

  it('turns a link off with no passkey, even from a governed device, and refuses a ferret and a bad id', async () => {
    const links = new FakeLinks();
    const ok = await drive(links, 'DELETE', `/v1/catalog-links/${LINK_ID}`, undefined, DEVICE);
    should(ok.status).equal(200);
    should(ok.claimedActs).deepEqual([]);
    should((await drive(links, 'DELETE', `/v1/catalog-links/${LINK_ID}`, undefined, FERRET)).code).equal('forbidden');
    should((await drive(links, 'DELETE', '/v1/catalog-links/x')).code).equal('link_unknown');
    should(links.calls).deepEqual([{ act: 'revoke', args: [LINK_ID] }]);
  });
});

describe('refusals', () => {
  for (const code of LINK_REFUSALS) {
    it(`answers ${code} as ${LINK_STATUS[code]} with the code and the sentence`, async () => {
      const links = new FakeLinks();
      links.failure = new CatalogLinkRefusal(code as LinkRefusalCode, 'a sentence');
      const answer = await drive(links, 'GET', `/v1/catalog-links/${LINK_ID}`);
      should([answer.status, answer.code, answer.message]).deepEqual([LINK_STATUS[code], code, 'a sentence']);
    });
  }

  it('lets anything else through to the dispatcher', async () => {
    const links = new FakeLinks();
    links.failure = new Error('boom');
    let thrown: unknown;
    try {
      await drive(links, 'GET', '/v1/catalog-links');
    } catch (error) {
      thrown = error;
    }
    should((thrown as Error).message).equal('boom');
  });

  it('never puts the url in a refusal or a read', async () => {
    const links = new FakeLinks();
    const answers = [
      await drive(links, 'GET', `/v1/catalog-links/${LINK_ID}`),
      await drive(links, 'DELETE', `/v1/catalog-links/${LINK_ID}`),
      await drive(links, 'GET', '/v1/catalog-links'),
    ];
    for (const answer of answers) should(JSON.stringify(answer.body)).not.containEql('SECRETKEY');
  });
});
