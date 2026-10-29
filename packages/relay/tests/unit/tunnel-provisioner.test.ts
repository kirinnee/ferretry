import { describe, it } from 'bun:test';
import {
  type DaemonIdentity,
  DEFAULT_TUNNEL_RENEW_SECONDS,
  fromBase64Url,
  parseTunnelAccountPool,
  signTunnelRequest,
  TUNNEL_DAY_MILLISECONDS,
  TUNNEL_RECLAIM_DELETIONS_PER_PASS,
  type TunnelAccount,
  type TunnelAction,
  TunnelAccountSchema,
  type TunnelPoolState,
  TunnelProvisioner,
  TunnelProvisionSchema,
  TunnelReleaseSchema,
  TunnelStateDamagedError,
  tunnelIngress,
} from '@ferretry/relay';
import should from 'should';
import { FAKE_CONNECTOR_TOKEN_PREFIX, FakeCloudflare } from '../support/fake-cloudflare.ts';
import { newDaemonIdentity, relayCrypto } from '../support/identities.ts';
import { MemoryTunnelStore } from '../support/memory-tunnel-store.ts';

const HOST = 'tunnels.example.test';
const MINUTE = 60_000;

function poolAccount(index: number, overrides: Partial<TunnelAccount> = {}): TunnelAccount {
  const hex = index.toString(16);
  return TunnelAccountSchema.parse({
    name: `pool-${index}`,
    accountId: hex.repeat(32),
    apiToken: `api-token-${index}-secret`,
    zoneId: (index + 5).toString(16).repeat(32),
    zone: `tunnels-${index}.example.com`,
    ...overrides,
  });
}

function ready(...accounts: TunnelAccount[]): TunnelPoolState {
  return { kind: 'ready', accounts };
}

function world(...accounts: TunnelAccount[]) {
  const cloudflare = new FakeCloudflare();
  for (const account of accounts) cloudflare.addAccount(account);
  const store = new MemoryTunnelStore();
  const state = { clock: 1_000_000, pool: ready(...accounts) };
  const provisioner = new TunnelProvisioner({ api: cloudflare, store, crypto: relayCrypto, now: () => state.clock });

  async function signed(identity: DaemonIdentity, action: TunnelAction, originPort?: number, host = HOST) {
    // A minute between operations keeps every test inside the per-daemon challenge budget.
    state.clock += MINUTE;
    const challenge = await provisioner.challenge(state.pool, { daemonId: identity.daemonId });
    if (!challenge.ok) throw new Error(`challenge refused: ${challenge.message}`);
    const nonce = fromBase64Url(challenge.value.nonce) as Uint8Array;
    return signTunnelRequest(relayCrypto, identity, {
      action,
      daemonId: identity.daemonId,
      host,
      nonce,
      ...(originPort === undefined ? {} : { originPort }),
    });
  }

  return {
    cloudflare,
    store,
    state,
    provisioner,
    signed,
    async provision(identity: DaemonIdentity, originPort = 4000, signHost = HOST) {
      const request = { ...(await signed(identity, 'provision', originPort, signHost)), originPort };
      return provisioner.provision(state.pool, HOST, request);
    },
    async release(identity: DaemonIdentity) {
      return provisioner.release(state.pool, HOST, await signed(identity, 'release'));
    },
  };
}

function expectOk<T>(outcome: { ok: true; value: T } | { ok: false; code: string; message: string }): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.code}: ${outcome.message}`);
  return outcome.value;
}

describe('provisioning a tunnel', () => {
  it('should create the tunnel, its ingress and a proxied CNAME, and answer the connector token', async () => {
    const pool = poolAccount(1);
    const test = world(pool);
    const daemon = await newDaemonIdentity();
    const answer = expectOk(await test.provision(daemon, 41_234));
    should(TunnelProvisionSchema.parse(answer)).eql(answer);
    should(answer.renewAfterSeconds).equal(DEFAULT_TUNNEL_RENEW_SECONDS);

    const [tunnel] = test.cloudflare.liveTunnels(pool.accountId);
    if (tunnel === undefined) throw new Error('expected a tunnel');
    const hostname = new URL(answer.tunnelUrl).hostname;
    should(answer.connectorToken).equal(tunnel.token);
    should(tunnel.name).equal(`fy-${hostname.split('.')[0]}`);
    should(tunnel.ingress).eql(tunnelIngress(hostname, daemon.daemonId, 41_234));
    should([...test.cloudflare.records.values()]).eql([
      {
        id: test.store.active.get(daemon.daemonId)?.dnsRecordId,
        zoneId: pool.zoneId,
        type: 'CNAME',
        name: hostname,
        content: `${tunnel.id}.cfargotunnel.com`,
        proxied: true,
      },
    ]);
    // One random label, one level under the zone, and nothing of the fingerprint in it.
    should(hostname).match(/^[a-z2-7]{16}\.tunnels-1\.example\.com$/);
    should(daemon.daemonId.toLowerCase()).not.containEql(hostname.split('.')[0] as string);
    // The token is fetched, never stored.
    should(JSON.stringify([...test.store.rows()])).not.containEql(FAKE_CONNECTOR_TOKEN_PREFIX);
  });

  it('should fill accounts in the pool order, and refuse capacity once every accepting one is full', async () => {
    const first = poolAccount(1, { maxTunnels: 2 });
    const second = poolAccount(2, { maxTunnels: 1 });
    const test = world(first, second);
    const daemons = await Promise.all([1, 2, 3, 4].map(() => newDaemonIdentity()));
    const placed: string[] = [];
    for (const daemon of daemons.slice(0, 3)) {
      expectOk(await test.provision(daemon));
      placed.push(test.store.active.get(daemon.daemonId)?.account as string);
    }
    should(placed).eql(['pool-1', 'pool-1', 'pool-2']);
    const full = await test.provision(daemons[3] as DaemonIdentity);
    should(full).match({ ok: false, code: 'tunnel_capacity' });
  });

  it('should stop at the account ceiling Cloudflare enforces, whatever maxTunnels says', async () => {
    const pool = poolAccount(1);
    const test = world(pool);
    test.cloudflare.tunnelLimit = 1;
    expectOk(await test.provision(await newDaemonIdentity()));
    should(await test.provision(await newDaemonIdentity())).match({ ok: false, code: 'tunnel_upstream_failed' });
  });

  it('should place nothing on a draining account but keep renewing the tunnels it holds', async () => {
    const draining = poolAccount(1);
    const open = poolAccount(2);
    const test = world(draining, open);
    const old = await newDaemonIdentity();
    const first = expectOk(await test.provision(old));
    test.state.pool = ready({ ...draining, accepting: false }, open);

    const newcomer = await newDaemonIdentity();
    expectOk(await test.provision(newcomer));
    should(test.store.active.get(newcomer.daemonId)?.account).equal('pool-2');
    const renewed = expectOk(await test.provision(old));
    should(renewed.tunnelUrl).equal(first.tunnelUrl);

    test.state.pool = ready({ ...draining, accepting: false });
    should(await test.provision(await newDaemonIdentity())).match({ ok: false, code: 'tunnel_unavailable' });
  });

  it('should skip an account whose zone is in another account, remember why, and say so', async () => {
    const wrong = poolAccount(1);
    const right = poolAccount(2);
    const test = world(right);
    test.cloudflare.addAccount(wrong, right.accountId);
    test.state.pool = ready(wrong, right);

    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    should(test.store.active.get(daemon.daemonId)?.account).equal('pool-2');
    should(test.cloudflare.liveTunnels(wrong.accountId)).be.empty();
    expectOk(await test.provision(await newDaemonIdentity()));
    // The verdict is cached: each zone was asked about once.
    should(test.cloudflare.count('zone')).equal(2);

    const status = await test.provisioner.status(test.state.pool);
    should(status.accounts.map(account => account.zoneCheck)).eql(['failed', 'passed']);

    test.state.pool = ready(wrong);
    should(await test.provisioner.advertise(test.state.pool)).eql({ version: 1, available: false });
    should(await test.provision(await newDaemonIdentity())).match({ ok: false, code: 'tunnel_unavailable' });
  });

  it('should treat a zone Cloudflare will not show as misconfigured', async () => {
    const pool = poolAccount(1);
    const test = world(pool);
    test.cloudflare.fail('zone', 'not_found');
    should(await test.provision(await newDaemonIdentity())).match({ ok: false, code: 'tunnel_unavailable' });
    should((await test.provisioner.status(test.state.pool)).accounts[0]?.zoneCheck).equal('failed');
  });

  it('should answer upstream failure when a zone check could not reach Cloudflare, and try the next account', async () => {
    const first = poolAccount(1);
    const second = poolAccount(2);
    const test = world(first, second);
    test.cloudflare.fail('zone');
    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    should(test.store.active.get(daemon.daemonId)?.account).equal('pool-2');

    const alone = world(first);
    alone.cloudflare.fail('zone');
    const failed = await alone.provision(await newDaemonIdentity());
    should(failed).match({ ok: false, code: 'tunnel_upstream_failed', detail: /pool-1: zone check/ });
  });
});

describe('renewing a tunnel', () => {
  it('should hand back the same hostname, stamp it, and leave the ingress alone while the port holds', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const first = expectOk(await test.provision(daemon, 4000));
    const configures = test.cloudflare.count('configureTunnel');
    const before = test.store.active.get(daemon.daemonId)?.lastSeenAt as number;

    const again = expectOk(await test.provision(daemon, 4000));
    should(again.tunnelUrl).equal(first.tunnelUrl);
    should(test.cloudflare.count('configureTunnel')).equal(configures);
    should(test.cloudflare.count('createTunnel')).equal(1);
    should(test.store.active.get(daemon.daemonId)?.lastSeenAt).be.above(before);
  });

  it('should rewrite the ingress when the port changed', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const first = expectOk(await test.provision(daemon, 4000));
    const moved = expectOk(await test.provision(daemon, 5000));
    should(moved.tunnelUrl).equal(first.tunnelUrl);
    const [tunnel] = test.cloudflare.liveTunnels();
    should(tunnel?.ingress).eql(tunnelIngress(new URL(first.tunnelUrl).hostname, daemon.daemonId, 5000));
    should(test.cloudflare.count('configureTunnel')).equal(2);
  });

  it('should answer upstream failure when the connector token cannot be read, and keep the tunnel', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    test.cloudflare.fail('tunnelToken');
    should(await test.provision(daemon)).match({
      ok: false,
      code: 'tunnel_upstream_failed',
      detail: /connector token/,
    });
    expectOk(await test.provision(daemon));
    should(test.cloudflare.count('createTunnel')).equal(1);
  });
});

describe('recovering a half-made tunnel', () => {
  it('should finish from the row after any step fails, never making a second tunnel', async () => {
    for (const step of ['findTunnel', 'createTunnel', 'configureTunnel', 'findDnsRecord', 'createDnsRecord'] as const) {
      const test = world(poolAccount(1));
      const daemon = await newDaemonIdentity();
      test.cloudflare.fail(step);
      const failed = await test.provision(daemon);
      should(failed).match({ ok: false, code: 'tunnel_upstream_failed' });
      should(test.store.active.has(daemon.daemonId)).be.true();
      expectOk(await test.provision(daemon));
      should(test.cloudflare.liveTunnels()).have.length(1);
      should(test.cloudflare.records.size).equal(1);
    }
  });

  it('should adopt a tunnel and a record whose creation committed but whose answer was lost', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    test.cloudflare.fail('createTunnel', 'failed', true);
    should(await test.provision(daemon)).match({ ok: false, code: 'tunnel_upstream_failed' });
    should(test.cloudflare.liveTunnels()).have.length(1);
    test.cloudflare.fail('createDnsRecord', 'failed', true);
    should(await test.provision(daemon)).match({ ok: false, code: 'tunnel_upstream_failed' });
    const answer = expectOk(await test.provision(daemon));
    should(test.cloudflare.liveTunnels()).have.length(1);
    should(test.cloudflare.records.size).equal(1);
    should(answer.connectorToken).equal(test.cloudflare.liveTunnels()[0]?.token);
  });

  it('should delete a half-made tunnel nobody came back for after a day, found by its name', async () => {
    const test = world(poolAccount(1));
    test.cloudflare.fail('createTunnel', 'failed', true);
    await test.provision(await newDaemonIdentity());
    should(test.cloudflare.liveTunnels()).have.length(1);

    should(await test.provisioner.reclaim(test.state.pool)).match({ retired: 0 });
    test.state.clock += TUNNEL_DAY_MILLISECONDS;
    should(await test.provisioner.reclaim(test.state.pool)).match({ retired: 1, deleted: 1, failed: 0 });
    should(test.cloudflare.liveTunnels()).be.empty();
    should(test.store.rows()).be.empty();
  });
});

describe('releasing a tunnel', () => {
  it('should delete the tunnel, its connections and its record, and say there was one', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    test.cloudflare.connect(test.cloudflare.liveTunnels()[0]?.id as string);
    const released = expectOk(await test.release(daemon));
    should(TunnelReleaseSchema.parse(released)).eql({ version: 1, released: true });
    should(test.cloudflare.liveTunnels()).be.empty();
    should(test.cloudflare.records.size).equal(0);
    should(test.store.rows()).be.empty();
    should(expectOk(await test.release(daemon))).eql({ version: 1, released: false });
  });

  it('should take the tunnel off the daemon at once and leave a failed deletion to the reclaim', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const first = expectOk(await test.provision(daemon));
    test.cloudflare.fail('deleteDnsRecord');
    const released = expectOk(await test.release(daemon));
    should(released).match({ released: true, problem: /delete the DNS record/ });
    should(test.store.retired.size).equal(1);

    // A daemon that switches back on gets a new tunnel while the old one waits to be deleted.
    const again = expectOk(await test.provision(daemon));
    should(again.tunnelUrl).not.equal(first.tunnelUrl);
    should(await test.provisioner.reclaim(test.state.pool)).match({ deleted: 1, failed: 0 });
    should(test.store.retired.size).equal(0);
    should(test.cloudflare.records.size).equal(1);
  });

  it('should refuse a release when no pool is set up', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const request = await test.signed(daemon, 'release');
    should(await test.provisioner.release({ kind: 'absent' }, HOST, request)).match({ code: 'tunnel_unavailable' });
  });
});

describe('reclaiming tunnels', () => {
  it('should delete a tunnel nobody renewed for reclaimAfterDays, and keep one that was renewed', async () => {
    const test = world(poolAccount(1));
    const [stale, fresh] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    expectOk(await test.provision(stale));
    expectOk(await test.provision(fresh));
    test.cloudflare.connect(test.store.active.get(stale.daemonId)?.tunnelId as string);
    should(await test.provisioner.configure({ reclaimAfterDays: 3 })).eql({ reclaimAfterDays: 3 });

    test.state.clock += 2 * TUNNEL_DAY_MILLISECONDS;
    expectOk(await test.provision(fresh));
    test.state.clock += 1 * TUNNEL_DAY_MILLISECONDS;
    const report = await test.provisioner.reclaim(test.state.pool);
    should(report).eql({ retired: 1, deleted: 1, failed: 0, orphaned: 0, more: false, problems: [] });
    should([...test.store.active.keys()]).eql([fresh.daemonId]);
    should(test.cloudflare.liveTunnels()).have.length(1);
    should(test.cloudflare.records.size).equal(1);
  });

  it('should keep a row whose deletion failed a step, and finish it on the next pass', async () => {
    for (const step of [
      'cleanupConnections',
      'deleteTunnel',
      'deleteDnsRecord',
      'findDnsRecord',
      'findTunnel',
    ] as const) {
      const test = world(poolAccount(1));
      const daemon = await newDaemonIdentity();
      expectOk(await test.provision(daemon));
      if (step === 'findDnsRecord' || step === 'findTunnel') {
        // Lookups happen only for a row that never recorded the id — make it so.
        const row = test.store.active.get(daemon.daemonId);
        if (row === undefined) throw new Error('expected a row');
        test.store.active.set(daemon.daemonId, { ...row, [step === 'findTunnel' ? 'tunnelId' : 'dnsRecordId']: null });
      }
      test.state.clock += 31 * TUNNEL_DAY_MILLISECONDS;
      test.cloudflare.fail(step);
      const first = await test.provisioner.reclaim(test.state.pool);
      should(first).match({ retired: 1, deleted: 0, failed: 1 });
      should(first.problems[0]).match(/^pool-1\/[a-z2-7]{16}: /);
      should(test.store.retired.size).equal(1);
      should(await test.provisioner.reclaim(test.state.pool)).match({ retired: 0, deleted: 1, failed: 0 });
      should(test.cloudflare.liveTunnels()).be.empty();
      should(test.cloudflare.records.size).equal(0);
      should(test.store.rows()).be.empty();
    }
  });

  it('should treat a tunnel and record already gone upstream as deleted', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    test.cloudflare.tunnels.clear();
    test.cloudflare.records.clear();
    expectOk(await test.release(daemon));
    should(test.store.rows()).be.empty();
  });

  it('should stop at its deletion budget and say there is more', async () => {
    const test = world(poolAccount(1));
    const daemons = await Promise.all(
      Array.from({ length: TUNNEL_RECLAIM_DELETIONS_PER_PASS + 1 }, () => newDaemonIdentity()),
    );
    for (const daemon of daemons) expectOk(await test.provision(daemon));
    test.state.clock += 31 * TUNNEL_DAY_MILLISECONDS;
    should(await test.provisioner.reclaim(test.state.pool)).match({
      retired: TUNNEL_RECLAIM_DELETIONS_PER_PASS + 1,
      deleted: TUNNEL_RECLAIM_DELETIONS_PER_PASS,
      more: true,
    });
    should(await test.provisioner.reclaim(test.state.pool)).match({ retired: 0, deleted: 1, more: false });
  });

  it('should page through more rows than one page holds', async () => {
    const test = world(poolAccount(1));
    const template = await (async () => {
      expectOk(await test.provision(await newDaemonIdentity()));
      return [...test.store.active.values()][0];
    })();
    if (template === undefined) throw new Error('expected a row');
    for (let index = 0; index < 300; index += 1) {
      const daemonId = `fy_daemon_${String(index).padStart(43, 'z')}`;
      test.store.active.set(daemonId, { ...template, daemonId, label: template.label });
    }
    const status = await test.provisioner.status(test.state.pool);
    should(status.accounts[0]?.liveTunnels).equal(301);
  });
});

describe('an account removed from the pool', () => {
  it('should report its tunnels as orphaned, never call Cloudflare for them, and give a returning daemon a new one', async () => {
    const leaving = poolAccount(1);
    const staying = poolAccount(2);
    const test = world(leaving, staying);
    const [daemon, other] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    expectOk(await test.provision(daemon));
    expectOk(await test.provision(other));
    test.state.pool = ready(staying);

    test.state.clock += 365 * TUNNEL_DAY_MILLISECONDS;
    const calls = test.cloudflare.calls.length;
    should(await test.provisioner.reclaim(test.state.pool)).match({ retired: 0, deleted: 0, orphaned: 2 });
    should(test.cloudflare.calls.length).equal(calls);

    let status = await test.provisioner.status(test.state.pool);
    should(status.orphaned).eql([{ account: 'pool-1', accountId: leaving.accountId, tunnels: 2 }]);

    expectOk(await test.provision(daemon));
    should(test.store.active.get(daemon.daemonId)?.account).equal('pool-2');
    status = await test.provisioner.status(test.state.pool);
    should(status.orphaned).eql([{ account: 'pool-1', accountId: leaving.accountId, tunnels: 2 }]);
    should(status.pendingDeletions).equal(0);

    // The account comes back: the tunnel its daemon moved off is deleted, and the other daemon's — a
    // year without a renewal — is reclaimed like any other.
    test.state.pool = ready(leaving, staying);
    should(await test.provisioner.reclaim(test.state.pool)).match({ retired: 1, deleted: 2, orphaned: 0 });
    should(test.cloudflare.liveTunnels(leaving.accountId)).be.empty();
  });

  it('should count a released tunnel on a removed account as orphaned and leave it retired for the account to return', async () => {
    const leaving = poolAccount(1);
    const staying = poolAccount(2);
    const test = world(leaving, staying);
    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    test.state.pool = ready(staying);

    const released = expectOk(await test.release(daemon));
    should(released).match({ released: true });
    should(released).not.have.property('problem');
    should([...test.store.retired.keys()]).have.length(1);

    const calls = test.cloudflare.calls.length;
    should(await test.provisioner.reclaim(test.state.pool)).eql({
      retired: 0,
      deleted: 0,
      failed: 0,
      orphaned: 1,
      more: false,
      problems: [],
    });
    should(test.cloudflare.calls.length).equal(calls);
    should([...test.store.retired.keys()]).have.length(1);

    test.state.pool = ready(leaving, staying);
    should(await test.provisioner.reclaim(test.state.pool)).match({ deleted: 1, orphaned: 0 });
    should(test.cloudflare.liveTunnels(leaving.accountId)).be.empty();
  });

  it('should leave every row alone while the pool does not parse', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    const broken = parseTunnelAccountPool('not json');
    test.state.clock += 365 * TUNNEL_DAY_MILLISECONDS;
    should(await test.provisioner.reclaim(broken)).match({ retired: 0, orphaned: 1 });
    should(await test.provisioner.advertise(broken)).eql({ version: 1, available: false });
    should(await test.provisioner.challenge(broken, { daemonId: daemon.daemonId })).match({
      code: 'tunnel_unavailable',
    });
  });
});

describe('proving the caller', () => {
  it('should refuse a replayed nonce, a nonce it never issued, and an expired one', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const request = { ...(await test.signed(daemon, 'provision', 4000)), originPort: 4000 };
    expectOk(await test.provisioner.provision(test.state.pool, HOST, request));
    should(await test.provisioner.provision(test.state.pool, HOST, request)).match({
      code: 'tunnel_challenge_expired',
    });

    const late = { ...(await test.signed(daemon, 'provision', 4000)), originPort: 4000 };
    test.state.clock += MINUTE;
    should(await test.provisioner.provision(test.state.pool, HOST, late)).match({ code: 'tunnel_challenge_expired' });
  });

  it('should refuse a signature over another host, and spend the nonce anyway', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const request = { ...(await test.signed(daemon, 'provision', 4000, 'evil.example')), originPort: 4000 };
    should(await test.provisioner.provision(test.state.pool, HOST, request)).match({
      ok: false,
      code: 'tunnel_claim_rejected',
      message: 'signature failed',
    });
    should(await test.provisioner.provision(test.state.pool, HOST, request)).match({
      code: 'tunnel_challenge_expired',
    });
    should(test.cloudflare.calls).be.empty();
  });

  it("should refuse a stranger's key for this fingerprint, and a provision signed for another port", async () => {
    const test = world(poolAccount(1));
    const [daemon, stranger] = await Promise.all([newDaemonIdentity(), newDaemonIdentity()]);
    const theirs = await test.signed(stranger, 'provision', 4000);
    const challenge = await test.provisioner.challenge(test.state.pool, { daemonId: daemon.daemonId });
    const forged = { ...theirs, daemonId: daemon.daemonId, nonce: expectOk(challenge).nonce, originPort: 4000 };
    should(await test.provisioner.provision(test.state.pool, HOST, forged)).match({
      code: 'tunnel_claim_rejected',
      message: 'public key does not match the fingerprint',
    });
    const moved = { ...(await test.signed(daemon, 'provision', 4000)), originPort: 4001 };
    should(await test.provisioner.provision(test.state.pool, HOST, moved)).match({ code: 'tunnel_claim_rejected' });
    should(test.store.rows()).be.empty();
  });

  it('should refuse challenges past the per-daemon bound with tunnel_rate_limited', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const ask = () => test.provisioner.challenge(test.state.pool, { daemonId: daemon.daemonId });
    for (let index = 0; index < 3; index += 1) expectOk(await ask());
    should(await ask()).match({ ok: false, code: 'tunnel_rate_limited' });
  });

  it('should refuse a provision when no pool is set up, before spending anything', async () => {
    const test = world(poolAccount(1));
    const daemon = await newDaemonIdentity();
    const request = { ...(await test.signed(daemon, 'provision', 4000)), originPort: 4000 };
    should(await test.provisioner.provision({ kind: 'absent' }, HOST, request)).match({ code: 'tunnel_unavailable' });
    expectOk(await test.provisioner.provision(test.state.pool, HOST, request));
  });
});

describe('the operator status', () => {
  it('should count tunnels per account and never contain a token of any kind', async () => {
    const first = poolAccount(1);
    const second = poolAccount(2, { accepting: false });
    const test = world(first, second);
    const daemon = await newDaemonIdentity();
    expectOk(await test.provision(daemon));
    test.cloudflare.fail('deleteTunnel');
    expectOk(await test.release(daemon));
    expectOk(await test.provision(await newDaemonIdentity()));
    test.store.damaged = { active: 1, retired: 2 };

    const status = await test.provisioner.status(test.state.pool);
    should(status).match({
      version: 1,
      available: true,
      pool: 'ready',
      settings: { reclaimAfterDays: 30 },
      pendingDeletions: 1,
      damagedRows: 3,
    });
    should(status.accounts.map(account => [account.name, account.liveTunnels])).eql([
      ['pool-1', 2],
      ['pool-2', 0],
    ]);
    const text = JSON.stringify(status);
    for (const token of [first.apiToken, second.apiToken, ...[...test.cloudflare.tunnels.values()].map(t => t.token)]) {
      should(text).not.containEql(token);
    }
    should(text).not.containEql(FAKE_CONNECTOR_TOKEN_PREFIX);
  });
});

describe('damaged tunnel state', () => {
  it('should name what is damaged in a typed error a storage adapter can throw', () => {
    const error = new TunnelStateDamagedError('the active row for one daemon');
    should(error).be.instanceOf(Error);
    should(error.name).equal('TunnelStateDamagedError');
    should(error.message).equal('tunnel service state is damaged: the active row for one daemon');
  });
});
