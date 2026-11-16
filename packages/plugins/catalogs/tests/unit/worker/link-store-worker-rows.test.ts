import { describe, it } from 'bun:test';
import should from 'should';
import { toBase64Url } from '../../../worker/src/lib/index.ts';
import { newDaemonIdentity, relayCrypto } from '../../support/worker/identities.ts';
import {
  HOUR,
  LinkStoreClient,
  type LinkStoreWorld,
  linkStoreWorld,
  newBundleId,
  type WorldOptions,
} from '../../support/worker/link-store-fakes.ts';

// The link-store Worker's guarantee rows (Appendix D R699, R701, R703, R706-R710), against the in-process world of fakes.

const json = async <T = Record<string, unknown>>(response: Response): Promise<T> => (await response.json()) as T;
const refusal = async (response: Response): Promise<string> =>
  (await json<{ error: { code: string } }>(response)).error.code;
const randomToken = (): string => toBase64Url(relayCrypto.randomBytes(32));

async function plain(options: WorldOptions = {}) {
  const world = await linkStoreWorld(options);
  const client = new LinkStoreClient(world, await newDaemonIdentity());
  return { world, client };
}

/** Every public answer kept the header rules, and nothing was logged but the fixed sentences. */
const finish = (world: LinkStoreWorld): void => {
  world.assertPublicHeaders();
  world.assertLogsFixed();
};

describe('link store worker rows', () => {
  it('R703 should answer a daemon it does not carry with a 404 before any object exists', async () => {
    const stranger = await newDaemonIdentity();
    const carried = await newDaemonIdentity();
    const world = await linkStoreWorld({ mode: 'self-hosted', daemonIds: carried.daemonId, relaxed: false });
    const client = new LinkStoreClient(world, stranger);
    const nonce = toBase64Url(new Uint8Array(32));

    const refused = [
      await client.challenge(),
      (await client.upload({ nonce })).response,
      await client.remove(newBundleId(), { nonce }),
      await client.status([newBundleId()], { nonce }),
    ];
    for (const response of refused) {
      should(response.status).equal(404);
      should(await refusal(response)).equal('link_unknown');
    }
    should(world.created).equal(0);
    should(world.names('owner')).deepEqual([]);
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R701 should answer 429 after the wrong-token window of an unknown id, still with no bundle object', async () => {
    const { world } = await plain();
    const unknownId = newBundleId();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      should((await world.open('fetch', unknownId, randomToken())).status).equal(410);
    }
    const limited = await world.open('peek', unknownId, randomToken());
    should(limited.status).equal(429);
    should(await refusal(limited)).equal('link_rate_limited');
    should(world.names('bundle')).deepEqual([]);
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R708 should strip a Set-Cookie an object adds and keep the public headers', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    world.faults.push({ target: 'bundle', mode: 'cookie' });
    const fetched = await world.open('fetch', up.bundleId, up.token);
    should(fetched.status).equal(200);
    should(fetched.headers.get('Set-Cookie')).be.null();
    should(fetched.headers.get('Access-Control-Allow-Origin')).equal('*');
    should(fetched.headers.get('Cache-Control')).equal('no-store, max-age=0');
    should((await client.status([up.bundleId])).status).equal(200);
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R703 should serve nobody and say so once when the mode is not set', async () => {
    for (const mode of [undefined, 'sideways']) {
      const { world } = await plain({ mode, relaxed: false });
      const response = await world.advertisement();
      should(response.status).equal(503);
      should(await refusal(response)).equal('link_store_unavailable');
      should(world.logs).deepEqual(['link store: LINK_STORE_MODE is not hosted or self-hosted, so it serves nobody']);
      should(world.created).equal(0);
      finish(world);
    }
  });
});

describe('link store worker rows', () => {
  it('R699 should undo the reservation, and say 503, when a downstream object fails the upload', async () => {
    const { world, client } = await plain();
    const scenarios: { readonly faults: typeof world.faults; readonly environment?: 'no-bundle' }[] = [
      { faults: [{ target: 'bundle', route: '/upload', mode: 'throw' }] },
      { faults: [], environment: 'no-bundle' },
      { faults: [{ target: 'owner', route: '/reserve', mode: 'garble' }] },
      { faults: [{ target: 'owner', route: '/reserve', mode: 'refuse' }] },
      {
        faults: [
          { target: 'bundle', route: '/upload', mode: 'throw' },
          { target: 'owner', route: '/undo', mode: 'throw' },
        ],
      },
    ];
    for (const scenario of scenarios) {
      world.faults.push(...scenario.faults);
      const up = await client.upload(
        scenario.environment === undefined ? {} : { environment: world.environment({ omit: ['bundle'] }) },
      );
      should(up.response.status).equal(503);
      should(await refusal(up.response)).equal('link_store_unavailable');
      should(world.control.keys('link:')).deepEqual([]);
      should((await world.view()).metrics).containEql({ liveLinks: 0, storedBytes: 0 });
      world.faults.length = 0;
    }
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R709 the operator view holds counts only: no key, token, bundle id, daemon or installer', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ kind: 'one-time' });
    should((await world.open('fetch', up.bundleId, up.token, { ip: '203.0.113.9' })).status).equal(200);
    const response = await world.operator('GET');
    const text = await response.text();
    for (const secret of [up.token, up.bundleId, client.daemonId, '203.0.113.9'])
      should(text.includes(secret)).be.false();
    const view = JSON.parse(text) as { metrics: Record<string, unknown> };
    for (const value of Object.values(view.metrics)) should(typeof value).equal('number');
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R710 a lost release never lets an expired link serve', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ lastsMs: HOUR });
    world.faults.push(
      { target: 'owner', from: 'object', route: '/release', mode: 'throw' },
      { target: 'control', from: 'object', route: '/release', mode: 'throw' },
    );
    world.advance(HOUR + 1000);
    await world.fireAlarms();
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(410);
    should((await world.open('peek', up.bundleId, up.token)).status).equal(410);
    world.faults.length = 0;
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R706 should answer 503 when no operator token is set, and 401 to a wrong bearer', async () => {
    const { world } = await plain({ relaxed: false });
    for (const operatorToken of [undefined, '']) {
      const unset = await world.operator('GET', undefined, null, {
        environment: world.environment({ operatorToken }),
      });
      should(unset.status).equal(503);
    }
    const wrong = await world.operator('GET', undefined, 'not-the-token');
    should(wrong.status).equal(401);
    should(wrong.headers.get('WWW-Authenticate')).equal('Bearer');
    should((await world.operator('GET', undefined, null)).status).equal(401);
    should(world.created).equal(0);
  });
});

describe('link store worker rows', () => {
  it('R707 should refuse new links when not available, and still hand over the ones it has', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    const spare = await client.nonce();
    const forStatus = await client.nonce();
    const forDelete = await client.nonce();
    await world.operator('PUT', { available: false });

    should(await json(await world.advertisement())).containEql({ available: false });
    const challenge = await client.challenge();
    should(challenge.status).equal(503);
    should(await refusal(challenge)).equal('link_store_unavailable');
    const refused = await client.upload({ nonce: spare });
    should(refused.response.status).equal(503);
    should(await refusal(refused.response)).equal('link_store_unavailable');

    should((await world.open('peek', up.bundleId, up.token)).status).equal(200);
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(200);
    const states = await json<{ links: { state: string }[] }>(await client.status([up.bundleId], { nonce: forStatus }));
    should(states.links.map(link => link.state)).deepEqual(['live']);
    should((await client.remove(up.bundleId, { nonce: forDelete })).status).equal(200);
    finish(world);
  });
});

describe('link store worker rows', () => {
  it('R707 should hand nothing over when not serving', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    await world.operator('PUT', { serving: false });
    for (const action of ['peek', 'fetch'] as const) {
      const response = await world.open(action, up.bundleId, up.token);
      should(response.status).equal(503);
      should(await refusal(response)).equal('link_store_unavailable');
    }
    should(await json(await world.advertisement())).containEql({ available: false });
    await world.operator('PUT', { serving: true });
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(200);
    finish(world);
  });
});
