import { describe, it } from 'bun:test';
import should from 'should';
import {
  hostedLinkStoreFetch,
  isHostedLinkStorePath,
  type LinkStoreBinding,
  type RelayEnvironment,
  relayFetch,
} from '../../src/adapters/index.ts';
import relayWorker from '../../src/adapters/worker.ts';
import { LinkStoreAdvertisementSchema, linkBundlePath, linkFetchPath, linkPeekPath } from '../../src/lib/index.ts';

const HOST = 'https://relay.example';
const bundleId = `lnk_${'A'.repeat(22)}`;

const STORE_PATHS: readonly (readonly [string, string])[] = [
  ['GET', '/v1/link-store'],
  ['POST', '/v1/link-store/challenge'],
  ['POST', '/v1/link-store/status'],
  ['PUT', linkBundlePath(bundleId)],
  ['DELETE', linkBundlePath(bundleId)],
  ['POST', linkPeekPath(bundleId)],
  ['POST', linkFetchPath(bundleId)],
  ['GET', '/v1/operator/link-store'],
  ['PUT', '/v1/operator/link-store'],
];

interface Store {
  readonly binding: LinkStoreBinding;
  readonly received: Request[];
}

function store(answer: (request: Request) => Promise<Response> | Response): Store {
  const received: Request[] = [];
  return {
    received,
    binding: {
      fetch: async request => {
        received.push(request);
        return answer(request);
      },
    },
  };
}

function environment(overrides: Partial<RelayEnvironment> = {}): RelayEnvironment {
  return {
    RELAY_MODE: 'hosted',
    RENDEZVOUS: {
      idFromName: name => name,
      get: () => ({
        fetch: async () => {
          throw new Error('a link-store request reached a rendezvous');
        },
      }),
    },
    ...overrides,
  };
}

const request = (method: string, path: string, init: RequestInit = {}): Request =>
  new Request(`${HOST}${path}`, { method, ...init });

/** An environment whose LINK_STORE getter throws, so reading the binding at all is a test failure. */
function unreadableBinding(mode: string | undefined): RelayEnvironment {
  const base = environment({ RELAY_MODE: mode });
  Object.defineProperty(base, 'LINK_STORE', {
    enumerable: true,
    get: () => {
      throw new Error('the LINK_STORE binding was read');
    },
  });
  return base;
}

interface Arrival {
  readonly authorization: string | null;
  readonly bodyPulledOnArrival: boolean;
  readonly body: string;
}

describe('which paths belong to the link store', () => {
  it('should claim the five service paths and everything under /v1/links/', () => {
    for (const [, path] of STORE_PATHS) should(isHostedLinkStorePath(path)).be.true();
    should(isHostedLinkStorePath('/v1/links/anything/at/all')).be.true();
  });

  it('should leave every other path to the relay', () => {
    for (const path of [
      '/',
      '/v1/default-relay',
      '/v1/tunnel-service',
      '/v1/links',
      '/v1/link-storeX',
      '/v1/operator/config',
    ]) {
      should(isHostedLinkStorePath(path)).be.false();
    }
  });
});

describe('the hosted relay with a LINK_STORE binding', () => {
  guarantee(['R136'], 'should forward each store path to the binding as the very request it received', async () => {
    for (const [method, path] of STORE_PATHS) {
      const fake = store(() => new Response('from the store', { status: 207 }));
      const incoming = request(method, path);
      const response = await relayFetch(incoming, environment({ LINK_STORE: fake.binding }));
      should(response.status).equal(207);
      should(await response.text()).equal('from the store');
      should(fake.received).have.length(1);
      should(fake.received[0]).equal(incoming);
    }
  });

  it('should hand the store the credentials and body it was sent, with the body still unread', async () => {
    for (const [method, path] of STORE_PATHS.filter(([method]) => method !== 'GET')) {
      let pulled = false;
      const arrivals: Arrival[] = [];
      const fake = store(async seen => {
        const bodyPulledOnArrival = pulled;
        arrivals.push({
          authorization: seen.headers.get('Authorization'),
          bodyPulledOnArrival,
          body: await seen.text(),
        });
        return new Response('stored');
      });
      const upload = new ReadableStream<Uint8Array>(
        {
          pull: controller => {
            pulled = true;
            controller.enqueue(new TextEncoder().encode('envelope-bytes'));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const response = await relayFetch(
        request(method, path, {
          body: upload,
          duplex: 'half',
          headers: { Authorization: 'Bearer signed-by-the-daemon', 'Content-Type': 'application/octet-stream' },
        } as RequestInit),
        environment({ LINK_STORE: fake.binding }),
      );
      should(await response.text()).equal('stored');
      should(arrivals).eql([
        { authorization: 'Bearer signed-by-the-daemon', bodyPulledOnArrival: false, body: 'envelope-bytes' },
      ]);
    }
  });

  it('should hand the store the discovery host a daemon signed, never an internal one', async () => {
    const fake = store(() => new Response('ok'));
    await relayFetch(request('POST', '/v1/link-store/status'), environment({ LINK_STORE: fake.binding }));
    should(new URL(fake.received[0]?.url ?? '').host).equal('relay.example');
  });

  it('should stream the upload body through without reading it', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fake = store(async seen => new Response(new Uint8Array(await seen.arrayBuffer())));
    const response = await relayFetch(
      request('PUT', linkBundlePath(bundleId), { body, headers: { 'Content-Type': 'application/octet-stream' } }),
      environment({ LINK_STORE: fake.binding }),
    );
    should(new Uint8Array(await response.arrayBuffer())).eql(body);
    should(fake.received[0]?.headers.get('Content-Type')).equal('application/octet-stream');
  });

  it("should return the store's answer untouched, including its status, headers and refusals", async () => {
    const fake = store(
      () => new Response('{"error":"x"}', { status: 410, headers: { 'X-Store': 'yes', 'Cache-Control': 'no-store' } }),
    );
    const response = await relayFetch(
      request('POST', linkFetchPath(bundleId)),
      environment({ LINK_STORE: fake.binding }),
    );
    should(response.status).equal(410);
    should(response.headers.get('X-Store')).equal('yes');
    should(await response.text()).equal('{"error":"x"}');
  });

  it('should answer the module default the platform loads the same way', async () => {
    const fake = store(() => new Response('default export'));
    const response = await relayWorker.fetch(
      request('GET', '/v1/link-store'),
      environment({ LINK_STORE: fake.binding }),
    );
    should(await response.text()).equal('default export');
  });

  it('should advertise the store as unavailable when the binding throws on the advertisement', async () => {
    const fake = store(() => {
      throw new Error('the store worker is not deployed');
    });
    const response = await relayFetch(request('GET', '/v1/link-store'), environment({ LINK_STORE: fake.binding }));
    should(response.status).equal(200);
    should(response.headers.get('Access-Control-Allow-Origin')).equal('*');
    should(response.headers.get('Cache-Control')).equal('no-store, max-age=0');
    should(LinkStoreAdvertisementSchema.parse(await response.json()).available).be.false();
  });

  it("should refuse every other path in the store's own words when the binding throws", async () => {
    const fake = store(() => {
      throw new Error('the store worker is not deployed');
    });
    const response = await relayFetch(
      request('POST', linkPeekPath(bundleId)),
      environment({ LINK_STORE: fake.binding }),
    );
    should(response.status).equal(503);
    should(response.headers.get('Access-Control-Allow-Origin')).equal('*');
    const body = (await response.json()) as { error: { code: string } };
    should(body.error.code).equal('link_store_unavailable');
  });

  it('should never forward a path the store does not own', async () => {
    const fake = store(() => new Response('should not be asked'));
    const response = await relayFetch(request('GET', '/v1/links'), environment({ LINK_STORE: fake.binding }));
    should(response.status).equal(404);
    should(fake.received).have.length(0);
  });
});

describe('the hosted relay without a LINK_STORE binding', () => {
  guarantee(
    ['R138'],
    'should advertise the store as unavailable, readable from a browser, and cached nowhere',
    async () => {
      const response = await relayFetch(request('GET', '/v1/link-store'), environment());
      should(response.status).equal(200);
      should(response.headers.get('Access-Control-Allow-Origin')).equal('*');
      should(response.headers.get('Cache-Control')).equal('no-store, max-age=0');
      const advertisement = LinkStoreAdvertisementSchema.parse(await response.json());
      should(advertisement.available).be.false();
    },
  );

  it('should answer a preflight for the advertisement', async () => {
    const response = await relayFetch(request('OPTIONS', '/v1/link-store'), environment());
    should(response.status).equal(204);
    should(response.headers.get('Access-Control-Allow-Methods')).equal('GET, OPTIONS');
  });

  it('should refuse a wrong method on the advertisement as not found', async () => {
    const response = await relayFetch(request('POST', '/v1/link-store'), environment());
    should(response.status).equal(404);
  });

  it('should answer every other store path with a plain 404 and allocate nothing', async () => {
    for (const [method, path] of STORE_PATHS.filter(([, path]) => path !== '/v1/link-store')) {
      const response = await relayFetch(request(method, path), environment());
      should(response.status).equal(404);
      should(await response.text()).equal('not found');
    }
  });

  it('should hand the direct hosted function the same answers', async () => {
    const response = await hostedLinkStoreFetch(request('GET', '/v1/link-store'), {});
    should(response.status).equal(200);
  });
});

describe('a relay that is not hosted', () => {
  for (const mode of [undefined, 'self-hosted'] as const) {
    it(`should leave a relay with RELAY_MODE ${mode === undefined ? 'unset' : `"${mode}"`} byte-identical: the store paths are the same 404 as any unknown path, the binding never read`, async () => {
      const selfHosted = unreadableBinding(mode);
      for (const [method, path] of STORE_PATHS) {
        const expected = await relayFetch(request(method, '/v1/something-else'), selfHosted);
        const actual = await relayFetch(request(method, path), selfHosted);
        should(actual.status).equal(404);
        should(await actual.text()).equal(await expected.text());
        should([...actual.headers]).eql([...expected.headers]);
      }
    });
  }

  it('should refuse a deployment mode it does not know before the binding is read', async () => {
    const response = await relayFetch(request('GET', '/v1/link-store'), unreadableBinding('staging'));
    should(response.status).equal(503);
  });
});

function guarantee(ids: readonly string[], name: string, run: () => void | Promise<unknown>): void {
  for (const id of ids) it(`${id} ${name}`, run);
}
