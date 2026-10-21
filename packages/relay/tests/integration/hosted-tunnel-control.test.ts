import { describe, it } from 'bun:test';
import should from 'should';
import {
  DurableTunnelStore,
  HOSTED_TUNNEL_CONTROL_OBJECT_NAME,
  hostedTunnelControlRuntime,
  type RelayEnvironment,
  relayFetch,
  TUNNEL_CONTROL_ROUTES,
  TUNNEL_RECLAIM_CONTINUE_MS,
  TUNNEL_REQUEST_MAX_BYTES,
} from '../../src/adapters/index.ts';
// From the Worker ENTRY, deliberately: Cloudflare finds the class `wrangler.hosted.json` binds only there.
import relayWorker, { HostedTunnelControlDurableObject } from '../../src/adapters/worker.ts';
import {
  type DaemonIdentity,
  fromBase64Url,
  signTunnelRequest,
  TUNNEL_CHALLENGE_PATH,
  TUNNEL_DAY_MILLISECONDS,
  TUNNEL_OPERATOR_STATUS_PATH,
  TUNNEL_PROVISION_PATH,
  TUNNEL_RECLAIM_DELETIONS_PER_PASS,
  TUNNEL_RELEASE_PATH,
  TUNNEL_SERVICE_PATH,
  type TunnelAccount,
  type TunnelAction,
  TunnelAccountSchema,
  TunnelChallengeSchema,
  TunnelOperatorStatusSchema,
  TunnelProvisionSchema,
  TunnelRefusalSchema,
  type TunnelRow,
} from '../../src/lib/index.ts';
import { FAKE_CONNECTOR_TOKEN_PREFIX, FakeCloudflare } from '../support/fake-cloudflare.ts';
import { FakeHostedTunnelControlStorage } from '../support/hosted-control-fakes.ts';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';

const HOST = 'relay.example.test';
const OPERATOR = 'operator-bearer-secret';
const MINUTE = 60_000;

function poolAccount(index: number, overrides: Partial<TunnelAccount> = {}): TunnelAccount {
  return TunnelAccountSchema.parse({
    name: `pool-${index}`,
    accountId: index.toString(16).repeat(32),
    apiToken: `api-token-${index}-secret`,
    zoneId: (index + 5).toString(16).repeat(32),
    zone: `tunnels-${index}.example.com`,
    ...overrides,
  });
}

interface HarnessOptions {
  readonly accounts?: readonly TunnelAccount[];
  /** The raw secret; overrides `accounts`. */
  readonly pool?: string;
  readonly mode?: string;
  readonly binding?: 'object' | 'missing' | 'throwing';
}

function harness(options: HarnessOptions = {}) {
  const accounts = options.accounts ?? [poolAccount(1)];
  const cloudflare = new FakeCloudflare();
  for (const account of accounts) cloudflare.addAccount(account);
  const storage = new FakeHostedTunnelControlStorage();
  const logs: string[] = [];
  const state = { clock: 5_000_000 };
  const secrets = { TUNNEL_ACCOUNTS: options.pool ?? JSON.stringify(accounts) };
  const object = new HostedTunnelControlDurableObject({ storage }, secrets, {
    crypto: relayCrypto,
    cloudflare,
    now: () => state.clock,
    log: message => logs.push(message),
  });
  const named: string[] = [];
  const binding = options.binding ?? 'object';
  const environment: RelayEnvironment = {
    RELAY_MODE: options.mode ?? 'hosted',
    RELAY_OPERATOR_TOKEN: OPERATOR,
    RENDEZVOUS: {
      idFromName: name => name,
      get: () => ({ fetch: async () => new Response('rendezvous', { status: 101 }) }),
    },
    ...(binding === 'missing'
      ? {}
      : {
          TUNNEL_CONTROL: {
            idFromName: name => {
              named.push(name);
              return name;
            },
            get: () => ({
              fetch: async (request: Request) => {
                if (binding === 'throwing') throw new Error('object unreachable');
                return object.fetch(request);
              },
            }),
          },
        }),
  };

  const call = (path: string, init: RequestInit = {}) =>
    relayFetch(new Request(`https://${HOST}${path}`, init), environment);
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

  async function signed(identity: DaemonIdentity, action: TunnelAction, originPort?: number, host = HOST) {
    state.clock += MINUTE;
    const challenge = TunnelChallengeSchema.parse(
      await (await post(TUNNEL_CHALLENGE_PATH, { daemonId: identity.daemonId })).json(),
    );
    return signTunnelRequest(relayCrypto, identity, {
      action,
      daemonId: identity.daemonId,
      host,
      nonce: fromBase64Url(challenge.nonce) as Uint8Array,
      ...(originPort === undefined ? {} : { originPort }),
    });
  }

  return {
    cloudflare,
    storage,
    logs,
    state,
    object,
    named,
    call,
    post,
    signed,
    async provision(identity: DaemonIdentity, originPort = 4000, host = HOST) {
      return post(TUNNEL_PROVISION_PATH, { ...(await signed(identity, 'provision', originPort, host)), originPort });
    },
    async release(identity: DaemonIdentity) {
      return post(TUNNEL_RELEASE_PATH, await signed(identity, 'release'));
    },
    operator(method = 'GET', body?: unknown, token = OPERATOR) {
      return call(TUNNEL_OPERATOR_STATUS_PATH, {
        method,
        headers: { Authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    rows(): TunnelRow[] {
      return [...storage.values.entries()]
        .filter(([key]) => key.startsWith('tunnel:active:') || key.startsWith('tunnel:retired:'))
        .map(([, value]) => value as TunnelRow);
    },
  };
}

async function refusalCode(response: Response): Promise<string> {
  return TunnelRefusalSchema.parse(await response.json()).error.code;
}

describe('the hosted tunnel service through the Worker', () => {
  it('should advertise availability publicly, uncached and cross-origin', async () => {
    const test = harness();
    const response = await test.call(TUNNEL_SERVICE_PATH);
    should(response.status).equal(200);
    should(await response.json()).eql({ version: 1, available: true });
    should(response.headers.get('Cache-Control')).equal('no-store, max-age=0');
    should(response.headers.get('Access-Control-Allow-Origin')).equal('*');
    should(test.named).eql([HOSTED_TUNNEL_CONTROL_OBJECT_NAME]);

    const preflight = await test.call(TUNNEL_SERVICE_PATH, { method: 'OPTIONS' });
    should(preflight.status).equal(204);
    should(preflight.headers.get('Access-Control-Allow-Methods')).equal('GET, OPTIONS');
    should(await refusalCode(await test.call(TUNNEL_SERVICE_PATH, { method: 'POST' }))).equal('tunnel_bad_request');
  });

  it('should advertise unavailable when no pool, no binding, or no answer', async () => {
    for (const test of [
      harness({ pool: '' }),
      harness({ binding: 'missing' }),
      harness({ binding: 'throwing' }),
      harness({ accounts: [poolAccount(1, { accepting: false })] }),
    ]) {
      const response = await test.call(TUNNEL_SERVICE_PATH);
      should(response.status).equal(200);
      should(await response.json()).eql({ version: 1, available: false });
    }
  });

  it('should provision and renew a tunnel for a daemon that signed this service host', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    const response = await test.provision(daemon, 41_234);
    should(response.status).equal(200);
    should(response.headers.get('Cache-Control')).equal('no-store, max-age=0');
    const first = TunnelProvisionSchema.parse(await response.json());
    should(first.connectorToken).startWith(FAKE_CONNECTOR_TOKEN_PREFIX);
    const again = TunnelProvisionSchema.parse(await (await test.provision(daemon, 41_234)).json());
    should(again.tunnelUrl).equal(first.tunnelUrl);
    should(test.cloudflare.liveTunnels()).have.length(1);
    // The object stores the tunnel, never its connector token.
    should(JSON.stringify([...test.storage.values.values()])).not.containEql(FAKE_CONNECTOR_TOKEN_PREFIX);
  });

  it('should refuse a replayed nonce, a signature for another host, and a stranger key', async () => {
    const test = harness();
    const [daemon, stranger] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    const body = { ...(await test.signed(daemon, 'provision', 4000)), originPort: 4000 };
    should((await test.post(TUNNEL_PROVISION_PATH, body)).status).equal(200);
    const replay = await test.post(TUNNEL_PROVISION_PATH, body);
    should(replay.status).equal(401);
    should(await refusalCode(replay)).equal('tunnel_challenge_expired');

    const elsewhere = await test.provision(daemon, 4000, 'tunnels.attacker.example');
    should(elsewhere.status).equal(401);
    should(await refusalCode(elsewhere)).equal('tunnel_claim_rejected');

    const theirs = await test.signed(stranger, 'provision', 4000);
    const challenge = TunnelChallengeSchema.parse(
      await (await test.post(TUNNEL_CHALLENGE_PATH, { daemonId: daemon.daemonId })).json(),
    );
    const forged = await test.post(TUNNEL_PROVISION_PATH, {
      ...theirs,
      daemonId: daemon.daemonId,
      nonce: challenge.nonce,
      originPort: 4000,
    });
    should(await refusalCode(forged)).equal('tunnel_claim_rejected');
    should(test.cloudflare.liveTunnels()).have.length(1);
  });

  it('should rate-limit challenges with 429', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await test.post(TUNNEL_CHALLENGE_PATH, { daemonId: daemon.daemonId })).status);
    }
    should(statuses).eql([200, 200, 200, 429]);
  });

  it('should release a tunnel, and report a deletion it left for the reclaim', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    await test.provision(daemon);
    test.cloudflare.fail('deleteTunnel');
    const released = await test.release(daemon);
    should(released.status).equal(200);
    should(await released.json()).eql({ version: 1, released: true });
    should(
      test.logs.some(line => line.startsWith('tunnel release left work for the reclaim: delete the tunnel')),
    ).be.true();
    should(await (await test.release(daemon)).json()).eql({ version: 1, released: false });
    should(await refusalCode(await test.post(TUNNEL_RELEASE_PATH, {}))).equal('tunnel_bad_request');
  });

  it('should release a half-made tunnel by finding it under its name', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    test.cloudflare.fail('createTunnel', 'failed', true);
    should((await test.provision(daemon)).status).equal(502);
    should(test.rows()[0]?.tunnelId).be.null();
    should(test.cloudflare.liveTunnels()).have.length(1);
    should(await (await test.release(daemon)).json()).eql({ version: 1, released: true });
    should(test.cloudflare.liveTunnels()).be.empty();
    should(test.rows()).be.empty();
  });

  it('should answer 502 and log what Cloudflare said when a step fails, then finish on the retry', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    test.cloudflare.fail('createDnsRecord');
    const failed = await test.provision(daemon);
    should(failed.status).equal(502);
    should(await refusalCode(failed)).equal('tunnel_upstream_failed');
    should(test.logs).containEql('tunnel provision failed: create the DNS record: injected failed on createDnsRecord');
    should((await test.provision(daemon)).status).equal(200);
    should(test.cloudflare.liveTunnels()).have.length(1);
  });

  it('should refuse capacity with 503', async () => {
    const test = harness({ accounts: [poolAccount(1, { maxTunnels: 1 })] });
    should((await test.provision(await newDaemonIdentity())).status).equal(200);
    const full = await test.provision(await newDaemonIdentity());
    should(full.status).equal(503);
    should(await refusalCode(full)).equal('tunnel_capacity');
  });

  it('should run one request at a time, so two racing provisions make one tunnel', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    const [first, second] = await Promise.all([
      test.signed(daemon, 'provision', 4000),
      test.signed(daemon, 'provision', 4000),
    ]);
    const answers = await Promise.all(
      [first, second].map(body => test.post(TUNNEL_PROVISION_PATH, { ...body, originPort: 4000 })),
    );
    should(answers.map(answer => answer.status)).eql([200, 200]);
    should(test.cloudflare.liveTunnels()).have.length(1);
  });

  it('should refuse malformed, oversized and wrongly addressed requests as bad requests', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    for (const response of [
      await test.post(TUNNEL_CHALLENGE_PATH, 'not json'),
      await test.post(TUNNEL_CHALLENGE_PATH, { daemonId: daemon.daemonId, extra: 1 }),
      await test.post(TUNNEL_CHALLENGE_PATH, ' '.repeat(TUNNEL_REQUEST_MAX_BYTES + 1)),
      await test.post(TUNNEL_PROVISION_PATH, { daemonId: daemon.daemonId }),
      await test.call(TUNNEL_CHALLENGE_PATH),
    ]) {
      should(response.status).equal(400);
      should(await refusalCode(response)).equal('tunnel_bad_request');
    }
  });

  it('should refuse with tunnel_unavailable when the deployment has no control object or it cannot be reached', async () => {
    const daemon = await newDaemonIdentity();
    for (const test of [harness({ binding: 'missing' }), harness({ binding: 'throwing' })]) {
      const response = await test.post(TUNNEL_CHALLENGE_PATH, { daemonId: daemon.daemonId });
      should(response.status).equal(503);
      should(await refusalCode(response)).equal('tunnel_unavailable');
    }
  });

  it('should not exist on a self-hosted relay', async () => {
    const test = harness({ mode: 'self-hosted' });
    for (const path of [
      TUNNEL_SERVICE_PATH,
      TUNNEL_CHALLENGE_PATH,
      TUNNEL_PROVISION_PATH,
      TUNNEL_RELEASE_PATH,
      TUNNEL_OPERATOR_STATUS_PATH,
    ]) {
      should((await test.call(path)).status).equal(404);
      should((await test.post(path, {})).status).equal(404);
    }
    should(test.named).be.empty();
  });

  it('should answer through the Workers entry with the two arguments the platform passes', async () => {
    const response = await relayWorker.fetch(new Request(`https://${HOST}${TUNNEL_SERVICE_PATH}`), {
      RELAY_MODE: 'hosted',
      RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
    });
    should(await response.json()).eql({ version: 1, available: false });
  });
});

describe('the operator tunnel status', () => {
  it('should require the operator bearer', async () => {
    const test = harness();
    should((await test.operator('GET', undefined, 'wrong')).status).equal(401);
    const unconfigured = await relayFetch(new Request(`https://${HOST}${TUNNEL_OPERATOR_STATUS_PATH}`), {
      RELAY_MODE: 'hosted',
      RENDEZVOUS: { idFromName: name => name, get: () => ({ fetch: async () => new Response(null) }) },
    });
    should(unconfigured.status).equal(503);
  });

  it('should count tunnels per account and never contain a token', async () => {
    const accounts = [poolAccount(1), poolAccount(2, { accepting: false })];
    const test = harness({ accounts });
    await test.provision(await newDaemonIdentity());
    await test.provision(await newDaemonIdentity());
    const response = await test.operator();
    should(response.status).equal(200);
    const text = await response.text();
    const status = TunnelOperatorStatusSchema.parse(JSON.parse(text));
    should(status.accounts.map(account => [account.name, account.liveTunnels, account.zoneCheck])).eql([
      ['pool-1', 2, 'passed'],
      ['pool-2', 0, 'unchecked'],
    ]);
    for (const secret of [...accounts.map(account => account.apiToken), FAKE_CONNECTOR_TOKEN_PREFIX, OPERATOR]) {
      should(text).not.containEql(secret);
    }
  });

  it('should change the reclaim window, and refuse a bad one or another method', async () => {
    const test = harness();
    const changed = await test.operator('PUT', { reclaimAfterDays: 7 });
    should(await changed.json()).eql({ settings: { reclaimAfterDays: 7 } });
    should(TunnelOperatorStatusSchema.parse(await (await test.operator()).json()).settings).eql({
      reclaimAfterDays: 7,
    });
    should((await test.operator('PUT', { reclaimAfterDays: 0 })).status).equal(400);
    should((await test.operator('DELETE')).status).equal(400);
    should((await harness({ binding: 'missing' }).operator()).status).equal(503);
  });

  it('should log an unusable pool once, by its reason and never its value', async () => {
    const secret = 'api-token-in-a-broken-pool';
    const test = harness({ pool: `[{"apiToken":"${secret}"` });
    await test.call(TUNNEL_SERVICE_PATH);
    await test.call(TUNNEL_SERVICE_PATH);
    const status = TunnelOperatorStatusSchema.parse(await (await test.operator()).json());
    should(status).match({ available: false, pool: 'invalid', poolProblem: 'TUNNEL_ACCOUNTS is not JSON' });
    should(test.logs).eql(['tunnel pool is unusable, so the tunnel service is off: TUNNEL_ACCOUNTS is not JSON']);
    should(test.logs.join('\n')).not.containEql(secret);
  });
});

describe('the tunnel control object', () => {
  it('should schedule its daily reclaim on first use, and reclaim a tunnel nobody renewed', async () => {
    const test = harness();
    should(test.storage.alarm).be.null();
    const daemon = await newDaemonIdentity();
    await test.provision(daemon);
    should(test.storage.alarm).be.a.Number();

    test.state.clock += 31 * TUNNEL_DAY_MILLISECONDS;
    await test.object.alarm();
    should(test.cloudflare.liveTunnels()).be.empty();
    should(test.cloudflare.records.size).equal(0);
    should(test.rows()).be.empty();
    should(test.storage.alarm).equal(test.state.clock + TUNNEL_DAY_MILLISECONDS);
    should(test.logs).containEql('tunnel reclaim: retired 1, deleted 1, failed 0, orphaned 0');
  });

  it('should come back in a minute when a pass stopped at its budget, and log failed steps', async () => {
    const test = harness();
    for (let index = 0; index <= TUNNEL_RECLAIM_DELETIONS_PER_PASS; index += 1) {
      await test.provision(await newDaemonIdentity());
    }
    test.state.clock += 31 * TUNNEL_DAY_MILLISECONDS;
    test.cloudflare.fail('deleteDnsRecord');
    await test.object.alarm();
    should(test.storage.alarm).equal(test.state.clock + TUNNEL_RECLAIM_CONTINUE_MS);
    should(test.logs.some(line => line.endsWith(', continuing'))).be.true();
    should(test.logs.some(line => line.startsWith('tunnel reclaim step failed: pool-1/'))).be.true();
  });

  it('should log nothing for a pass with nothing to do, and still reschedule after a pass that threw', async () => {
    const test = harness();
    await test.object.alarm();
    should(test.logs).be.empty();
    should(test.storage.alarm).equal(test.state.clock + TUNNEL_DAY_MILLISECONDS);

    test.storage.list = async () => {
      throw new Error('storage is down');
    };
    test.state.clock += 1;
    await test.object.alarm();
    should(test.logs).eql(['tunnel reclaim failed: storage is down']);
    should(test.storage.alarm).equal(test.state.clock + TUNNEL_DAY_MILLISECONDS);
  });

  it('should refuse a provision over a damaged row rather than strand the tunnel it records', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    test.storage.values.set(`tunnel:active:${daemon.daemonId}`, { label: 'nope' });
    const response = await test.provision(daemon);
    should(response.status).equal(503);
    should(TunnelRefusalSchema.parse(await response.json()).error.message).match(/state is damaged/);
    should(test.logs[0]).match(/^tunnel control failed: tunnel service state is damaged: the active tunnel row for/);
  });

  it('should treat a row filed under another fingerprint as damaged', async () => {
    const test = harness();
    const [daemon, other] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    await test.provision(other);
    test.storage.values.set(
      `tunnel:active:${daemon.daemonId}`,
      test.storage.values.get(`tunnel:active:${other.daemonId}`),
    );
    should((await test.provision(daemon)).status).equal(503);
  });

  it('should answer an unexpected failure as unavailable', async () => {
    const test = harness();
    test.storage.getAlarm = async () => {
      throw 'not an error';
    };
    const response = await test.call(TUNNEL_SERVICE_PATH);
    should(await response.json()).eql({ version: 1, available: false });
    should(test.logs).eql(['tunnel control failed: unknown error']);
  });

  it('should refuse internal requests it does not understand', async () => {
    const test = harness();
    const internal = (route: string, method: string, body?: string) =>
      test.object.fetch(new Request(`https://tunnel-control.invalid${route}`, { method, ...(body ? { body } : {}) }));
    should((await internal('/nowhere', 'GET')).status).equal(404);
    for (const route of [
      TUNNEL_CONTROL_ROUTES.challenge,
      TUNNEL_CONTROL_ROUTES.provision,
      TUNNEL_CONTROL_ROUTES.release,
    ]) {
      should((await internal(route, 'POST', '{}')).status).equal(400);
    }
    should((await internal(TUNNEL_CONTROL_ROUTES.settings, 'PUT', 'nope')).status).equal(400);
  });
});

describe('the durable tunnel store', () => {
  it('should skip and count unreadable rows, and page past a full page', async () => {
    const test = harness();
    await test.provision(await newDaemonIdentity());
    const [template] = test.rows();
    if (template === undefined) throw new Error('expected a row');
    for (let index = 0; index < 300; index += 1) {
      const daemonId = `fy_daemon_${String(index).padStart(43, 'z')}`;
      test.storage.values.set(`tunnel:active:${daemonId}`, { ...template, daemonId });
    }
    test.storage.values.set('tunnel:retired:broken', { label: 'broken' });
    const status = TunnelOperatorStatusSchema.parse(await (await test.operator()).json());
    should(status.accounts[0]?.liveTunnels).equal(301);
    should(status.damagedRows).equal(1);
  });

  it('should read damaged auxiliary state as empty, never as an error', async () => {
    const storage = new FakeHostedTunnelControlStorage();
    const store = new DurableTunnelStore(storage);
    storage.values.set('tunnel:challenges', 'garbage');
    storage.values.set('tunnel:settings', { reclaimAfterDays: 'never' });
    storage.values.set('tunnel:zone:broken', { passed: 'maybe' });
    should(await store.challengeBook()).eql([]);
    should(await store.settings()).eql({ reclaimAfterDays: 30 });
    should((await store.zoneVerdicts()).size).equal(0);
    should(await store.activeRow(`fy_daemon_${'a'.repeat(43)}`)).be.null();
  });

  it('should keep a counted index of every tunnel until its deletion finished', async () => {
    const test = harness();
    const daemon = await newDaemonIdentity();
    await test.provision(daemon);
    const index = () => [...test.storage.values.keys()].filter(key => key.startsWith('tunnel:index:'));
    should(index()).have.length(1);
    test.cloudflare.fail('deleteTunnel');
    await test.release(daemon);
    should(index()).have.length(1);
    test.state.clock += MINUTE;
    await test.object.alarm();
    should(index()).be.empty();
  });

  it('should default its runtime to the platform', () => {
    should(hostedTunnelControlRuntime.now()).be.a.Number();
    const original = console.error;
    const heard: unknown[] = [];
    console.error = (...values: unknown[]) => heard.push(...values);
    try {
      hostedTunnelControlRuntime.log('a line');
    } finally {
      console.error = original;
    }
    should(heard).eql(['a line']);
  });
});
