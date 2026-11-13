import { describe, it } from 'bun:test';
import should from 'should';
import {
  LinkBundleDurableObject,
  LinkOwnerDurableObject,
  LinkStoreControlDurableObject,
  type LinkStoreRuntime,
} from '../../../worker/src/adapters/link-store-objects.ts';
import { LINK_BUNDLE_HEADERS, objectFetch } from '../../../worker/src/adapters/link-store-objects.ts';
import { DEFAULT_LINK_STORE_LIMITS, dueKey, LINK_STORE_VERSION } from '../../../worker/src/lib/index.ts';
import { newDaemonIdentity } from '../../support/worker/identities.ts';
import {
  DAY,
  FakeLinkObjectStorage,
  HOUR,
  LinkStoreClient,
  linkStoreWorld,
  MINUTE,
  newBundleId,
} from '../../support/worker/link-store-fakes.ts';
import { LINK_AT } from '../../support/worker/links.ts';

const LIMITS = DEFAULT_LINK_STORE_LIMITS;
const DAEMON = 'daemon-under-test';
const IP = '203.0.113.5';

interface Rig<T> {
  readonly object: T;
  readonly storage: FakeLinkObjectStorage;
  readonly clock: { now: number };
  readonly logs: string[];
}

function rig<T>(build: (storage: FakeLinkObjectStorage, runtime: LinkStoreRuntime) => T): Rig<T> {
  const storage = new FakeLinkObjectStorage();
  const clock = { now: Date.parse(LINK_AT) };
  const logs: string[] = [];
  const object = build(storage, {
    now: () => clock.now,
    log: message => {
      logs.push(message);
    },
  });
  return { object, storage, clock, logs };
}

const control = () => rig((storage, runtime) => new LinkStoreControlDurableObject({ storage }, {}, runtime));
const owner = () => rig((storage, runtime) => new LinkOwnerDurableObject({ storage }, {}, runtime));
const bundle = () => rig((storage, runtime) => new LinkBundleDurableObject({ storage }, {}, runtime));

type Doing = { fetch(request: Request): Promise<Response> };

async function ask(
  object: Doing,
  route: string,
  body?: unknown,
  init: { method?: string; headers?: Record<string, string>; raw?: string } = {},
): Promise<Record<string, unknown> & { status: number }> {
  const text = init.raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const response = await object.fetch(
    new Request(`https://link-store.invalid${route}`, {
      method: init.method ?? 'POST',
      ...(init.headers === undefined ? {} : { headers: init.headers }),
      ...(text === undefined ? {} : { body: text }),
    }),
  );
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...parsed, status: response.status };
}

const bundleHeaders = (bundleId = newBundleId(), extra: Record<string, string> = {}): Record<string, string> => ({
  [LINK_BUNDLE_HEADERS.bundle]: bundleId,
  [LINK_BUNDLE_HEADERS.limits]: JSON.stringify(LIMITS.perLink),
  ...extra,
});

const at15 = (at: number): string => String(at).padStart(15, '0');
const damaged = (what: string) => `link store: ${what} failed because its stored state is damaged`;
const unexpected = (what: string) => `link store: ${what} failed because it failed unexpectedly`;
const bundleId = () => newBundleId();

describe('link store bundle object', () => {
  it('should answer 503 and say it failed unexpectedly when the frame headers are missing or wrong', async () => {
    const { object, logs } = bundle();
    for (const headers of [
      {},
      { [LINK_BUNDLE_HEADERS.bundle]: newBundleId() },
      { [LINK_BUNDLE_HEADERS.bundle]: 'short', [LINK_BUNDLE_HEADERS.limits]: JSON.stringify(LIMITS.perLink) },
      bundleHeaders(newBundleId(), { [LINK_BUNDLE_HEADERS.limits]: 'not json' }),
      bundleHeaders(newBundleId(), { [LINK_BUNDLE_HEADERS.limits]: '{"wrongTokensPerMinute":"many"}' }),
    ]) {
      const answered = await ask(object, '/fetch', undefined, { headers });
      should(answered.status).equal(503);
      should(answered).have.property('error');
    }
    should(logs).deepEqual(Array(5).fill(unexpected('a bundle object')));
  });

  it('should treat a path it does not know as a fetch of a link it does not hold', async () => {
    const { object, logs, storage } = bundle();
    for (const route of ['/anything', '/peek', '/fetch']) {
      const answered = await ask(object, route, undefined, { headers: bundleHeaders(), raw: '' });
      should(answered.status).equal(410);
    }
    should(storage.values.size).equal(0);
    should(logs).deepEqual([]);
  });

  it('should refuse an upload whose frame it cannot decode, even when called directly', async () => {
    const { object, storage } = bundle();
    const answered = await ask(object, '/upload', undefined, {
      headers: bundleHeaders(newBundleId(), { [LINK_BUNDLE_HEADERS.daemon]: DAEMON }),
      raw: 'garbage',
    });
    should(answered.status).equal(400);
    should(storage.values.size).equal(0);
  });

  it('should answer 503 and say its state is damaged when its row does not parse', async () => {
    const { object, storage, logs } = bundle();
    const id = newBundleId();
    await storage.put('doc', { not: 'a row' });
    const answered = await ask(object, '/status', undefined, {
      headers: bundleHeaders(id, { [LINK_BUNDLE_HEADERS.daemon]: DAEMON }),
    });
    should(answered.status).equal(503);
    should(logs).deepEqual([damaged('a bundle object')]);
  });

  it('should answer 503 rather than a truncated envelope when a chunk is missing', async () => {
    const world = await linkStoreWorld();
    const client = new LinkStoreClient(world, await newDaemonIdentity());
    const up = await client.upload({ bytes: 700_000 });
    const storage = world.bundle(up.bundleId);
    should(storage?.keys('chunk:')).deepEqual(['chunk:0', 'chunk:1']);
    await storage?.delete('chunk:1');
    should((await world.open('fetch', up.bundleId, up.token)).status).equal(503);
    should(world.logs).deepEqual([damaged('a bundle object')]);
    world.assertLogsFixed();
  });

  it('should delete its alarm when it holds no link, and try again in a minute when it cannot read one', async () => {
    const empty = bundle();
    empty.storage.alarm = 123;
    await empty.object.alarm();
    should(empty.storage.alarm).be.null();
    should(empty.logs).deepEqual([]);

    const broken = bundle();
    await broken.storage.put('bundle', newBundleId());
    await broken.storage.put('doc', { not: 'a row' });
    await broken.object.alarm();
    should(broken.storage.alarm).equal(broken.clock.now + MINUTE);
    should(broken.logs).deepEqual(["link store: a bundle object's alarm failed because its stored state is damaged"]);
  });

  it('should reach an object through a namespace, and reject when the binding is missing', async () => {
    await objectFetch(undefined, 'x', '/y').then(
      () => should.fail('resolved', 'rejected', 'it should have rejected'),
      error => should((error as Error).message).containEql('binding'),
    );
    await objectFetch(
      {
        idFromName: () => {
          throw new Error('no id');
        },
        get: () => ({ fetch: async () => new Response('x') }),
      },
      'x',
      '/y',
      { method: 'PUT', body: 'hello', headers: { A: 'b' } },
    ).then(
      () => should.fail('resolved', 'rejected', 'it should have rejected'),
      error => should((error as Error).message).equal('no id'),
    );
  });
});

describe('link store owner object', () => {
  const reservation = (id: string, create = true) => ({
    reservation: { bundleId: id, bytes: 20_000, until: Date.parse(LINK_AT) + DAY, create },
    limits: LIMITS,
  });

  it('should issue, spend and refuse nonces', async () => {
    const { object, storage } = owner();
    for (const nonce of ['n1', 'n2', 'n3']) {
      should(await ask(object, '/challenge', { nonce, limits: LIMITS })).containEql({ ok: true, status: 200 });
    }
    const fourth = await ask(object, '/challenge', { nonce: 'n4', limits: LIMITS });
    should(fourth).containEql({ ok: false, code: 'link_rate_limited' });
    should(storage.alarm).not.be.null();

    should(await ask(object, '/spend', { nonce: 'n1' })).containEql({ spent: true });
    should(await ask(object, '/spend', { nonce: 'n1' })).containEql({ spent: false });
    should(await ask(object, '/spend', { nonce: 'never' })).containEql({ spent: false });
  });

  it('should reserve, undo and release a lease', async () => {
    const { object, storage, clock } = owner();
    const id = bundleId();
    const reserved = await ask(object, '/reserve', reservation(id));
    should(reserved).containEql({ ok: true });
    const undo = reserved['undo'] as { bundleId: string; previous: unknown; day: number };
    should(undo).containEql({ bundleId: id, previous: null });
    const shard = () => storage.values.get('shard') as { leases: Record<string, unknown>; uploads: { count: number } };
    should(Object.keys(shard().leases)).deepEqual([id]);
    should(shard().uploads.count).equal(1);

    await ask(object, '/undo', { undo });
    should(shard().leases).deepEqual({});
    should(shard().uploads.count).equal(0);

    await ask(object, '/reserve', reservation(id));
    should(await ask(object, '/release', { bundleId: id }, { method: 'POST' })).containEql({ ok: true });
    should(shard().leases).deepEqual({});

    clock.now += 2 * DAY;
    await object.alarm();
    should(storage.values.has('shard')).be.false();
    should(storage.alarm).be.null();
  });

  it('should refuse a reservation past a limit', async () => {
    const { object } = owner();
    const tight = { ...LIMITS, perDaemon: { ...LIMITS.perDaemon, liveLinks: 1 } };
    should((await ask(object, '/reserve', { ...reservation(bundleId()), limits: tight })).ok).equal(true);
    const refused = await ask(object, '/reserve', { ...reservation(bundleId()), limits: tight });
    should(refused).containEql({ ok: false, code: 'link_store_full' });
  });

  it('should delete its storage when nothing is left, and keep a shard that has no next time', async () => {
    const idle = owner();
    should(await ask(idle.object, '/release', { bundleId: bundleId() })).containEql({ ok: true });
    should(idle.storage.values.has('shard')).be.false();
    should(idle.storage.alarm).be.null();

    const stuck = owner();
    await stuck.storage.put('shard', {
      nonces: [],
      challengeTimes: [],
      leases: { x: { bytes: 1, until: 1 } },
      uploads: { day: 0, count: 0 },
    });
    stuck.storage.alarm = 99;
    should(await ask(stuck.object, '/undo', { undo: { bundleId: bundleId(), previous: null, day: 0 } })).containEql({
      ok: true,
    });
    should(stuck.storage.values.has('shard')).be.true();
    should(stuck.storage.alarm).be.null();
  });

  it('should answer 503, and say which kind of failure it was', async () => {
    const { object, storage, logs } = owner();
    should((await ask(object, '/spend', { nonce: '' })).status).equal(200);
    should(logs).deepEqual([damaged('an owner object')]);
    logs.length = 0;

    should((await ask(object, '/challenge', undefined, { raw: 'not json' })).status).equal(200);
    should(logs).deepEqual([unexpected('an owner object')]);
    logs.length = 0;

    await storage.put('shard', { not: 'a shard' });
    const answered = await ask(object, '/spend', { nonce: 'n' });
    should(answered).containEql({ ok: false, code: 'link_store_unavailable' });
    should(logs).deepEqual([damaged('an owner object')]);
    logs.length = 0;

    await object.alarm();
    should(logs).deepEqual(["link store: an owner object's alarm failed because its stored state is damaged"]);
    should(storage.alarm).not.be.null();
  });
});

describe('link store control object', () => {
  const NOW = Date.parse(LINK_AT);
  const reserve = (owner: string, id: string, create = true, bytes = 20_000, until = NOW + HOUR) => ({
    owner,
    bundleId: id,
    bytes,
    until,
    create,
  });
  const stateOf = (storage: FakeLinkObjectStorage) =>
    storage.values.get('state') as {
      totals: { live: number; bytes: number; tombs: number };
      owners: number;
      uploads: { day: number; count: number };
      fetches: { day: number; count: number };
    };

  it('should advertise itself and show the operator its settings', async () => {
    const { object } = control();
    should(await ask(object, '/service')).containEql({
      version: LINK_STORE_VERSION,
      available: true,
      maxEnvelopeBytes: 3 * 1024 * 1024,
      maxLiveLinks: LIMITS.perDaemon.liveLinks,
    });
    const view = await ask(object, '/operator', undefined, { method: 'GET' });
    should(view).containEql({ available: true, serving: true });
    should(view['metrics']).deepEqual({ owners: 0, liveLinks: 0, storedBytes: 0, tombstones: 0 });
  });

  it('should take settings from the operator, and refuse a body that is not settings', async () => {
    const { object } = control();
    const bad = await ask(object, '/operator', {}, { method: 'PUT' });
    should(bad.status).equal(400);
    should(bad['error']).equal('invalid link store settings');
    should(await ask(object, '/operator', { available: false }, { method: 'PUT' })).containEql({
      available: false,
      serving: true,
    });
    should(await ask(object, '/operator', { serving: false }, { method: 'PUT' })).containEql({
      available: false,
      serving: false,
    });
    const limits = { ...LIMITS, perDaemon: { ...LIMITS.perDaemon, liveLinks: 3 } };
    should(await ask(object, '/operator', { available: true, serving: true, limits }, { method: 'PUT' })).containEql({
      available: true,
      serving: true,
    });
    should(await ask(object, '/service')).containEql({ available: true, maxLiveLinks: 3 });
  });

  it('should admit only a daemon it has issued a challenge to', async () => {
    const { object } = control();
    should(await ask(object, '/admit', { daemonId: DAEMON, op: 'upload' })).containEql({
      ok: false,
      code: 'link_challenge_expired',
    });
    should(await ask(object, '/challenge', { daemonId: DAEMON, ip: IP })).containEql({ ok: true });
    for (const op of ['upload', 'delete', 'status']) {
      should(await ask(object, '/admit', { daemonId: DAEMON, op })).containEql({ ok: true });
    }
    await ask(object, '/operator', { available: false }, { method: 'PUT' });
    should(await ask(object, '/admit', { daemonId: DAEMON, op: 'upload' })).containEql({
      ok: false,
      code: 'link_store_unavailable',
    });
    should(await ask(object, '/admit', { daemonId: DAEMON, op: 'status' })).containEql({ ok: true });
    should(await ask(object, '/challenge', { daemonId: DAEMON, ip: IP })).containEql({
      ok: false,
      code: 'link_store_unavailable',
    });
  });

  it('should refuse a challenge past the per-address window', async () => {
    const { object } = control();
    for (let count = 0; count < LIMITS.perIp.challengesPerMinute; count += 1) {
      should(await ask(object, '/challenge', { daemonId: `d${count}`, ip: IP })).containEql({ ok: true });
    }
    should(await ask(object, '/challenge', { daemonId: 'last', ip: IP })).containEql({
      ok: false,
      code: 'link_rate_limited',
    });
  });

  it('should reserve, refuse, roll back and release a link', async () => {
    const { object, storage } = control();
    const id = bundleId();
    await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });

    const first = await ask(object, '/reserve', reserve(DAEMON, id));
    should(first).containEql({ ok: true, previous: null });
    should(stateOf(storage)).containEql({ owners: 1 });
    should(stateOf(storage).totals).deepEqual({ live: 1, bytes: 20_000, tombs: 0 });
    should(storage.keys('link:')).deepEqual([`link:${id}`]);
    should(storage.alarm).equal(NOW + HOUR);

    should(await ask(object, '/reserve', reserve(DAEMON, id))).containEql({ ok: false, code: 'link_exists' });
    should(await ask(object, '/reserve', reserve(DAEMON, bundleId(), false))).containEql({
      ok: false,
      code: 'link_unknown',
    });

    const replaced = await ask(object, '/reserve', reserve(DAEMON, id, false, 30_000));
    should(replaced['previous']).containEql({ owner: DAEMON, bytes: 20_000, phase: 'leased' });
    should(stateOf(storage).totals).deepEqual({ live: 1, bytes: 30_000, tombs: 0 });

    const day = replaced['day'] as number;
    should(await ask(object, '/rollback', { bundleId: id, previous: replaced['previous'], day })).containEql({
      ok: true,
    });
    should(stateOf(storage).totals).deepEqual({ live: 1, bytes: 20_000, tombs: 0 });
    should(await ask(object, '/rollback', { bundleId: id, previous: null, day })).containEql({ ok: true });
    should(storage.keys('link:')).deepEqual([]);
    should(stateOf(storage).totals).deepEqual({ live: 0, bytes: 0, tombs: 0 });
    should(stateOf(storage).uploads.count).equal(0);

    await ask(object, '/reserve', reserve(DAEMON, id));
    should(await ask(object, '/rollback', { bundleId: id, previous: null, day: day + 5 })).containEql({ ok: true });
    should(stateOf(storage).uploads.count).equal(1);
    should(storage.keys('link:')).deepEqual([]);

    await ask(object, '/reserve', reserve(DAEMON, id));
    should(await ask(object, '/release', { bundleId: bundleId() })).containEql({ ok: true });
    should(await ask(object, '/release', { bundleId: id })).containEql({ ok: true });
    should(storage.values.get(`link:${id}`)).containEql({ phase: 'tomb', bytes: 0 });
    should(stateOf(storage).totals).deepEqual({ live: 0, bytes: 0, tombs: 1 });
    should(await ask(object, '/release', { bundleId: id })).containEql({ ok: true });
    should(stateOf(storage).totals.tombs).equal(1);
  });

  it('should refuse a reservation when the store is not available or is full', async () => {
    const { object } = control();
    await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });
    const tight = { ...LIMITS, global: { ...LIMITS.global, liveLinks: 1 } };
    await ask(object, '/operator', { limits: tight }, { method: 'PUT' });
    should(await ask(object, '/reserve', reserve(DAEMON, bundleId()))).containEql({ ok: true });
    should(await ask(object, '/reserve', reserve(DAEMON, bundleId()))).containEql({
      ok: false,
      code: 'link_store_capacity',
    });
    await ask(object, '/operator', { available: false }, { method: 'PUT' });
    should(await ask(object, '/reserve', reserve(DAEMON, bundleId()))).containEql({
      ok: false,
      code: 'link_store_unavailable',
    });
  });

  it('should say who owns which of the ids it is asked about', async () => {
    const { object } = control();
    await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });
    const mine = bundleId();
    await ask(object, '/reserve', reserve(DAEMON, mine));
    const stray = bundleId();
    should(await ask(object, '/owned', { owner: DAEMON, bundleIds: [mine, stray] })).containEql({ owned: [mine] });
    should(await ask(object, '/owned', { owner: 'someone-else', bundleIds: [mine] })).containEql({ owned: [] });
  });

  it('should decide what an open does before any bundle object is asked', async () => {
    const { object, storage } = control();
    await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });
    const known = bundleId();
    await ask(object, '/reserve', reserve(DAEMON, known));

    const proceed = await ask(object, '/open', { type: 'fetch', bundleId: known, ip: IP });
    should(proceed).containEql({ ok: true, verdict: 'proceed' });
    should(proceed['perLink']).deepEqual(LIMITS.perLink);
    should(await ask(object, '/open', { type: 'peek', bundleId: bundleId(), ip: IP })).containEql({
      ok: true,
      verdict: 'gone',
    });

    const stray = bundleId();
    for (let count = 0; count < LIMITS.perLink.wrongTokensPerMinute - 1; count += 1) {
      await ask(object, '/open', { type: 'fetch', bundleId: stray, ip: `10.1.0.${count}` });
    }
    should(await ask(object, '/open', { type: 'fetch', bundleId: stray, ip: '10.2.0.1' })).containEql({
      ok: true,
      verdict: 'gone',
    });
    should(await ask(object, '/open', { type: 'fetch', bundleId: stray, ip: '10.2.0.2' })).containEql({
      ok: false,
      code: 'link_rate_limited',
    });

    for (let count = 0; count < LIMITS.perIp.fetchesPerMinute; count += 1) {
      await ask(object, '/open', { type: 'fetch', bundleId: known, ip: '10.3.0.1' });
    }
    should(await ask(object, '/open', { type: 'fetch', bundleId: known, ip: '10.3.0.1' })).containEql({
      ok: false,
      code: 'link_rate_limited',
    });

    await storage.put('state', {
      ...stateOf(storage),
      fetches: { day: Math.floor(NOW / DAY), count: LIMITS.global.fetchesPerDay },
    });
    should(await ask(object, '/open', { type: 'fetch', bundleId: known, ip: '10.4.0.1' })).containEql({
      ok: false,
      code: 'link_store_capacity',
    });

    await ask(object, '/operator', { serving: false }, { method: 'PUT' });
    should(await ask(object, '/open', { type: 'fetch', bundleId: known, ip: '10.5.0.1' })).containEql({
      ok: false,
      code: 'link_store_unavailable',
    });
  });

  it('should count a fetch once it is handed over, and start again the next day', async () => {
    const { object, storage, clock } = control();
    should(await ask(object, '/fetched', {})).containEql({ ok: true });
    should(await ask(object, '/fetched', {})).containEql({ ok: true });
    should(stateOf(storage).fetches.count).equal(2);
    clock.now += DAY;
    await ask(object, '/fetched', {});
    should(stateOf(storage).fetches.count).equal(1);
  });

  it('should answer 503 and say its state is damaged for any damaged row', async () => {
    for (const [key, route, body] of [
      ['config', '/service', undefined],
      ['state', '/challenge', { daemonId: DAEMON, ip: IP }],
      [`link:${'A'.repeat(22)}`, '/release', { bundleId: 'A'.repeat(22) }],
    ] as const) {
      const { object, storage, logs } = control();
      await storage.put(key, { not: 'a row' });
      const answered = await ask(object, route, body);
      should(answered).containEql({ ok: false, code: 'link_store_unavailable' });
      should(logs).deepEqual([damaged('the control object')]);
    }
    const { object, logs } = control();
    should(await ask(object, '/release', undefined, { raw: '{' })).containEql({ ok: false });
    should(logs).deepEqual([unexpected('the control object')]);
  });

  it('should answer a body it cannot parse as a damaged internal request', async () => {
    const { object, logs } = control();
    should(await ask(object, '/admit', { daemonId: '', op: 'upload' })).containEql({ ok: false });
    should(logs).deepEqual([damaged('the control object')]);
  });

  describe('the alarm', () => {
    it('should forget an owner when its time comes, and leave one that was extended', async () => {
      const { object, storage, clock } = control();
      await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });
      await ask(object, '/challenge', { daemonId: 'extended', ip: IP });
      should(stateOf(storage).owners).equal(2);
      await storage.put(`owner:extended`, clock.now + 10 * DAY);
      await storage.put(dueKey(clock.now + HOUR, 'o', 'ghost'), 1);
      clock.now += DAY + 1;
      await object.alarm();
      should(storage.values.has(`owner:${DAEMON}`)).be.false();
      should(storage.values.has('owner:extended')).be.true();
      should(storage.keys('due:').some(key => key.includes(':o:ghost'))).be.false();
      should(stateOf(storage).owners).equal(1);
      should(storage.alarm).be.null();
    });

    it('should lapse a lease into a tombstone, then forget the tombstone', async () => {
      const { object, storage, clock } = control();
      await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });
      const id = bundleId();
      await ask(object, '/reserve', reserve(DAEMON, id));

      clock.now += HOUR;
      await object.alarm();
      should(storage.values.get(`link:${id}`)).containEql({ phase: 'tomb', bytes: 0 });
      should(stateOf(storage).totals).deepEqual({ live: 0, bytes: 0, tombs: 1 });
      should(storage.alarm).not.be.null();

      clock.now += 31 * DAY;
      await object.alarm();
      await object.alarm();
      should(storage.keys('link:')).deepEqual([]);
      should(storage.keys('due:')).deepEqual([]);
      should(stateOf(storage).totals).deepEqual({ live: 0, bytes: 0, tombs: 0 });
      should(storage.alarm).be.null();
    });

    it('should drop a due entry that no longer matches its record', async () => {
      const { object, storage, clock } = control();
      await storage.put(`due:${at15(clock.now - 1)}:l:gone`, 1);
      const id = bundleId();
      await storage.put(`link:${id}`, { owner: DAEMON, bytes: 1, until: clock.now + 5 * DAY, phase: 'leased' });
      await storage.put(`due:${at15(clock.now - 1)}:l:${id}`, 1);
      await object.alarm();
      should(storage.keys('due:')).deepEqual([]);
      should(storage.values.has(`link:${id}`)).be.true();
      should(storage.alarm).be.null();
    });

    it('should settle a batch and ask to be woken again when more is due', async () => {
      const { object, storage, clock } = control();
      for (let index = 0; index < 201; index += 1) {
        await storage.put(`due:${at15(clock.now - 1)}:l:stale${String(index).padStart(4, '0')}`, 1);
      }
      await object.alarm();
      should(storage.keys('due:')).have.length(1);
      should(storage.alarm).equal(clock.now + 1000);
      await object.alarm();
      should(storage.keys('due:')).deepEqual([]);
      should(storage.alarm).be.null();
    });

    it('should keep waking up for a due key it cannot read', async () => {
      const { object, storage, clock } = control();
      await storage.put('due:unreadable', 1);
      await object.alarm();
      should(storage.keys('due:')).deepEqual(['due:unreadable']);
      should(storage.alarm).equal(clock.now + 1000);
    });

    it('should wake at the next due time when nothing is due yet', async () => {
      const { object, storage, clock } = control();
      await ask(object, '/challenge', { daemonId: DAEMON, ip: IP });
      storage.alarm = null;
      await object.alarm();
      should(storage.alarm).equal(clock.now + DAY);
    });

    it('should try again in a minute and say why when it fails', async () => {
      const damagedOne = control();
      const id = bundleId();
      await damagedOne.storage.put(`link:${id}`, {
        owner: DAEMON,
        bytes: 1,
        until: damagedOne.clock.now - 1,
        phase: 'leased',
      });
      await damagedOne.storage.put(`due:${at15(damagedOne.clock.now - 1)}:l:${id}`, 1);
      await damagedOne.storage.put('state', { not: 'counters' });
      await damagedOne.object.alarm();
      should(damagedOne.logs).deepEqual([
        "link store: the control object's alarm failed because its stored state is damaged",
      ]);
      should(damagedOne.storage.alarm).equal(damagedOne.clock.now + MINUTE);

      const broken = control();
      Object.assign(broken.storage, {
        list: async () => {
          throw new Error('storage is down');
        },
      });
      await broken.object.alarm();
      should(broken.logs).deepEqual(["link store: the control object's alarm failed because it failed unexpectedly"]);
      should(broken.storage.alarm).equal(broken.clock.now + MINUTE);
    });
  });
});
