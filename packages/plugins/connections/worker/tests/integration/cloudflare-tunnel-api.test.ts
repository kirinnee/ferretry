import { describe, it } from 'bun:test';
import should from 'should';
import { CLOUDFLARE_API_BASE, CloudflareFetchTunnelApi } from '../../src/adapters/index.ts';
import { type TunnelAccount, TunnelAccountSchema, tunnelIngress } from '../../src/lib/index.ts';

const TOKEN = 'cf-api-token-never-logged';
const account: TunnelAccount = TunnelAccountSchema.parse({
  name: 'pool-a',
  accountId: 'a'.repeat(32),
  apiToken: TOKEN,
  zoneId: 'b'.repeat(32),
  zone: 'tunnels-a.example.com',
});
const accountPath = `${CLOUDFLARE_API_BASE}/accounts/${'a'.repeat(32)}`;
const zonePath = `${CLOUDFLARE_API_BASE}/zones/${'b'.repeat(32)}`;

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

/** Cloudflare's envelope, answered for whatever request arrives; every request is recorded. */
function api(answer: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const client = new CloudflareFetchTunnelApi(async request => {
    const text = await request.text();
    const entry = {
      method: request.method,
      url: request.url,
      authorization: request.headers.get('Authorization'),
      body: text === '' ? undefined : JSON.parse(text),
    };
    seen.push(entry);
    return answer(entry);
  });
  return { client, seen };
}

const success = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });

describe('the Cloudflare tunnel API adapter', () => {
  it('should send the account token as a bearer and nowhere else, and read each answer', async () => {
    const { client, seen } = api(({ method, url }) => {
      if (url === zonePath)
        return success({ id: 'b'.repeat(32), name: account.zone, account: { id: account.accountId } });
      if (method === 'GET' && url.startsWith(`${accountPath}/cfd_tunnel?`)) return success([{ id: 'tunnel-1' }]);
      if (method === 'POST' && url === `${accountPath}/cfd_tunnel`) return success({ id: 'tunnel-2', token: 'x' });
      if (url.endsWith('/token')) return success('connector-token');
      if (method === 'GET' && url.startsWith(`${zonePath}/dns_records?`)) return success([]);
      if (method === 'POST' && url === `${zonePath}/dns_records`) return success({ id: 'record-1' });
      return success(null);
    });
    const ingress = tunnelIngress('h.tunnels-a.example.com', `fy_daemon_${'c'.repeat(43)}`, 4000);

    should(await client.zone(account)).eql({ ok: true, value: { accountId: account.accountId, name: account.zone } });
    should(await client.findTunnel(account, 'fy-label')).eql({ ok: true, value: { id: 'tunnel-1' } });
    should(await client.createTunnel(account, 'fy-label')).eql({ ok: true, value: { id: 'tunnel-2' } });
    should(await client.configureTunnel(account, 'tunnel-2', ingress)).eql({ ok: true, value: null });
    should(await client.tunnelToken(account, 'tunnel-2')).eql({ ok: true, value: 'connector-token' });
    should(await client.cleanupConnections(account, 'tunnel-2')).eql({ ok: true, value: null });
    should(await client.deleteTunnel(account, 'tunnel-2')).eql({ ok: true, value: null });
    should(await client.findDnsRecord(account, 'h.tunnels-a.example.com')).eql({ ok: true, value: null });
    should(await client.createDnsRecord(account, 'h.tunnels-a.example.com', 'tunnel-2.cfargotunnel.com')).eql({
      ok: true,
      value: { id: 'record-1' },
    });
    should(await client.deleteDnsRecord(account, 'record-1')).eql({ ok: true, value: null });

    should(seen.map(({ method, url }) => `${method} ${url}`)).eql([
      `GET ${zonePath}`,
      `GET ${accountPath}/cfd_tunnel?name=fy-label&is_deleted=false`,
      `POST ${accountPath}/cfd_tunnel`,
      `PUT ${accountPath}/cfd_tunnel/tunnel-2/configurations`,
      `GET ${accountPath}/cfd_tunnel/tunnel-2/token`,
      `DELETE ${accountPath}/cfd_tunnel/tunnel-2/connections`,
      `DELETE ${accountPath}/cfd_tunnel/tunnel-2`,
      `GET ${zonePath}/dns_records?type=CNAME&name=h.tunnels-a.example.com`,
      `POST ${zonePath}/dns_records`,
      `DELETE ${zonePath}/dns_records/record-1`,
    ]);
    should(new Set(seen.map(entry => entry.authorization))).eql(new Set([`Bearer ${TOKEN}`]));
    should(seen.map(entry => entry.body).filter(body => body !== undefined)).eql([
      { name: 'fy-label', config_src: 'cloudflare' },
      { config: { ingress } },
      {
        type: 'CNAME',
        proxied: true,
        name: 'h.tunnels-a.example.com',
        content: 'tunnel-2.cfargotunnel.com',
        comment: 'ferretry hosted tunnel',
      },
    ]);
    should(JSON.stringify(seen.map(({ url, body }) => ({ url, body })))).not.containEql(TOKEN);
  });

  it('should classify failures by status and quote Cloudflare errors without the token', async () => {
    const statuses = [404, 403, 429, 500];
    let index = 0;
    const { client } = api(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [
              { code: 1022, message: `cannot delete; token ${TOKEN} echoed` },
              { code: 2, message: 'b' },
              { code: 3, message: 'c' },
              { code: 4, message: 'd' },
            ],
            result: null,
          }),
          { status: statuses[index++] },
        ),
    );
    const kinds = [];
    for (const _ of statuses) {
      const answer = await client.deleteTunnel(account, 'tunnel-1');
      if (answer.ok) throw new Error('expected a failure');
      should(answer.reason).not.containEql(TOKEN);
      should(answer.reason).containEql('[redacted]');
      should(answer.reason).not.containEql('4 d');
      kinds.push(answer.kind);
    }
    should(kinds).eql(['not_found', 'refused', 'failed', 'failed']);
  });

  it('should read success:false on a 200 as a failure, and an empty error list as just the status', async () => {
    const { client } = api(() => Response.json({ success: false, result: null }));
    should(await client.tunnelToken(account, 'tunnel-1')).eql({
      ok: false,
      kind: 'failed',
      reason: `GET /accounts/${'a'.repeat(32)}/cfd_tunnel/tunnel-1/token answered 200`,
    });
  });

  it('should answer a typed failure when Cloudflare cannot be reached, answers garbage, or answers a strange shape', async () => {
    const unreachable = api(() => {
      throw new TypeError('network down');
    });
    should(await unreachable.client.findTunnel(account, 'fy-x')).eql({
      ok: false,
      kind: 'failed',
      reason: `GET /accounts/${'a'.repeat(32)}/cfd_tunnel could not reach Cloudflare`,
    });
    const garbage = api(() => new Response('<html>bad gateway</html>', { status: 502 }));
    should(await garbage.client.createTunnel(account, 'fy-x')).match({
      ok: false,
      kind: 'failed',
      reason: /502 unreadably/,
    });
    const missing = api(() => new Response('nope', { status: 404 }));
    should(await missing.client.deleteDnsRecord(account, 'r')).match({ ok: false, kind: 'not_found' });
    const strange = api(() => success({ unexpected: true }));
    should(await strange.client.createDnsRecord(account, 'h', 't')).match({ ok: false, reason: /unexpected shape/ });
    should(await strange.client.zone(account)).match({ ok: false, reason: /unexpected shape/ });
    should(await strange.client.findDnsRecord(account, 'h')).match({ ok: false, reason: /unexpected shape/ });
    for (const call of [
      () => strange.client.configureTunnel(account, 't', []),
      () => strange.client.cleanupConnections(account, 't'),
    ]) {
      should(await call()).eql({ ok: true, value: null });
    }
    const failing = api(() => new Response(JSON.stringify({ success: false, errors: [] }), { status: 500 }));
    for (const call of [
      () => failing.client.zone(account),
      () => failing.client.findTunnel(account, 'n'),
      () => failing.client.configureTunnel(account, 't', []),
      () => failing.client.cleanupConnections(account, 't'),
      () => failing.client.findDnsRecord(account, 'h'),
    ]) {
      should(await call()).match({ ok: false, kind: 'failed' });
    }
  });

  it('should default to the global fetch and the public API origin', () => {
    should(new CloudflareFetchTunnelApi()).be.instanceOf(CloudflareFetchTunnelApi);
    should(CLOUDFLARE_API_BASE).equal('https://api.cloudflare.com/client/v4');
  });
});
