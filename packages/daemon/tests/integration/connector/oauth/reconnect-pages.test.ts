import { describe, expect, test } from 'bun:test';
import { ConnectorOAuthHttp } from '../../../../src/adapters/connector/oauth-http.ts';
import { CLAUDE_CONNECTORS_URL } from '../../../../src/adapters/connector/pages.ts';
import type { ApiRequest, ApiResponse } from '../../../../src/lib/api/http.ts';
import { ConnectorMemory, base64url } from '../../../../src/lib/connector/oauth/model.ts';
import { ConnectorAuthority } from '../../../../src/lib/connector/oauth/authority.ts';
import { endpoints, fixture, redirectUri, verifier } from '../../../support/connector/oauth-fixture.ts';

const CONNECT = 'Settings &gt; Connectors &gt; Ferretry &gt; Connect';
const APP = 'https://app.example/?connector=daemon-fixture#connector';

function get(path: string, source?: string): ApiRequest {
  const url = new URL(path, endpoints.issuer);
  return {
    method: 'GET',
    path: url.pathname,
    query: new Map([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])),
    headers: new Map(),
    clientAddress: source,
    loopback: true,
    privilegedLoopback: true,
    text: async () => '',
  };
}
function post(path: string, body: string): ApiRequest {
  return {
    ...get(path),
    method: 'POST',
    headers: new Map([['content-type', 'application/x-www-form-urlencoded']]),
    text: async () => body,
  };
}

/** What every "connect again" page owes the person, whatever happened. */
function expectReconnectPage(response: ApiResponse | undefined, headline: string, reference: string): string {
  const body = response?.body ?? '';
  expect(response?.headers.get('content-type')).toContain('text/html');
  expect(response?.headers.get('cache-control')).toBe('no-store');
  expect(response?.headers.get('x-frame-options')).toBe('DENY');
  expect(body).toContain('<html lang="en">');
  expect(body).toContain('name="viewport"');
  expect(body).toContain('prefers-color-scheme:dark');
  expect(body).toContain(`<h1>${headline}</h1>`);
  expect(body).toContain(CONNECT);
  expect(body).toContain(`href="${CLAUDE_CONNECTORS_URL}"`);
  expect(body).toContain(`href="${APP}"`);
  expect(body).toContain(`Reference: ${reference}`);
  // No external assets, no script, nothing that could carry a token.
  expect(body).not.toMatch(/<script|<img|<link|src=|url\(/i);
  expect(body).not.toContain('fyc_');
  return body;
}

describe('connector reconnect pages', () => {
  test('an unknown, malformed or expired waiting handle says the sign-in is gone and how to start again', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const unknown = await http.handle(get(`/oauth/authorize/wait?h=${'a'.repeat(43)}`));
    expect(unknown?.status).toBe(400);
    expectReconnectPage(unknown, 'This sign-in is no longer waiting', 'invalid_request');
    expect(unknown?.body).toContain('approve the new code');
    expectReconnectPage(
      await http.handle(get('/oauth/authorize/wait?h=short')),
      'This sign-in is no longer waiting',
      'invalid_request',
    );
    expectReconnectPage(
      await http.handle(get('/oauth/authorize/wait')),
      'This sign-in is no longer waiting',
      'invalid_request',
    );

    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    f.advance(11 * 60_000);
    expectReconnectPage(
      await http.handle(get(`/oauth/authorize/wait?h=${handle}`)),
      'This sign-in is no longer waiting',
      'invalid_request',
    );
  });

  test('a sign-in the daemon forgot on restart is the same page', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    f.memory.pending.clear();
    expectReconnectPage(
      await http.handle(get(`/oauth/authorize/wait?h=${handle}`)),
      'This sign-in is no longer waiting',
      'invalid_request',
    );
  });

  test('a grant revoked between approval and redemption is a cancelled connection', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    const pending = (await f.authority.pending())[0];
    const approval = await f.authority.approve(pending?.id ?? '', 'admin-cli');
    if (!approval.ok) throw new Error('approval failed');
    await f.authority.revoke(approval.value.id, 'admin-cli');
    const response = await http.handle(get(`/oauth/authorize/wait?h=${handle}`));
    expect(response?.status).toBe(400);
    const body = expectReconnectPage(response, 'This connection was cancelled', 'invalid_request');
    expect(body).toContain('Connecting again is safe');
  });

  test('an unknown client or a redirect problem says the request is not recognised, and never redirects', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    const challenge = base64url(await new TextEncoder().encode(verifier).slice(0, 32));
    const base = { response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256' };
    for (const params of [
      { ...base, client_id: 'fycl_unknown', redirect_uri: redirectUri },
      { ...base, client_id: client.client_id, redirect_uri: 'https://evil.example/cb' },
    ]) {
      const response = await http.handle(get(`/oauth/authorize?${new URLSearchParams(params)}`));
      expect(response?.status).toBe(400);
      expect(response?.headers.has('location')).toBe(false);
      expectReconnectPage(response, 'Ferretry does not recognise this connection request', 'invalid_request');
    }
    expectReconnectPage(
      await http.handle(get('/oauth/authorize')),
      'Ferretry does not recognise this connection request',
      'invalid_request',
    );
  });

  test('too many waiting sign-ins is a busy page with a 503 and no redirect', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const challenge = base64url(new Uint8Array(32).fill(7));
    const start = async (clientId: string, source: string) =>
      await http.handle(
        get(
          `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' })}`,
          source,
        ),
      );
    // Ten sources, two per client: every source holds exactly one, so nobody gives up their place.
    for (let i = 0; i < 5; i++) {
      const client = await f.register();
      expect((await start(client.client_id, `source-${i * 2}`))?.status).toBe(302);
      expect((await start(client.client_id, `source-${i * 2 + 1}`))?.status).toBe(302);
    }
    const newcomer = await f.register();
    const response = await start(newcomer.client_id, 'source-new');
    expect(response?.status).toBe(503);
    const body = expectReconnectPage(response, 'Ferretry has too many sign-ins waiting', 'temporarily_unavailable');
    expect(body).toContain('deny the ones you do not recognise');
  });

  test('a rate limit on a page path is a "wait a minute" page with Retry-After', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    for (let i = 0; i < 60; i++) await http.handle(get(`/oauth/authorize/wait?h=${'a'.repeat(43)}`, 'noisy'));
    const response = await http.handle(get(`/oauth/authorize/wait?h=${'a'.repeat(43)}`, 'noisy'));
    expect(response?.status).toBe(429);
    expect(response?.headers.get('retry-after')).toBe('60');
    expectReconnectPage(response, 'Too many tries in a short time', 'slow_down');
  });

  test('a storage failure is "could not finish", not an OAuth error', async () => {
    const f = fixture();
    const client = await f.register();
    f.breakStore();
    // A daemon that restarted onto unreadable storage: its digest index has never loaded.
    const http = new ConnectorOAuthHttp(
      new ConnectorAuthority({ ...f.options, memory: new ConnectorMemory() }),
      endpoints,
    );
    const response = await http.handle(
      get(
        `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri })}`,
      ),
    );
    expect(response?.status).toBe(503);
    expectReconnectPage(response, 'Ferretry could not finish this sign-in', 'server_error');
  });

  test('a denied sign-in goes back to Claude with words that say how to try again', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    const handle = await f.authorize(client.client_id, { state: 's' });
    await f.authority.deny((await f.authority.pending())[0]?.id ?? '', 'admin-cli');
    const response = await http.handle(get(`/oauth/authorize/wait?h=${handle}`));
    expect(response?.status).toBe(302);
    const location = new URL(response?.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toContain('Settings > Connectors > Ferretry > Connect');
  });

  test('the waiting page tells the person what to do, in both colour schemes, without leaking its handle', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    const response = await http.handle(get(`/oauth/authorize/wait?h=${handle}`));
    const body = response?.body ?? '';
    expect(response?.status).toBe(200);
    expect(body).toContain('<h1>Approve this connection in Ferretry</h1>');
    expect(body).toContain('class="code"');
    expect(body).toContain(`href="${APP}"`);
    expect(body).toContain('If nothing happens');
    expect(body).toContain(CONNECT);
    expect(body).toContain('prefers-color-scheme:dark');
    expect(body).not.toContain(handle);
  });

  test('every JSON error Claude may show tells the person how to reconnect', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const flow = await f.flow();
    const refresh = (token: string) =>
      post(
        '/oauth/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: flow.client.client_id,
          refresh_token: token,
        }).toString(),
      );
    const hint = 'Reconnect in Claude: Settings > Connectors > Ferretry > Connect.';
    // A dead refresh token.
    const dead = JSON.parse((await http.handle(refresh('fyc_rt_' + 'x'.repeat(43))))?.body ?? '');
    expect(dead).toMatchObject({ error: 'invalid_grant' });
    expect(dead.error_description).toContain(hint);
    // Reuse of a rotated-away token cancels the grant for safety, and says so.
    const first = JSON.parse((await http.handle(refresh(flow.tokens.refresh_token ?? '')))?.body ?? '');
    f.advance(2 * 60_000);
    expect(first.refresh_token).toBeTruthy();
    const reused = JSON.parse((await http.handle(refresh(flow.tokens.refresh_token ?? '')))?.body ?? '');
    expect(reused.error).toBe('invalid_grant');
    expect(reused.error_description).toContain('to keep your account safe');
    expect(reused.error_description).toContain('connecting again is safe');
    expect(reused.error_description).toContain(hint);
    // A client the daemon no longer knows.
    const unknown = await http.handle(
      post(
        '/oauth/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: 'fycl_zzzzzzzzzz',
          refresh_token: 'x',
        }).toString(),
      ),
    );
    expect(unknown?.status).toBe(401);
    expect(JSON.parse(unknown?.body ?? '').error_description).toContain(hint);
    // A known client with the wrong secret: the same words, so a stale credential never gets a bare refusal.
    const secretClient = await f.register({ token_endpoint_auth_method: 'client_secret_post' });
    const wrongSecret = await http.handle(
      post(
        '/oauth/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: secretClient.client_id,
          client_secret: 'wrong-secret',
          refresh_token: 'x',
        }).toString(),
      ),
    );
    expect(wrongSecret?.status).toBe(401);
    expect(JSON.parse(wrongSecret?.body ?? '')).toMatchObject({ error: 'invalid_client' });
    expect(JSON.parse(wrongSecret?.body ?? '').error_description).toContain(hint);
    // A malformed Basic header.
    const malformed = await http.handle({
      ...post(
        '/oauth/token',
        new URLSearchParams({ client_id: secretClient.client_id, grant_type: 'refresh_token' }).toString(),
      ),
      headers: new Map([
        ['content-type', 'application/x-www-form-urlencoded'],
        ['authorization', 'Basic !!!'],
      ]),
    });
    expect(malformed?.status).toBe(401);
    expect(JSON.parse(malformed?.body ?? '')).toMatchObject({ error: 'invalid_client' });
    expect(JSON.parse(malformed?.body ?? '').error_description).toContain(hint);
  });
});
