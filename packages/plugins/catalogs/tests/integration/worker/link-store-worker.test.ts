import { describe, it } from 'bun:test';
import should from 'should';
import {
  DEFAULT_LINK_STORE_LIMITS,
  LINK_STORE_CHALLENGE_PATH,
  LINK_STORE_SERVICE_PATH,
  LINK_STORE_STATUS_PATH,
  linkBundlePath,
  linkFetchPath,
  linkPeekPath,
  linkStoreRefusalBody,
  toBase64Url,
} from '../../../worker/src/lib/index.ts';
import { LINK_JSON_MAX_BYTES } from '../../../worker/src/adapters/index.ts';
import linkStoreWorker from '../../../worker/src/adapters/link-store-worker.ts';
import { newDaemonIdentity, relayCrypto } from '../../support/worker/identities.ts';
import {
  bytesOf,
  DAY,
  HOUR,
  LinkStoreClient,
  type LinkStoreWorld,
  linkStoreWorld,
  MINUTE,
  newBundleId,
  type WorldOptions,
} from '../../support/worker/link-store-fakes.ts';

const MIB = 1024 * 1024;
/** The largest upload body the Worker reads: the metadata's cap, its length prefix and the biggest envelope. */
const UPLOAD_MAX = 4096 + 4 + 3 * MIB;

const json = async <T = Record<string, unknown>>(response: Response): Promise<T> => (await response.json()) as T;
const refusal = async (response: Response): Promise<string> =>
  (await json<{ error: { code: string } }>(response)).error.code;
const bytesFrom = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer());
const same = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected it to exist');
  return value;
};
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

const GONE = linkStoreRefusalBody('link_gone');

describe('link store worker: a link from upload to end', () => {
  it('should take a public link, show it, hand it over, report it and end it', async () => {
    const { world, client } = await plain();
    should(await json(await world.advertisement())).deepEqual({
      version: 1,
      available: true,
      maxEnvelopeBytes: 3 * MIB,
      maxLiveLinks: 50,
    });

    const challenge = await client.challenge();
    should(challenge.status).equal(200);
    const issued = await json<{ version: number; nonce: string; deadlineSeconds: number }>(challenge);
    should(issued.version).equal(1);
    should(issued.deadlineSeconds).equal(60);
    should(issued.nonce).have.length(43);

    const up = await client.upload({ nonce: issued.nonce, bytes: 20_000 });
    should(up.response.status).equal(200);
    should(await json(up.response)).deepEqual({ version: 1, sequence: 1 });

    const peek = await world.open('peek', up.bundleId, up.token);
    should(peek.status).equal(200);
    should(await json(peek)).deepEqual({ version: 1, kind: 'public' });

    for (let round = 0; round < 2; round += 1) {
      const fetched = await world.open('fetch', up.bundleId, up.token);
      should(fetched.status).equal(200);
      should(fetched.headers.get('Content-Type')).equal('application/octet-stream');
      should(fetched.headers.get('X-Ferretry-Link-Kind')).equal('public');
      should(fetched.headers.get('X-Ferretry-Link-Sequence')).equal('1');
      should(same(await bytesFrom(fetched), up.envelope)).be.true();
    }

    const status = await json<{ links: { state: string; kind: string; sequence: number; storedBytes: number }[] }>(
      await client.status([up.bundleId]),
    );
    should(status.links[0]).containEql({ state: 'live', kind: 'public', sequence: 1, storedBytes: 20_000 });

    const removed = await client.remove(up.bundleId);
    should(removed.status).equal(200);
    should(await json(removed)).deepEqual({ version: 1 });
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'ended' });
    should(await bytesOf(await world.open('fetch', up.bundleId, up.token))).containEql({ status: 410, text: GONE });
    should((await client.remove(up.bundleId)).status).equal(200);
    finish(world);
  });

  it('should hand a one-time link over once and then be gone', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ kind: 'one-time' });
    should(up.response.status).equal(200);
    const fetched = await world.open('fetch', up.bundleId, up.token);
    should(fetched.status).equal(200);
    should(fetched.headers.get('X-Ferretry-Link-Kind')).equal('one-time');
    should(same(await bytesFrom(fetched), up.envelope)).be.true();
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(410);
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'used' });
    should(world.bundle(up.bundleId)?.keys('chunk:')).deepEqual([]);
    const view = await world.view();
    should(view.metrics).deepEqual({ owners: 1, liveLinks: 0, storedBytes: 0, tombstones: 1 });
    finish(world);
  });

  it('should store a 1.3 MiB envelope in rows of at most 512 KiB and read it back identical', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ bytes: 1_363_149 });
    should(up.response.status).equal(200);
    const storage = defined(world.bundle(up.bundleId));
    should(storage.keys('chunk:')).deepEqual(['chunk:0', 'chunk:1', 'chunk:2']);
    for (const key of storage.keys('chunk:')) {
      should((storage.values.get(key) as Uint8Array).byteLength).be.belowOrEqual(512 * 1024);
    }
    should(same(await bytesFrom(await world.open('fetch', up.bundleId, up.token)), up.envelope)).be.true();

    const biggest = await client.upload({
      bundleId: up.bundleId,
      action: 'replace',
      sequence: 2,
      expectSequence: 1,
      bytes: 3 * MIB,
      mangle: body => body,
    });
    should(biggest.response.status).equal(200);
    should(storage.keys('chunk:')).have.length(6);
    const grown = await world.open('fetch', up.bundleId, biggest.token);
    should(grown.headers.get('X-Ferretry-Link-Sequence')).equal('2');
    should(same(await bytesFrom(grown), biggest.envelope)).be.true();

    const smallest = await client.upload({
      bundleId: up.bundleId,
      action: 'replace',
      sequence: 3,
      expectSequence: 2,
      bytes: 100_000,
    });
    should(smallest.response.status).equal(200);
    should(storage.keys('chunk:')).deepEqual(['chunk:0']);
    should(same(await bytesFrom(await world.open('fetch', up.bundleId, smallest.token)), smallest.envelope)).be.true();
    finish(world);
  });

  it('should give exactly one of 50 concurrent fetches of a one-time link its bytes', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ kind: 'one-time' });
    const answers = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        world.open('fetch', up.bundleId, up.token, { ip: `10.0.0.${index + 1}` }),
      ),
    );
    const won = answers.filter(answer => answer.status === 200);
    should(won).have.length(1);
    should(same(await bytesFrom(defined(won[0])), up.envelope)).be.true();
    const lost = await Promise.all(answers.filter(answer => answer.status !== 200).map(bytesOf));
    should(lost).have.length(49);
    for (const answer of lost) should(answer).deepEqual({ ...defined(lost[0]), text: GONE });
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'used' });
    finish(world);
  });
});

describe('link store worker: what the alarms delete', () => {
  it('should end a lapsed link, free its lease, revive it for its owner and purge it after the tombstone', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ lastsMs: HOUR });
    const id = up.bundleId;
    const due = world.control.keys('due:');
    should(due.some(key => key.endsWith(`:l:${id}`))).be.true();
    should(due.some(key => key.endsWith(`:o:${client.daemonId}`))).be.true();
    should(world.bundle(id)?.alarm).equal(Date.parse(up.metadata.notAfter));
    should(defined(world.owner(client.daemonId)).alarm).not.be.null();

    world.advance(HOUR);
    should(await world.fireAlarms()).be.above(0);
    should(await client.states([id])).deepEqual({ [id]: 'lapsed' });
    should(world.bundle(id)?.keys('chunk:')).deepEqual([]);
    should((defined(world.owner(client.daemonId)).values.get('shard') as { leases: object }).leases).deepEqual({});
    should(world.control.values.get(`link:${id}`)).containEql({ phase: 'tomb' });
    should((await world.view()).metrics).containEql({ liveLinks: 0, tombstones: 1 });
    should((await world.open('fetch', id, up.token)).status).equal(410);

    const revived = await client.upload({ bundleId: id, sequence: 2, lastsMs: HOUR, token: undefined });
    should(revived.response.status).equal(200);
    should(await client.states([id])).deepEqual({ [id]: 'live' });
    should(world.control.values.get(`link:${id}`)).containEql({ phase: 'leased' });

    world.advance(HOUR);
    await world.fireAlarms();
    should(await client.states([id])).deepEqual({ [id]: 'lapsed' });

    world.advance(31 * DAY);
    await world.fireAlarms();
    should(world.bundle(id)?.values.size).equal(0);
    should(world.bundle(id)?.alarm).be.null();
    should(world.control.keys('link:')).deepEqual([]);
    should(world.control.keys('owner:')).deepEqual([]);
    should(world.control.keys('due:')).deepEqual([]);
    should(world.control.alarm).be.null();
    should(world.owner(client.daemonId)?.values.size).equal(0);
    should((await world.view()).metrics).deepEqual({ owners: 0, liveLinks: 0, storedBytes: 0, tombstones: 0 });
    should(await client.states([id])).deepEqual({ [id]: 'unknown' });
    finish(world);
  });

  it('should end a link at its owner chosen end rather than lapse it', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ lastsMs: HOUR, expiresInMs: HOUR });
    world.advance(HOUR);
    await world.fireAlarms();
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'ended' });
    finish(world);
  });

  it('should free the quota of a spent link at its end when the release was lost', async () => {
    const { world, client } = await plain();
    await world.limits({ perDaemon: { liveLinks: 1 } });
    const first = await client.upload({ kind: 'one-time' });
    world.faults.push(
      { target: 'owner', from: 'object', route: '/release', mode: 'throw' },
      { target: 'control', from: 'object', route: '/release', mode: 'throw' },
    );
    const fetched = await world.open('fetch', first.bundleId, first.token);
    should(fetched.status).equal(200);

    const blocked = await client.upload({ kind: 'one-time' });
    should(blocked.response.status).equal(409);
    should(await refusal(blocked.response)).equal('link_store_full');
    should((await world.view()).metrics.liveLinks).equal(1);
    should(world.control.keys('link:')).have.length(1);

    world.advance(HOUR + 1000);
    await world.fireAlarms();
    should((await world.view()).metrics.liveLinks).equal(0);
    const second = await client.upload({ kind: 'one-time' });
    should(second.response.status).equal(200);
    should((await world.view()).metrics).containEql({ liveLinks: 1, tombstones: 1 });
    finish(world);
  });

  it('should still hand over a one-time link whose release calls reject', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ kind: 'one-time' });
    world.faults.push(
      { target: 'owner', from: 'object', mode: 'throw' },
      { target: 'control', from: 'object', mode: 'throw' },
    );
    const fetched = await world.open('fetch', up.bundleId, up.token);
    should(fetched.status).equal(200);
    should(same(await bytesFrom(fetched), up.envelope)).be.true();
    finish(world);
  });

  it('should still hand over a one-time link when the objects hold no binding to release through', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ kind: 'one-time' });
    world.missingFromObjects.add('owner').add('control');
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(200);
    world.missingFromObjects.clear();
    world.faults.push({ target: 'owner', from: 'object', mode: 'throw-sync' });
    const second = await client.upload({ kind: 'one-time' });
    should((await world.open('fetch', second.bundleId, second.token)).status).equal(200);
    finish(world);
  });
});

describe('link store worker: who it serves', () => {
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

  it('should serve a daemon it carries, listed among others', async () => {
    const me = await newDaemonIdentity();
    const other = await newDaemonIdentity();
    const world = await linkStoreWorld({ mode: 'self-hosted', daemonIds: `${other.daemonId}, ${me.daemonId}` });
    const client = new LinkStoreClient(world, me);
    const up = await client.upload({});
    should(up.response.status).equal(200);
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(200);
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'live' });
    finish(world);
  });
});

describe('link store worker: ids that were never created', () => {
  it('should answer an unknown id with the bytes of a wrong token and create no bundle object', async () => {
    const { world, client } = await plain();
    const known = await client.upload({});
    const unknownId = newBundleId();
    for (const action of ['peek', 'fetch'] as const) {
      const wrong = await bytesOf(await world.open(action, known.bundleId, randomToken()));
      const unknown = await bytesOf(await world.open(action, unknownId, randomToken()));
      should(unknown).deepEqual(wrong);
      should(unknown).containEql({ status: 410, text: GONE });
    }
    should(world.names('bundle')).deepEqual([`ferretry-link/1:${known.bundleId}`]);
    finish(world);
  });

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

  it('should answer 429 after the wrong-token window of a real id, and still serve the real token', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      should((await world.open('fetch', up.bundleId, randomToken())).status).equal(410);
    }
    should((await world.open('fetch', up.bundleId, randomToken())).status).equal(429);
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(200);
    finish(world);
  });

  it('should hold one address to 60 opens a minute, and send an unreadable address to one shared bucket', async () => {
    const { world } = await plain();
    for (let attempt = 0; attempt < 60; attempt += 1) {
      should((await world.open('peek', newBundleId(), randomToken())).status).equal(410);
    }
    should((await world.open('peek', newBundleId(), randomToken())).status).equal(429);
    const long = await world.open('peek', newBundleId(), randomToken(), { ip: '9'.repeat(70) });
    should(long.status).equal(429);
    should((await world.open('peek', newBundleId(), randomToken(), { ip: '203.0.113.9' })).status).equal(410);
    world.advance(MINUTE + 1000);
    should((await world.open('peek', newBundleId(), randomToken())).status).equal(410);
    finish(world);
  });
});

describe('link store worker: bodies are bounded', () => {
  it('should refuse an upload larger than the largest envelope with a 413 before any object', async () => {
    const { world } = await plain({ relaxed: false });
    const id = newBundleId();
    const real = await world.call('PUT', linkBundlePath(id), { body: new Uint8Array(UPLOAD_MAX + 1) });
    should(real.status).equal(413);
    should(await refusal(real)).equal('link_too_big');
    const declared = await world.call('PUT', linkBundlePath(id), {
      body: new Uint8Array(10),
      contentLength: UPLOAD_MAX + 1,
    });
    should(declared.status).equal(413);
    const lied = await world.call('PUT', linkBundlePath(id), {
      body: new Uint8Array(UPLOAD_MAX + 1),
      contentLength: 10,
    });
    should(lied.status).equal(413);
    should(world.created).equal(0);
    finish(world);
  });

  it('should refuse a signed JSON body that is too large or unreadable with a 400, never a 413', async () => {
    const { world } = await plain({ relaxed: false });
    const big = { pad: 'x'.repeat(LINK_JSON_MAX_BYTES + 1) };
    const id = newBundleId();
    const attempts = [
      await world.json('POST', LINK_STORE_CHALLENGE_PATH, big),
      await world.json('POST', LINK_STORE_STATUS_PATH, big),
      await world.json('DELETE', linkBundlePath(id), big),
      await world.call('POST', LINK_STORE_CHALLENGE_PATH, { body: '{' }),
      await world.call('POST', LINK_STORE_STATUS_PATH, { body: '{}' }),
      await world.call('DELETE', linkBundlePath(id), { body: '"nothing"' }),
      await world.call('POST', LINK_STORE_CHALLENGE_PATH, {
        body: 'x'.repeat(LINK_JSON_MAX_BYTES + 1),
        contentLength: 10,
      }),
      await world.call('POST', LINK_STORE_CHALLENGE_PATH, { body: '{}', contentLength: LINK_JSON_MAX_BYTES + 1 }),
    ];
    for (const response of attempts) {
      should(response.status).equal(400);
      should(await refusal(response)).equal('link_bad_request');
    }
    should(world.created).equal(0);
    finish(world);
  });

  it('R697 should refuse a malformed upload frame with a 400', async () => {
    const { world, client } = await plain();
    const frames: ((body: Uint8Array) => Uint8Array)[] = [
      () => new Uint8Array(3),
      body => body.subarray(0, 4),
      body => {
        const copy = body.slice();
        new DataView(copy.buffer).setUint32(0, 9999, false);
        return copy;
      },
      body => {
        const copy = body.slice();
        copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
        return copy;
      },
    ];
    for (const mangle of frames) {
      const up = await client.upload({ mangle });
      should(up.response.status).equal(400);
      should(await refusal(up.response)).equal('link_bad_request');
    }
    finish(world);
  });
});

describe('link store worker: routes and methods', () => {
  it('should answer a wrong method with a 405 and the methods the route does take', async () => {
    const { world } = await plain();
    const id = newBundleId();
    const cases: [string, string, string][] = [
      ['POST', LINK_STORE_SERVICE_PATH, 'GET, OPTIONS'],
      ['GET', LINK_STORE_CHALLENGE_PATH, 'POST, OPTIONS'],
      ['GET', LINK_STORE_STATUS_PATH, 'POST, OPTIONS'],
      ['GET', linkBundlePath(id), 'PUT, DELETE, OPTIONS'],
      ['GET', linkPeekPath(id), 'POST, OPTIONS'],
      ['PUT', linkFetchPath(id), 'POST, OPTIONS'],
    ];
    for (const [method, path, allow] of cases) {
      const response = await world.call(method, path);
      should(response.status).equal(405);
      should(response.headers.get('Allow')).equal(allow);
      should(await refusal(response)).equal('link_bad_request');
    }
    finish(world);
  });

  it('should answer a path or an id it does not know with a 404', async () => {
    const { world } = await plain();
    for (const path of ['/', '/v1/nothing', '/v1/links/short', `/v1/links/${newBundleId()}/other`, '/v1/links/']) {
      const response = await world.call('GET', path);
      should(response.status).equal(404);
      should(await refusal(response)).equal('link_unknown');
    }
    finish(world);
  });

  it('should answer OPTIONS with a 204 on a public path', async () => {
    const { world } = await plain({ relaxed: false });
    for (const path of [LINK_STORE_SERVICE_PATH, LINK_STORE_CHALLENGE_PATH, linkFetchPath(newBundleId())]) {
      const response = await world.call('OPTIONS', path);
      should(response.status).equal(204);
      should(response.headers.get('Access-Control-Allow-Methods')).equal('GET, POST, PUT, DELETE, OPTIONS');
      should(await response.text()).equal('');
    }
    should(world.created).equal(0);
    finish(world);
  });
});

describe('link store worker: one answer to every failed open', () => {
  it('should answer every cause of a failed peek or fetch with the same bytes', async () => {
    const { world, client } = await plain();
    const used = await client.upload({ kind: 'one-time', lastsMs: 3 * HOUR });
    should((await world.open('fetch', used.bundleId, used.token)).status).equal(200);
    const ended = await client.upload({});
    await client.remove(ended.bundleId);
    const capped = await client.upload({ installCap: 1 });
    should((await world.open('fetch', capped.bundleId, capped.token)).status).equal(200);
    const lapsed = await client.upload({ lastsMs: HOUR });
    const expired = await client.upload({ lastsMs: 2 * HOUR });
    const live = await client.upload({});
    world.advance(HOUR);
    await world.fireAlarms();
    world.advance(HOUR);

    const reference = await bytesOf(await world.open('fetch', newBundleId(), randomToken()));
    should(reference).containEql({ status: 410, text: GONE });

    const links = { used, ended, capped, lapsed, expired };
    for (const action of ['peek', 'fetch'] as const) {
      should(await bytesOf(await world.open(action, newBundleId(), randomToken()))).deepEqual(reference);
      should(await bytesOf(await world.open(action, live.bundleId, randomToken()))).deepEqual(reference);
      for (const link of Object.values(links)) {
        should(await bytesOf(await world.open(action, link.bundleId, link.token))).deepEqual(reference);
      }
      const bodies = [
        'not json',
        '{}',
        '{"token":"abc"}',
        JSON.stringify({ token: live.token, extra: 1 }),
        'x'.repeat(LINK_JSON_MAX_BYTES + 1),
      ];
      const path = action === 'peek' ? linkPeekPath(live.bundleId) : linkFetchPath(live.bundleId);
      for (const body of bodies) should(await bytesOf(await world.call('POST', path, { body }))).deepEqual(reference);
    }
    should(await client.states([used, ended, capped, lapsed, expired].map(link => link.bundleId))).deepEqual({
      [used.bundleId]: 'used',
      [ended.bundleId]: 'ended',
      [capped.bundleId]: 'live',
      [lapsed.bundleId]: 'lapsed',
      [expired.bundleId]: 'lapsed',
    });
    finish(world);
  });
});

describe('link store worker: headers and logs', () => {
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

  it('should log a fixed sentence when a binding is missing', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    const response = await world.open('fetch', up.bundleId, up.token, {
      environment: world.environment({ omit: ['bundle'] }),
    });
    should(response.status).equal(503);
    should(await refusal(response)).equal('link_store_unavailable');
    should(world.logs).deepEqual(['link store: a request failed unexpectedly']);
    finish(world);
  });

  it('should log a fixed sentence, naming no one, when a bundle object throws', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    world.faults.push({ target: 'bundle', route: '/fetch', mode: 'throw' });
    const response = await world.open('fetch', up.bundleId, up.token, { ip: '198.51.100.7' });
    should(response.status).equal(503);
    should(world.logs).deepEqual(['link store: a request failed unexpectedly']);
    finish(world);
  });

  it('should log which object found its stored state damaged, and nothing it holds', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});

    defined(world.bundle(up.bundleId)).values.set('doc', { garbage: true });
    const bundle = await world.open('fetch', up.bundleId, up.token);
    should(bundle.status).equal(503);
    should(world.logs.splice(0)).deepEqual(['link store: a bundle object failed because its stored state is damaged']);

    world.control.values.set('state', { garbage: true });
    should((await client.challenge()).status).equal(503);
    should(world.logs.splice(0)).deepEqual([
      'link store: the control object failed because its stored state is damaged',
    ]);
    world.control.values.delete('state');

    defined(world.owner(client.daemonId)).values.set('shard', { garbage: true });
    should((await client.challenge()).status).equal(503);
    should(world.logs.splice(0)).deepEqual(['link store: an owner object failed because its stored state is damaged']);
    finish(world);
  });
});

describe('link store worker: delete and status', () => {
  it('should know nothing of another daemon link or of an id nobody made', async () => {
    const { world, client } = await plain();
    const other = new LinkStoreClient(world, await newDaemonIdentity());
    const up = await client.upload({});
    const stray = newBundleId();

    should(await other.states([up.bundleId, stray])).deepEqual({ [up.bundleId]: 'unknown', [stray]: 'unknown' });
    const taken = await other.remove(up.bundleId);
    should(taken.status).equal(404);
    should(await refusal(taken)).equal('link_unknown');
    should((await other.remove(stray)).status).equal(404);
    should(world.names('bundle')).deepEqual([`ferretry-link/1:${up.bundleId}`]);
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'live' });
    finish(world);
  });

  it('should report a repeated id once', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    const answer = await json<{ links: unknown[] }>(await client.status([up.bundleId, up.bundleId]));
    should(answer.links).have.length(1);
    finish(world);
  });

  it('should report unknown for a link whose bundle object cannot answer', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    for (const mode of ['throw', 'garble'] as const) {
      world.faults.push({ target: 'bundle', route: '/status', mode });
      should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'unknown' });
      world.faults.length = 0;
    }
    finish(world);
  });

  it('should answer 503 to a delete its bundle object cannot take', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    world.faults.push({ target: 'bundle', route: '/delete', mode: 'throw' });
    const response = await client.remove(up.bundleId);
    should(response.status).equal(503);
    should(await refusal(response)).equal('link_store_unavailable');
    world.faults.length = 0;
    should(await client.states([up.bundleId])).deepEqual({ [up.bundleId]: 'live' });
    finish(world);
  });
});

describe('link store worker: replace and rollback', () => {
  const ledger = (world: LinkStoreWorld, daemonId: string, bundleId: string) => {
    const shard = defined(world.owner(daemonId)).values.get('shard') as {
      leases: Record<string, unknown>;
      uploads: { count: number };
    };
    const state = world.control.values.get('state') as { totals: unknown; uploads: { count: number } };
    return {
      leases: shard.leases,
      ownerUploads: shard.uploads.count,
      totals: state.totals,
      controlUploads: state.uploads.count,
      record: world.control.values.get(`link:${bundleId}`),
      due: world.control.keys('due:'),
    };
  };

  it('should answer 409 to a replace of the wrong sequence and put the quota back', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ bytes: 20_000 });
    const before = ledger(world, client.daemonId, up.bundleId);
    const conflict = await client.upload({
      bundleId: up.bundleId,
      action: 'replace',
      sequence: 5,
      expectSequence: 4,
      bytes: 40_000,
    });
    should(conflict.response.status).equal(409);
    should(await refusal(conflict.response)).equal('link_sequence_conflict');
    should(ledger(world, client.daemonId, up.bundleId)).deepEqual(before);
    should(same(await bytesFrom(await world.open('fetch', up.bundleId, up.token)), up.envelope)).be.true();
    finish(world);
  });

  it('should answer 404 to a replace of an id it never stored, and 409 to a create of one it has', async () => {
    const { world, client } = await plain();
    const missing = await client.upload({ bundleId: newBundleId(), action: 'replace', sequence: 2, expectSequence: 1 });
    should(missing.response.status).equal(404);
    should(await refusal(missing.response)).equal('link_unknown');
    const up = await client.upload({});
    const again = await client.upload({ bundleId: up.bundleId });
    should(again.response.status).equal(409);
    should(await refusal(again.response)).equal('link_exists');
    finish(world);
  });

  it('should undo the reservation when the bundle object rejects the upload', async () => {
    const { world, client } = await plain();
    const rejected = await client.upload({ sequence: 1, envelopeSequence: 2 });
    should(rejected.response.status).equal(400);
    should(await refusal(rejected.response)).equal('link_bad_request');
    should(world.control.keys('link:')).deepEqual([]);
    should(world.control.keys('due:').some(key => key.includes(':l:'))).be.false();
    should((await world.view()).metrics).containEql({ liveLinks: 0, storedBytes: 0, tombstones: 0 });
    const shard = defined(world.owner(client.daemonId)).values.get('shard') as {
      leases: object;
      uploads: { count: number };
    };
    should(shard.leases).deepEqual({});
    should(shard.uploads.count).equal(0);
    finish(world);
  });

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

describe('link store worker: guarantee rows', () => {
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

describe('link store worker: the operator', () => {
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

  it('should show the view, and take a switch or the whole limits', async () => {
    const { world } = await plain({ relaxed: false });
    const view = await world.operator('GET');
    should(view.status).equal(200);
    should(view.headers.get('Cache-Control')).equal('no-store, max-age=0');
    should(await json(view)).deepEqual({
      available: true,
      serving: true,
      limits: DEFAULT_LINK_STORE_LIMITS,
      metrics: { owners: 0, liveLinks: 0, storedBytes: 0, tombstones: 0 },
    });

    should(await json(await world.operator('PUT', { available: false }))).containEql({
      available: false,
      serving: true,
    });
    should(await json(await world.operator('PUT', { serving: false }))).containEql({
      available: false,
      serving: false,
    });
    const limits = {
      ...DEFAULT_LINK_STORE_LIMITS,
      perDaemon: { ...DEFAULT_LINK_STORE_LIMITS.perDaemon, liveLinks: 7 },
    };
    const put = await world.operator('PUT', { available: true, serving: true, limits });
    should(await json(put)).containEql({ available: true, serving: true, limits });
    should((await world.view()).limits.perDaemon.liveLinks).equal(7);
    should(await json(await world.advertisement())).containEql({ available: true, maxLiveLinks: 7 });
  });

  it('should refuse a body that names nothing, is not JSON, is partial limits or is too large with a 400', async () => {
    const { world } = await plain({ relaxed: false });
    const bodies = [
      '{}',
      '{',
      '"text"',
      JSON.stringify({ limits: { perDaemon: { liveLinks: 7 } } }),
      JSON.stringify({ available: 'yes' }),
      JSON.stringify({ pad: 'x'.repeat(LINK_JSON_MAX_BYTES + 1) }),
    ];
    for (const body of bodies) {
      const response = await world.operator('PUT', body);
      should(response.status).equal(400);
      should(await response.json()).have.property('error');
    }
  });

  it('should answer 405 with the methods it takes to any other method', async () => {
    const { world } = await plain({ relaxed: false });
    const response = await world.operator('DELETE');
    should(response.status).equal(405);
    should(response.headers.get('Allow')).equal('GET, PUT');
  });

  it('should answer 503 when the control object cannot be reached or answers nonsense', async () => {
    const { world } = await plain({ relaxed: false });
    const missing = await world.operator('GET', undefined, undefined, {
      environment: world.environment({ omit: ['control'] }),
    });
    should(missing.status).equal(503);
    for (const mode of ['throw', 'garble'] as const) {
      world.faults.push({ target: 'control', mode });
      should((await world.operator('GET')).status).equal(503);
      should((await world.operator('PUT', { available: true })).status).equal(503);
      world.faults.length = 0;
    }
  });
});

describe('link store worker: the kill switches', () => {
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

describe('link store worker: who may sign', () => {
  it('should reject a signature from a key that is not the claimed daemon', async () => {
    const { world, client } = await plain();
    const up = await client.upload({ signWith: await newDaemonIdentity() });
    should(up.response.status).equal(401);
    should(await refusal(up.response)).equal('link_claim_rejected');
    should(world.control.keys('link:')).deepEqual([]);
    finish(world);
  });

  it('should spend a nonce on its first use and refuse it after', async () => {
    const { world, client } = await plain();
    const nonce = await client.nonce();
    should((await client.upload({ nonce })).response.status).equal(200);
    const again = await client.upload({ nonce });
    should(again.response.status).equal(401);
    should(await refusal(again.response)).equal('link_challenge_expired');
    finish(world);
  });

  it('R698 should refuse a daemon that never asked for a nonce before it creates an object for it', async () => {
    const { world, client } = await plain();
    const stranger = new LinkStoreClient(world, await newDaemonIdentity());
    const up = await stranger.upload({ nonce: toBase64Url(new Uint8Array(32).fill(7)) });
    should(up.response.status).equal(401);
    should(await refusal(up.response)).equal('link_challenge_expired');
    should(world.owner(stranger.daemonId)).be.undefined();
    should(client.daemonId).not.equal(stranger.daemonId);
    finish(world);
  });

  it('should refuse a fourth unspent nonce and a challenge storm', async () => {
    const { world, client } = await plain({ relaxed: false });
    for (let issued = 0; issued < 3; issued += 1) should((await client.challenge()).status).equal(200);
    const fourth = await client.challenge();
    should(fourth.status).equal(429);
    should(await refusal(fourth)).equal('link_rate_limited');
    finish(world);
  });

  it('should refuse a new link when the store as a whole is full', async () => {
    const { world, client } = await plain();
    await world.limits({ global: { liveLinks: 1 } });
    should((await client.upload({})).response.status).equal(200);
    const second = new LinkStoreClient(world, await newDaemonIdentity());
    const full = await second.upload({});
    should(full.response.status).equal(503);
    should(await refusal(full.response)).equal('link_store_capacity');
    finish(world);
  });
});

describe('link store worker: an object that fails', () => {
  it('should say 503 when a challenge cannot reach, or is refused by, control or owner', async () => {
    const { world, client } = await plain();
    const faults = [
      { target: 'control', route: '/challenge', mode: 'garble' },
      { target: 'control', route: '/challenge', mode: 'refuse' },
      { target: 'owner', route: '/challenge', mode: 'garble' },
      { target: 'owner', route: '/challenge', mode: 'refuse' },
      { target: 'control', route: '/challenge', mode: 'throw' },
    ] as const;
    for (const fault of faults) {
      world.faults.push(fault);
      const response = await client.challenge();
      should(response.status).equal(503);
      should(await refusal(response)).equal('link_store_unavailable');
      world.faults.length = 0;
    }
    for (const omit of ['control', 'owner'] as const) {
      should((await client.challenge({ environment: world.environment({ omit: [omit] }) })).status).equal(503);
    }
    finish(world);
  });

  it('should fall back to not available when the advertisement cannot be read', async () => {
    const { world } = await plain();
    const fallback = { version: 1, available: false, maxEnvelopeBytes: 3 * MIB, maxLiveLinks: 50 };
    should(
      await json(
        await world.call('GET', LINK_STORE_SERVICE_PATH, { environment: world.environment({ omit: ['control'] }) }),
      ),
    ).deepEqual(fallback);
    world.faults.push({ target: 'control', route: '/service', mode: 'garble' });
    should(await json(await world.advertisement())).deepEqual(fallback);
    finish(world);
  });

  it('should say 503 to an upload when control or the owner cannot take part', async () => {
    const { world, client } = await plain();
    const nonceThen = (environment: ReturnType<LinkStoreWorld['environment']>) =>
      client.nonce().then(nonce => client.upload({ nonce, environment }));

    should((await nonceThen(world.environment({ omit: ['control'] }))).response.status).equal(503);
    should((await nonceThen(world.environment({ omit: ['owner'] }))).response.status).equal(503);
    for (const mode of ['garble', 'refuse'] as const) {
      world.faults.push({ target: 'control', route: '/reserve', mode });
      const up = await client.upload({});
      should(up.response.status).equal(503);
      world.faults.length = 0;
    }
    world.faults.push({ target: 'control', route: '/admit', mode: 'refuse' });
    should((await client.upload({})).response.status).equal(503);
    // Only the garbled reserve committed before its answer was lost; its lease is settled by the control alarm.
    should(world.control.keys('link:')).have.length(1);
    finish(world);
  });

  it('should say 503 to a delete or a status when control cannot say who owns the link', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    for (const mode of ['garble', 'refuse'] as const) {
      world.faults.push({ target: 'control', route: '/owned', mode });
      should((await client.remove(up.bundleId)).status).equal(503);
      should((await client.status([up.bundleId])).status).equal(503);
      world.faults.length = 0;
    }
    world.faults.push({ target: 'control', route: '/admit', mode: 'garble' });
    should((await client.remove(up.bundleId)).status).equal(503);
    finish(world);
  });

  it('should say 503 to an open when control cannot decide, and still hand over when it cannot count', async () => {
    const { world, client } = await plain();
    const up = await client.upload({});
    for (const mode of ['garble', 'refuse'] as const) {
      world.faults.push({ target: 'control', route: '/open', mode });
      should((await world.open('fetch', up.bundleId, up.token)).status).equal(503);
      world.faults.length = 0;
    }
    should(
      (await world.open('fetch', up.bundleId, up.token, { environment: world.environment({ omit: ['control'] }) }))
        .status,
    ).equal(503);
    world.faults.push({ target: 'control', route: '/fetched', mode: 'throw' });
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(200);
    finish(world);
  });

  it('should say 503 to a signed request whose nonce cannot be spent', async () => {
    const { world, client } = await plain();
    const nonce = await client.nonce();
    world.faults.push({ target: 'owner', route: '/spend', mode: 'garble' });
    should((await client.upload({ nonce })).response.status).equal(503);
    finish(world);
  });
});

describe('link store worker: the deployed entry', () => {
  it('should serve nobody from the default export when it has no mode', async () => {
    const response = await linkStoreWorker.fetch(
      new Request(`https://link.example.test${LINK_STORE_SERVICE_PATH}`),
      {},
    );
    should(response.status).equal(503);
  });
});
