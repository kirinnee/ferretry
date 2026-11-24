import { describe, expect, test } from 'bun:test';
import { ConnectorOAuthHttp } from '../../../../src/adapters/connector/oauth-http.ts';
import { BodyTooLargeError, type ApiRequest } from '../../../../src/lib/api/http.ts';
import { unauthorizedResponse } from '../../../../src/lib/connector/oauth/discovery.ts';
import { endpoints, fixture, redirectUri } from '../../../support/connector/oauth-fixture.ts';

function request(
  method: string,
  path: string,
  body = '',
  contentType = 'application/x-www-form-urlencoded',
  headers: ReadonlyMap<string, string> = new Map(),
): ApiRequest {
  const url = new URL(path, endpoints.issuer);
  return {
    method,
    path: url.pathname,
    query: new Map([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])),
    headers: new Map([['content-type', contentType], ...headers]),
    loopback: true,
    privilegedLoopback: true,
    text: async limit => {
      expect(limit).toBe(8192);
      return body;
    },
  };
}

describe('connector OAuth HTTP boundary', () => {
  test('discovery publishes both protected-resource locations and the complete authorization metadata', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await http.handle(request('GET', path));
      expect(JSON.parse(response?.body ?? '')).toEqual({
        resource: endpoints.resource,
        authorization_servers: [endpoints.issuer],
        scopes_supported: ['fleet:read', 'fleet:write'],
        bearer_methods_supported: ['header'],
      });
    }
    const response = await http.handle(request('GET', '/.well-known/oauth-authorization-server'));
    const metadata = JSON.parse(response?.body ?? '');
    expect(metadata).toMatchObject({
      issuer: endpoints.issuer,
      token_endpoint: `${endpoints.issuer}/oauth/token`,
      registration_endpoint: `${endpoints.issuer}/oauth/register`,
      revocation_endpoint: `${endpoints.issuer}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(metadata.token_endpoint_auth_methods_supported).toEqual([
      'none',
      'client_secret_post',
      'client_secret_basic',
    ]);
  });

  test('401 advertises metadata and marks invalid tokens only when presented', () => {
    const unauthenticated = unauthorizedResponse(endpoints, { tokenPresented: false });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${endpoints.resourceMetadataUrl}", scope="fleet:read fleet:write"`,
    );
    expect(unauthorizedResponse(endpoints, { tokenPresented: true }).headers.get('www-authenticate')).toEndWith(
      'error="invalid_token"',
    );
  });

  test('unclaimed paths and wrong methods reveal no alternate method or daemon routes', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    for (const [method, path] of [
      ['GET', '/v1/sessions'],
      ['GET', '/oauth/token'],
      ['POST', '/oauth/authorize'],
      ['POST', '/.well-known/oauth-authorization-server'],
      ['OPTIONS', '/oauth/token'],
      ['POST', '/mcp'],
    ]) {
      expect(await http.handle(request(method ?? '', path ?? ''))).toBeUndefined();
    }
  });

  test('token and revoke accept form encoding only; body reads stay bounded', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    for (const path of ['/oauth/token', '/oauth/revoke']) {
      const response = await http.handle(request('POST', path, '{}', 'application/json'));
      expect(response?.status).toBe(415);
      expect(response?.headers.get('cache-control')).toBe('no-store');
      expect(JSON.parse(response?.body ?? '').error).toBe('invalid_request');
    }
    const body = request('POST', '/oauth/token');
    const tooLarge = await http.handle({
      ...body,
      text: async limit => {
        expect(limit).toBe(8192);
        throw new BodyTooLargeError(8192);
      },
    });
    expect(tooLarge?.status).toBe(413);
    expect((await http.handle(request('POST', '/oauth/register', 'x'.repeat(8193))))?.status).toBe(413);
  });

  test('register parses JSON or form arrays and refuses malformed metadata', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const form = new URLSearchParams({ redirect_uris: JSON.stringify([redirectUri]), client_name: 'Form client' });
    expect((await http.handle(request('POST', '/oauth/register', form.toString())))?.status).toBe(201);
    const json = await http.handle(
      request(
        'POST',
        '/oauth/register',
        JSON.stringify({ redirect_uris: [redirectUri] }),
        'application/json; charset=utf-8',
      ),
    );
    expect(json?.status).toBe(201);
    expect(json?.headers.get('cache-control')).toBe('no-store');
    for (const body of [
      '{',
      '{}',
      JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_jwt' }),
      JSON.stringify({ redirect_uris: [redirectUri], response_types: ['token'] }),
    ]) {
      expect((await http.handle(request('POST', '/oauth/register', body, 'application/json')))?.status).toBe(400);
    }
    const badRedirect = await http.handle(
      request(
        'POST',
        '/oauth/register',
        JSON.stringify({ redirect_uris: ['https://evil.example/callback'] }),
        'application/json',
      ),
    );
    expect(JSON.parse(badRedirect?.body ?? '').error).toBe('invalid_redirect_uri');
  });

  test('client or redirect problems render local HTML and never redirect', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    for (const clientId of ['unknown', client.client_id]) {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: 'https://evil.example/callback',
      });
      const response = await http.handle(request('GET', `/oauth/authorize?${params}`));
      expect(response?.status).toBe(400);
      expect(response?.headers.has('location')).toBe(false);
      expect(response?.headers.get('content-type')).toContain('text/html');
      expect(response?.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  test('waiting HTML escapes every client value, applies browser restrictions and links the machine', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register({ client_name: '<script>"evil"&\'</script>' });
    const handle = await f.authorize(client.client_id);
    const response = await http.handle(request('GET', `/oauth/authorize/wait?h=${handle}`));
    expect(response?.status).toBe(200);
    expect(response?.body).toContain('&lt;script&gt;&quot;evil&quot;&amp;&#39;&lt;/script&gt;');
    expect(response?.body).not.toContain('<script>');
    expect(response?.body).toContain('https://app.example/?connector=daemon-fixture#connector');
    expect(response?.body).toContain('<meta http-equiv="refresh" content="2">');
    expect(response?.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response?.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(response?.headers.get('x-frame-options')).toBe('DENY');
  });

  test('unknown, expired, repeated or malformed handles render errors without redirects', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const client = await f.register();
    const handle = await f.authorize(client.client_id);
    f.advance(600_000);
    for (const query of [`h=${handle}`, 'h=unknown', `h=${'x'.repeat(43)}`, `h=${handle}&h=${handle}`, '']) {
      const response = await http.handle(request('GET', `/oauth/authorize/wait?${query}`));
      expect(response?.status).toBe(400);
      expect(response?.headers.has('location')).toBe(false);
    }
  });

  test('Basic client authentication works and multiple methods or duplicate parameters are refused', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const flow = await f.approved({ token_endpoint_auth_method: 'client_secret_basic' });
    const headers = new Map([
      ['authorization', `Basic ${btoa(`${flow.client.client_id}:${flow.client.client_secret}`)}`],
    ]);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: flow.code,
      redirect_uri: redirectUri,
      code_verifier: flow.exchange.code_verifier ?? '',
    });
    expect(
      (await http.handle(request('POST', '/oauth/token', `${body}&client_secret=second`, undefined, headers)))?.status,
    ).toBe(401);
    expect(
      (await http.handle(request('POST', '/oauth/token', `${body}&code=second`, undefined, headers)))?.status,
    ).toBe(400);
    const answer = await http.handle(request('POST', '/oauth/token', body.toString(), undefined, headers));
    expect(answer?.status).toBe(200);
    expect(JSON.parse(answer?.body ?? '').access_token).toStartWith('fyc_at_');
  });

  test('RFC7009 always returns 200 for authenticated unknown, expired, or already-revoked tokens', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const flow = await f.flow();
    for (const token of ['unknown', flow.tokens.access_token, flow.tokens.access_token]) {
      const answer = await http.handle(
        request('POST', '/oauth/revoke', new URLSearchParams({ client_id: flow.client.client_id, token }).toString()),
      );
      expect(answer?.status).toBe(200);
    }
    expect(await f.authority.verify(flow.tokens.access_token)).toBeUndefined();
  });

  test('HTTP rate refusal includes Retry-After and no-store OAuth JSON', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    const query = new URLSearchParams({ response_type: 'code', client_id: 'unknown', redirect_uri: redirectUri });
    for (let i = 0; i < 30; i++) await http.handle(request('GET', `/oauth/authorize?${query}`));
    const response = await http.handle(request('GET', `/oauth/authorize?${query}`));
    expect(response?.status).toBe(429);
    expect(response?.headers.get('retry-after')).toBe('60');
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(response?.body ?? '').error).toBe('slow_down');
  });

  test('malformed requests spend endpoint budgets before parsing or reading their bodies', async () => {
    const f = fixture();
    const http = new ConnectorOAuthHttp(f.authority, endpoints);
    for (let i = 0; i < 30; i++) expect((await http.handle(request('GET', '/oauth/authorize')))?.status).toBe(400);
    expect((await http.handle(request('GET', '/oauth/authorize')))?.status).toBe(429);
    for (let i = 0; i < 120; i++)
      expect((await http.handle(request('POST', '/oauth/token', '{}', 'application/json')))?.status).toBe(415);
    const response = await http.handle({
      ...request('POST', '/oauth/token'),
      text: async () => {
        throw new Error('Must never read after budget refusal');
      },
    });
    expect(response?.status).toBe(429);
    for (let i = 0; i < 10; i++)
      expect((await http.handle(request('POST', '/oauth/register', '{', 'application/json')))?.status).toBe(400);
    expect((await http.handle(request('POST', '/oauth/register', '{', 'application/json')))?.status).toBe(429);
  });
});
