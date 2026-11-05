import { describe, it } from 'bun:test';
import {
  RENDER_MAX_BODY_BYTES,
  RENDER_MAX_PENDING_SAVES,
  type RenderBody,
  type RenderSaveResponse,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, type ApiRequest, type ApiResponse, ApiRouter } from '../../../../src/lib/api/index.ts';
import { renderRoutes } from '../../../../src/lib/runtime/mounts/renders.ts';
import { HTML, MemoryRenderRepository, renderService, SVG } from '../../../support/renders.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FERRET_ARRIVAL, FERRET_SESSION, ferretOwn, human } from './support.ts';

const DEVICE = { deviceId: `fy_device_id_${'d'.repeat(22)}`, appSession: 'app-one' } as const;
const warden = { authorization: `Bearer ${CREDENTIALS.warden}` } as const;
const AT_THE_MACHINE = { loopback: true } as const;

function fixture(repository = new MemoryRenderRepository()) {
  const renders = renderService(repository);
  const routes = renderRoutes(renders);
  const dispatcher = new ApiDispatcher(new ApiRouter([...routes]), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
  return {
    renders,
    routes,
    dispatch: async (overrides: Parameters<typeof request>[0]): Promise<ApiResponse> =>
      await dispatcher.dispatch(request(overrides)),
    dispatchRequest: async (built: ApiRequest): Promise<ApiResponse> => await dispatcher.dispatch(built),
  };
}

/** A request whose body is not delivered until `deliver()`: an upload that has been admitted and is still arriving. */
function slowUpload(overrides: Parameters<typeof request>[0]) {
  const inner = request(overrides);
  let deliver = (): void => undefined;
  const gate = new Promise<void>(resolve => {
    deliver = resolve;
  });
  const reading = { started: 0 };
  const built: ApiRequest = {
    ...inner,
    text: async limit => {
      reading.started += 1;
      await gate;
      return await inner.text(limit);
    },
  };
  return { built, deliver, reading };
}

const settled = async (until: () => boolean): Promise<void> => {
  for (let turns = 0; turns < 100 && !until(); turns += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

const save = (body: unknown, overrides: Omit<Parameters<typeof request>[0], 'method' | 'path' | 'body'> = {}) => ({
  method: 'POST',
  path: '/v1/renders',
  headers: human,
  loopback: true,
  ...overrides,
  body: JSON.stringify(body),
});

const circle = { kind: 'svg', alt: 'A circle', payload: SVG };

/** R1 (docs/renders.md § The invariant): an answer a handler produces says it is data, errors included. */
function shouldBeData(response: ApiResponse): void {
  should(response.headers.get('x-content-type-options')).equal('nosniff');
  should(response.headers.get('content-type')).equal('application/json; charset=utf-8');
}

describe('renders: the grants rows', () => {
  it('should declare all three routes operator, with no capability and no warden remedy', () => {
    const { routes } = fixture();

    should(routes.map(route => `${route.method} ${route.path}`)).deepEqual([
      'POST /v1/renders',
      'GET /v1/renders/:id/meta',
      'GET /v1/renders/:id',
    ]);
    for (const route of routes) {
      should(route.minimum).equal('operator');
      should(route.capability).be.undefined();
      should(route.wardenRemedy).be.undefined();
    }
  });

  it('should refuse a caller with no credential and a warden on every route', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;

    for (const headers of [{}, warden]) {
      should((await dispatch(save(circle, { headers }))).status).be.oneOf(401, 403);
      should((await dispatch({ path: `/v1/renders/${saved.id}`, headers })).status).be.oneOf(401, 403);
      should((await dispatch({ path: `/v1/renders/${saved.id}/meta`, headers })).status).be.oneOf(401, 403);
    }
  });
});

describe('POST /v1/renders', () => {
  it('should save for the owner at the machine, and answer 201 then 200 for the same content', async () => {
    const { dispatch } = fixture();

    const first = await dispatch(save(circle));
    const again = await dispatch(save(circle));

    should(first.status).equal(201);
    should(again.status).equal(200);
    const body = jsonBody(first) as unknown as RenderSaveResponse;
    should(body.token).equal(`%svg:${body.id}`);
    should(body.created).be.true();
    should((jsonBody(again) as unknown as RenderSaveResponse).id).equal(body.id);
    should(first.headers.get('x-content-type-options')).equal('nosniff');
  });

  it("should save for a ferret on its own credential, as that ferret's picture", async () => {
    const { dispatch } = fixture();
    const response = await dispatch(save(circle, { headers: ferretOwn, ...FERRET_ARRIVAL }));

    should(response.status).equal(201);
    should((jsonBody(response).meta as { author: unknown }).author).deepEqual({ sessionId: FERRET_SESSION });
  });

  it('should save for an older fy that names its session in a header', async () => {
    const { dispatch } = fixture();
    const response = await dispatch(save(circle, { headers: agentIn('s1') }));

    should(response.status).equal(201);
    should((jsonBody(response).meta as { author: unknown }).author).deepEqual({ sessionId: 's1' });
  });

  it('should refuse a paired device, even one that arrived on the host, with the reason', async () => {
    const { dispatch } = fixture();

    for (const loopback of [true, false]) {
      const response = await dispatch(save(circle, { headers: {}, device: DEVICE, loopback }));
      should(response.status).equal(403);
      should(jsonBody(response).code).equal('render_save_host_only');
    }
  });

  it('should refuse the admin token when it arrived over the relay, whatever address it appears to carry', async () => {
    const { dispatch } = fixture();
    const relayed = await dispatch(
      save(circle, { loopback: false, privilegedLoopback: false, clientAddress: '127.0.0.1' }),
    );

    should(relayed.status).equal(403);
    should(jsonBody(relayed).code).equal('render_save_host_only');
  });

  it('should refuse before it reads the body', async () => {
    const { dispatch } = fixture();
    const reads = { limits: [] as (number | undefined)[], consumed: false, discarded: false };
    const response = await dispatch(save(circle, { headers: {}, device: DEVICE, loopback: false, reads }));

    should(response.status).equal(403);
    should(reads.consumed).be.false();
  });

  it('should refuse a save with 429 before it reads the body once the bound is in flight, and take saves again after', async () => {
    const repository = new MemoryRenderRepository();
    const release = repository.hold();
    const { dispatch, renders } = fixture(repository);
    const pending = Array.from(
      { length: RENDER_MAX_PENDING_SAVES },
      async (_, n) => await dispatch(save({ ...circle, alt: `Circle ${n}` })),
    );
    for (let turns = 0; turns < 100 && !renders.saturated(); turns += 1)
      await new Promise(resolve => setTimeout(resolve, 0));
    const reads = { limits: [] as (number | undefined)[], consumed: false, discarded: false };

    const refused = await dispatch(save(circle, { reads }));

    should(refused.status).equal(429);
    should(jsonBody(refused).code).equal('render_busy');
    should(String(jsonBody(refused).error)).match(/retry/u);
    should(reads.consumed).be.false();
    shouldBeData(refused);
    release();
    should((await Promise.all(pending)).map(response => response.status)).deepEqual(
      Array.from({ length: RENDER_MAX_PENDING_SAVES }, () => 201),
    );
    should((await dispatch(save(circle))).status).equal(201);
  });

  it('should refuse the next save while the bound of uploads are still being read, without reading its body, and take saves again after', async () => {
    const { dispatchRequest, dispatch, renders } = fixture();
    const uploads = Array.from({ length: RENDER_MAX_PENDING_SAVES }, (_, n) =>
      slowUpload(save({ ...circle, alt: `Circle ${n}` })),
    );
    const pending = uploads.map(async upload => await dispatchRequest(upload.built));
    await settled(() => renders.saturated());
    const reads = { limits: [] as (number | undefined)[], consumed: false, discarded: false };

    const refused = await dispatch(save(circle, { reads }));

    should(refused.status).equal(429);
    should(jsonBody(refused).code).equal('render_busy');
    should(reads.limits).deepEqual([]);
    should(reads.consumed).be.false();
    shouldBeData(refused);
    for (const upload of uploads) upload.deliver();
    should((await Promise.all(pending)).map(response => response.status)).deepEqual(
      Array.from({ length: RENDER_MAX_PENDING_SAVES }, () => 201),
    );
    should(renders.saturated()).be.false();
    should((await dispatch(save(circle))).status).equal(201);
  });

  it('should give its place back after a body that does not parse, an invalid picture, a quota refusal and a failed write', async () => {
    const repository = new MemoryRenderRepository();
    const { dispatch, renders } = fixture(repository);
    const attempts: [string, () => Promise<ApiResponse>][] = [
      ['an unparseable body', async () => await dispatch({ ...save(circle), body: 'not json' })],
      ['a body past the schema', async () => await dispatch(save({ ...circle, extra: 1 }))],
      ['an invalid picture', async () => await dispatch(save({ kind: 'svg', alt: 'x', payload: '<div>no</div>' }))],
      ['a missing picture to replace', async () => await dispatch(save({ ...circle, supersedes: 'aaaaaa' }))],
    ];
    for (const [, attempt] of attempts)
      for (let n = 0; n <= RENDER_MAX_PENDING_SAVES; n += 1) {
        await attempt();
        should(renders.saturated()).be.false();
      }
    repository.failWrite = true;
    for (let n = 0; n <= RENDER_MAX_PENDING_SAVES; n += 1) {
      should((await dispatch(save(circle))).status).equal(500);
      should(renders.saturated()).be.false();
    }
    repository.failWrite = false;

    should((await dispatch(save(circle))).status).equal(201);
  });

  it('should still refuse a caller who may not save with 403 when the bound is in flight', async () => {
    const repository = new MemoryRenderRepository();
    const release = repository.hold();
    const { dispatch, renders } = fixture(repository);
    const pending = Array.from(
      { length: RENDER_MAX_PENDING_SAVES },
      async (_, n) => await dispatch(save({ ...circle, alt: `Circle ${n}` })),
    );
    for (let turns = 0; turns < 100 && !renders.saturated(); turns += 1)
      await new Promise(resolve => setTimeout(resolve, 0));

    const refused = await dispatch(save(circle, { headers: {}, device: DEVICE, loopback: false }));

    should(refused.status).equal(403);
    release();
    await Promise.all(pending);
  });

  it('should carry nosniff and a JSON content type on every refusal it gives', async () => {
    const repository = new MemoryRenderRepository();
    const { dispatch } = fixture(repository);
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;
    repository.payloads.delete(saved.id);

    const refusals: [ApiResponse, number][] = [
      [await dispatch({ path: '/v1/renders/..', headers: human }), 400],
      [await dispatch(save(circle, { headers: {}, device: DEVICE })), 403],
      [await dispatch({ path: '/v1/renders/aaaaaa', headers: human }), 404],
      [await dispatch(save({ kind: 'svg', alt: 'x', payload: '<div>no</div>' })), 422],
      [await dispatch(save({ ...circle, extra: 1 })), 400],
      [await dispatch({ path: `/v1/renders/${saved.id}`, headers: human }), 500],
    ];

    for (const [response, status] of refusals) {
      should(response.status).equal(status);
      shouldBeData(response);
    }
  });

  it('should refuse an invalid picture with the rule that refused it', async () => {
    const { dispatch } = fixture();
    const response = await dispatch(save({ kind: 'svg', alt: 'x', payload: '<svg viewBox="0 0 1 1"><script/></svg>' }));

    should(response.status).equal(422);
    should(jsonBody(response)).containEql({ code: 'render_invalid' });
    should(String(jsonBody(response).error)).match(/script/u);
  });

  it('should refuse a kind the store does not keep, and a field it does not know', async () => {
    const { dispatch } = fixture();

    should((await dispatch(save({ ...circle, kind: 'mermaid' }))).status).equal(400);
    should((await dispatch(save({ ...circle, extra: 1 }))).status).equal(400);
  });

  it('should bound the body it reads', async () => {
    const { dispatch } = fixture();
    const reads = { limits: [] as (number | undefined)[], consumed: false, discarded: false };
    await dispatch(save(circle, { reads }));

    should(reads.limits).deepEqual([RENDER_MAX_BODY_BYTES]);
  });

  it('should refuse a replace of a picture that is not saved with 404', async () => {
    const { dispatch } = fixture();
    const response = await dispatch(save({ ...circle, supersedes: 'aaaaaa' }));

    should(response.status).equal(404);
    should(jsonBody(response).code).equal('render_supersedes_not_found');
  });
});

describe('a failure that is not the store’s refusal', () => {
  it('should answer the dispatcher’s fixed 500 as data, without the error’s text, for a listing, a read and a write that fail', async () => {
    const repository = new MemoryRenderRepository();
    const { dispatch } = fixture(repository);
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;
    const failures: [string, () => Promise<ApiResponse>][] = [
      [
        'failListing',
        async () => {
          const unlisted = new MemoryRenderRepository();
          unlisted.failListing = true;
          return await fixture(unlisted).dispatch(save(circle));
        },
      ],
      [
        'failRead',
        async () => {
          repository.failRead = true;
          return await dispatch({ path: `/v1/renders/${saved.id}`, headers: human });
        },
      ],
      [
        'failWrite',
        async () => {
          repository.failWrite = true;
          return await dispatch(save({ ...circle, alt: 'Another circle' }));
        },
      ],
    ];

    for (const [, failure] of failures) {
      const response = await failure();
      should(response.status).equal(500);
      shouldBeData(response);
      should(jsonBody(response)).deepEqual({
        error: 'the daemon failed to handle this request',
        code: 'internal_error',
      });
      should(response.body).not.match(/disk|unreadable|secret|full/u);
      repository.failRead = false;
      repository.failWrite = false;
    }
  });

  it('should answer a listing failure on the meta route the same way', async () => {
    const repository = new MemoryRenderRepository();
    repository.failListing = true;
    const response = await fixture(repository).dispatch({ path: '/v1/renders/aaaaaa/meta', headers: human });

    should(response.status).equal(500);
    shouldBeData(response);
    should(response.body).not.match(/disk|unreadable/u);
  });
});

describe('GET /v1/renders/:id', () => {
  const html = { kind: 'html', alt: 'A page', payload: '<script>document.cookie</script><h1>Hi</h1>' };

  it('should answer JSON the app can cache for a year, with a strong tag', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;

    const response = await dispatch({ path: `/v1/renders/${saved.id}`, headers: human });

    should(response.status).equal(200);
    should(response.headers.get('cache-control')).equal('private, max-age=31536000, immutable');
    should(response.headers.get('etag')).equal(`"${saved.meta.sha256}"`);
    const body = jsonBody(response) as unknown as RenderBody;
    should(body.payload).equal(SVG);
    should(body.meta.id).equal(saved.id);
    should(body.meta).not.have.property('supersededBy');
  });

  it('should answer 304 to a tag it knows and still say it is not a document', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;
    const tag = `"${saved.meta.sha256}"`;

    const response = await dispatch({ path: `/v1/renders/${saved.id}`, headers: { ...human, 'if-none-match': tag } });

    should(response.status).equal(304);
    should(response.body).equal('');
    should(response.headers.get('x-content-type-options')).equal('nosniff');
    should(response.headers.get('content-type')).equal('application/json');
  });

  // R1 (docs/renders.md § The invariant): a stored html picture must never be a document on the daemon's origin.
  it('should serve a stored html picture as JSON text even when the request asks for a page', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(await dispatch(save(html))) as unknown as RenderSaveResponse;

    for (const accept of ['text/html', 'text/html,application/xhtml+xml', 'image/svg+xml', '*/*']) {
      const response = await dispatch({ path: `/v1/renders/${saved.id}`, headers: { ...human, accept } });

      should(response.status).equal(200);
      should(response.headers.get('content-type')).equal('application/json; charset=utf-8');
      should(response.headers.get('x-content-type-options')).equal('nosniff');
      should(response.body.trimStart().startsWith('{')).be.true();
      should((JSON.parse(response.body) as RenderBody).payload).equal(html.payload);
    }
  });

  it('should serve a stored svg picture as JSON text, never image/svg+xml', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;
    const response = await dispatch({
      path: `/v1/renders/${saved.id}`,
      headers: { ...human, accept: 'image/svg+xml' },
    });

    should(response.headers.get('content-type')).equal('application/json; charset=utf-8');
    should(response.headers.get('x-content-type-options')).equal('nosniff');
  });

  it('should answer 404 for a well-formed id nothing holds and 400 for one that is not an id', async () => {
    const { dispatch } = fixture();

    const missing = await dispatch({ path: '/v1/renders/aaaaaa', headers: human });
    should(missing.status).equal(404);
    should(jsonBody(missing).code).equal('render_not_found');
    should(missing.headers.get('cache-control')).not.equal('private, max-age=31536000, immutable');
    for (const bad of ['..', 'ABCDEF', 'abc', 'abcdei', '%2e%2e', 'a%2Fb']) {
      const response = await dispatch({ path: `/v1/renders/${bad}`, headers: human });
      should(response.status).equal(400);
      should(jsonBody(response).code).equal('invalid_render_id');
    }
  });

  it('should be readable by a paired device and by a relayed caller, which is what no capability means', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;

    for (const overrides of [
      { device: DEVICE, loopback: false },
      { device: DEVICE, ...AT_THE_MACHINE },
    ]) {
      const response = await dispatch({ path: `/v1/renders/${saved.id}`, headers: {}, ...overrides });
      should(response.status).equal(200);
    }
  });
});

describe('GET /v1/renders/:id/meta', () => {
  it('should answer 404 for a picture nothing holds', async () => {
    const { dispatch } = fixture();
    const response = await dispatch({ path: '/v1/renders/aaaaaa/meta', headers: human });

    should(response.status).equal(404);
    should(jsonBody(response).code).equal('render_not_found');
  });

  it('should say which picture replaced this one, and never be cached', async () => {
    const { dispatch } = fixture();
    const first = jsonBody(await dispatch(save(circle))) as unknown as RenderSaveResponse;
    const second = jsonBody(
      await dispatch(save({ ...circle, alt: 'A better circle', supersedes: first.id })),
    ) as unknown as RenderSaveResponse;

    const response = await dispatch({ path: `/v1/renders/${first.id}/meta`, headers: human });

    should(response.status).equal(200);
    should(jsonBody(response)).containEql({ id: first.id, kind: 'svg', supersededBy: second.id });
    should(response.headers.get('cache-control')).equal('no-store');
    should(response.headers.get('x-content-type-options')).equal('nosniff');
    should(JSON.stringify(jsonBody(response))).not.containEql(SVG);
  });

  it('should keep an html picture out of the meta answer too', async () => {
    const { dispatch } = fixture();
    const saved = jsonBody(
      await dispatch(save({ kind: 'html', alt: 'A page', payload: HTML })),
    ) as unknown as RenderSaveResponse;
    const response = await dispatch({
      path: `/v1/renders/${saved.id}/meta`,
      headers: { ...human, accept: 'text/html' },
    });

    should(response.headers.get('content-type')).equal('application/json; charset=utf-8');
    should(response.body).not.containEql('<h1>');
  });
});
