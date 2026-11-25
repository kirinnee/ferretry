import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { bootRealDaemon, SEEDED_FERRET, type RealDaemon } from '../support/daemon.ts';

/**
 * The connector END TO END on a REAL daemon: the production `fyd` (every real plugin, the real route spine, Gate and the
 * kernel's public door) on a temp FY_HOME, the real `fy` as the owner, and a real HTTP client at the connector's own
 * address. Own listener on 7480-7499; the address is a fake loopback host. Nothing here is a fixture of the daemon's answers.
 */
const PORT = 7480;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const CALLBACK = 'http://127.0.0.1:7481/cb';
const VERIFIER = 'e2e-verifier-'.padEnd(43, 'x');

const CONFIG = `enabled: true\npublicUrl: ${ORIGIN}\nport: ${String(PORT)}\nextraRedirectUris:\n  - ${CALLBACK}\n`;

let daemon: RealDaemon;
beforeAll(async () => {
  // The file is on disk BEFORE the first boot, so it is an edit nobody confirmed: it turns the connector on, which loosens.
  daemon = await bootRealDaemon({ 'config/connector.yaml': CONFIG });
}, 180_000);
afterAll(async () => {
  await daemon?.dispose();
});

const challenge = async (): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))).toString('base64url');

async function post(path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  return await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.50', ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

describe('the connector on a real daemon, at its own address', () => {
  test('S1: a file that turns the connector on is HELD for the owner: nothing listens, and `fy connector` says why', async () => {
    const held = await daemon.fy(['connector', '--json']);
    expect(held.json).toMatchObject({ enabled: false, switchedOn: false });
    expect((held.json as { disabledReason: string }).disabledReason).toContain('waiting for your confirmation');
    await expect(fetch(`${ORIGIN}/oauth/register`, { method: 'POST' })).rejects.toBeDefined();
  });

  test('the owner confirms it at the machine, and the listener opens LIVE (no restart)', async () => {
    const put = await daemon.call('PUT', '/v1/config/file', { path: 'connector.yaml', text: CONFIG });
    expect(put.status, put.text).toBe(200);
    for (let wait = 0; wait < 50; wait++) {
      if ((await fetch(`${ORIGIN}/oauth/authorize/wait`).catch(() => undefined))?.status === 400) break;
      await Bun.sleep(100);
    }
  });

  test('`fy connector` says it is on, where, and that nothing is waiting', async () => {
    const status = await daemon.fy(['connector', '--json']);
    expect(status.code, status.err).toBe(0);
    expect(status.json).toMatchObject({
      enabled: true,
      switchedOn: true,
      publicUrlSource: 'configured',
      mcpUrl: `${ORIGIN}/mcp`,
      pending: [],
      grants: [],
    });
  });

  test('the door serves ONLY its own paths: /v1/*, the admin token and the daemon API are 404 there (S2)', async () => {
    const admin = (await readFile(join(daemon.home, 'state/gate/admin-token'), 'utf8')).trim();
    for (const path of ['/v1/ferrets', '/v1/connector', '/healthz', '/metrics', '/nothing/here']) {
      for (const headers of [{} as Record<string, string>, { authorization: `Bearer ${admin}` }]) {
        const answer = await fetch(`${ORIGIN}${path}`, { headers });
        expect(answer.status, `${path} ${Object.keys(headers).length === 0 ? 'no credential' : 'admin token'}`).toBe(
          404,
        );
      }
    }
    // And the OAuth paths are NOT served on the daemon's own API listener (which has no door).
    const viaApi = await daemon.call('GET', '/.well-known/oauth-authorization-server');
    expect(viaApi.status).toBe(404);
  });

  test('a whole sign-in: DCR → authorize (S256) → the waiting page → `fy connector approve` → code+iss → token → refresh → reuse revokes → revoke', async () => {
    const registered = await fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.50' },
      body: JSON.stringify({
        client_name: 'E2E Claude',
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };

    const authorize = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
      state: 'e2e-state',
      resource: `${ORIGIN}/mcp`,
    });
    const started = await fetch(`${ORIGIN}/oauth/authorize?${authorize.toString()}`, {
      redirect: 'manual',
      headers: { 'cf-connecting-ip': '203.0.113.50' },
    });
    expect(started.status).toBe(302);
    const waitUrl = started.headers.get('location') ?? '';
    expect(waitUrl.startsWith(`${ORIGIN}/oauth/authorize/wait?h=`)).toBe(true);

    const page = await fetch(waitUrl, { redirect: 'manual' });
    const html = await page.text();
    const code = /<strong class="code">([A-Z0-9]{3}-[A-Z0-9]{3})<\/strong>/u.exec(html)?.[1];
    expect(page.status).toBe(200);
    expect(code, html).toBeDefined();
    expect(html).toContain('If nothing happens');

    const waiting = await daemon.fy(['connector', '--json']);
    expect(waiting.json).toMatchObject({
      pending: [expect.objectContaining({ matchCode: code, clientName: 'E2E Claude' })],
    });
    // No handle, no code, no token in what the owner reads.
    expect(waiting.out).not.toContain(waitUrl.split('h=')[1] ?? 'missing');

    const approved = await daemon.fy(['connector', 'approve', code ?? '']);
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toContain('Approved "E2E Claude"');

    const redirected = await fetch(waitUrl, { redirect: 'manual' });
    expect(redirected.status).toBe(302);
    const callback = new URL(redirected.headers.get('location') ?? '');
    expect(`${callback.origin}${callback.pathname}`).toBe(CALLBACK);
    expect(callback.searchParams.get('iss')).toBe(ORIGIN);
    expect(callback.searchParams.get('state')).toBe('e2e-state');

    const exchanged = await post('/oauth/token', {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: callback.searchParams.get('code') ?? '',
      code_verifier: VERIFIER,
      redirect_uri: CALLBACK,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };

    // /mcp knows the token (the tools themselves arrive in a later unit) and refuses a stranger.
    const mcp = (token: string) =>
      fetch(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
        }),
      });
    // A live bearer reaches the SDK: initialize is answered (the tools themselves are proved in mcp-real-daemon.test.ts).
    expect((await mcp(tokens.access_token)).status).toBe(200);
    expect((await mcp('fyc_at_' + 'x'.repeat(43))).status).toBe(401);
    expect((await fetch(`${ORIGIN}/mcp`, { method: 'POST' })).status).toBe(401);
    expect((await fetch(`${ORIGIN}/mcp`)).status).toBe(405);

    const refresh = (token: string) =>
      post('/oauth/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: token });
    const rotated = (await (await refresh(tokens.refresh_token)).json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect((await refresh(tokens.refresh_token)).status).toBe(200); // the one lost-response retry
    expect((await refresh(tokens.refresh_token)).status).toBe(400); // reuse: the grant ends
    expect((await mcp(rotated.access_token)).status).toBe(401);

    const after = await daemon.fy(['connector', '--json']);
    expect(after.json).toMatchObject({
      grants: [expect.objectContaining({ clientName: 'E2E Claude', revokedAt: expect.any(String) })],
    });
    expect((await post('/oauth/revoke', { client_id: client.client_id, token: rotated.access_token })).status).toBe(
      200,
    );

    // S6: nothing the daemon wrote holds a token, a code or a handle, and the state is 0600.
    const secrets = [
      tokens.access_token,
      tokens.refresh_token,
      rotated.access_token,
      rotated.refresh_token,
      callback.searchParams.get('code') ?? '',
      waitUrl.split('h=')[1] ?? '',
    ];
    const dir = join(daemon.home, 'state/connector');
    for (const name of await readdir(dir)) {
      const text = await readFile(join(dir, name), 'utf8');
      for (const secret of secrets) expect(text, name).not.toContain(secret);
    }
    expect((await stat(join(dir, 'connector.json'))).mode & 0o777).toBe(0o600);
    const audit = await daemon.call('GET', '/v1/audit');
    for (const secret of secrets) expect(audit.text).not.toContain(secret);
    // ... nor does anything the daemon printed.
    for (const secret of secrets) expect(daemon.output()).not.toContain(secret);
    expect(audit.text).toContain('connector.grant-approved');
  }, 60_000);

  test('the owner can end a grant; denying turns a sign-in down with access_denied and the way to reconnect', async () => {
    const registered = await fetch(`${ORIGIN}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.51' },
      body: JSON.stringify({ client_name: 'Second', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
    });
    const client = (await registered.json()) as { client_id: string };
    const authorize = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: CALLBACK,
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
    });
    const waitUrl =
      (
        await fetch(`${ORIGIN}/oauth/authorize?${authorize.toString()}`, {
          redirect: 'manual',
          headers: { 'cf-connecting-ip': '203.0.113.51' },
        })
      ).headers.get('location') ?? '';
    const html = await (await fetch(waitUrl)).text();
    const code = /<strong class="code">([A-Z0-9]{3}-[A-Z0-9]{3})<\/strong>/u.exec(html)?.[1] ?? '';
    const denied = await daemon.fy(['connector', 'deny', code]);
    expect(denied.code, denied.err).toBe(0);
    const back = await fetch(waitUrl, { redirect: 'manual' });
    const target = new URL(back.headers.get('location') ?? '');
    expect(target.searchParams.get('error')).toBe('access_denied');
    expect(target.searchParams.get('error_description')).toContain('Settings > Connectors > Ferretry > Connect');
    const again = await daemon.fy(['connector', 'approve', code]);
    expect(again.code).toBe(1);
  }, 60_000);

  test("a ferret cannot approve its own client: its REAL credential is refused by the person's route, not by a bad bearer", async () => {
    // The seeded ferret's own credential authenticates (it can read its own record) ...
    const own = await daemon.call('GET', `/v1/ferrets/${SEEDED_FERRET}`, undefined, {
      authorization: `Bearer ${daemon.ferretToken}`,
    });
    expect(own.status, own.text).toBe(200);
    // ... and the owner routes still refuse it as a ferret (never 401 bad credential), with nothing approved.
    for (const [method, path] of [
      ['POST', '/v1/connector/requests/ZZZ-ZZZ/approve'],
      ['POST', '/v1/connector/requests/ZZZ-ZZZ/deny'],
      ['PUT', '/v1/connector'],
    ] as const) {
      const refused = await daemon.call(method, path, method === 'PUT' ? { enabled: false } : {}, {
        authorization: `Bearer ${daemon.ferretToken}`,
      });
      expect(refused.status, `${method} ${path}: ${refused.text}`).toBe(403);
      expect(refused.text).not.toContain('bad_credential');
    }
    const after = await daemon.fy(['connector', '--json']);
    expect(after.json).toMatchObject({ enabled: true, switchedOn: true });
  });

  test('a page for a sign-in that is gone says how to connect again, and is 400 HTML', async () => {
    const gone = await fetch(`${ORIGIN}/oauth/authorize/wait?h=${'a'.repeat(43)}`);
    expect(gone.status).toBe(400);
    expect(gone.headers.get('content-type')).toContain('text/html');
    expect(await gone.text()).toContain('This sign-in is no longer waiting');
  });
});
