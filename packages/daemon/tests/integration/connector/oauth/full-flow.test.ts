import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileConnectorStore, ConnectorStoreError } from '../../../../src/adapters/connector/file-store.ts';
import { ConnectorOAuthHttp } from '../../../../src/adapters/connector/oauth-http.ts';
import { webCryptoConnector } from '../../../../src/adapters/connector/webcrypto.ts';
import type { ApiRequest } from '../../../../src/lib/api/http.ts';
import { ConnectorAuthority } from '../../../../src/lib/connector/oauth/authority.ts';
import { ConnectorMemory, base64url } from '../../../../src/lib/connector/oauth/model.ts';
import { ConnectorRateLimiter } from '../../../../src/lib/connector/oauth/rate-limiter.ts';
import type { ConnectorEndpoints } from '../../../../src/lib/connector/ports.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'connector-oauth-'));
  directories.push(directory);
  const store = new FileConnectorStore(directory);
  const clock = { now: () => Date.now() };
  const endpoints: ConnectorEndpoints = {
    issuer: 'https://connector.example',
    resource: 'https://connector.example/mcp',
    resourceMetadataUrl: 'https://connector.example/.well-known/oauth-protected-resource/mcp',
    appOrigin: 'https://app.example',
    daemonId: 'daemon-integration',
  };
  const authority = new ConnectorAuthority({
    clock,
    crypto: webCryptoConnector,
    store,
    endpoints,
    audit: { record: async () => {} },
    allowedRedirectUris: [],
    memory: new ConnectorMemory(),
    limiter: new ConnectorRateLimiter(clock),
  });
  const http = new ConnectorOAuthHttp(authority, endpoints);
  const call = async (method: string, path: string, body?: Record<string, string> | object) => {
    const url = new URL(path, endpoints.issuer);
    const register = path === '/oauth/register';
    const text =
      body === undefined
        ? ''
        : register
          ? JSON.stringify(body)
          : new URLSearchParams(body as Record<string, string>).toString();
    const request: ApiRequest = {
      method,
      path: url.pathname,
      query: new Map([...new Set(url.searchParams.keys())].map(key => [key, url.searchParams.getAll(key)])),
      headers: new Map([['content-type', register ? 'application/json' : 'application/x-www-form-urlencoded']]),
      loopback: true,
      text: async limit => {
        expect(limit).toBe(8192);
        return text;
      },
    };
    const response = await http.handle(request);
    if (!response) throw new Error('Unclaimed request');
    return response;
  };
  return { directory, store, authority, http, call };
}

describe('connector OAuth with real crypto and atomic files', () => {
  test('register → authorize → app approval → code → token → verify → refresh → revoke', async () => {
    const f = await setup();
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const registered = await f.call('POST', '/oauth/register', {
      client_name: 'Integration client',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(registered.status).toBe(201);
    const client = JSON.parse(registered.body);
    const verifier = base64url(webCryptoConnector.randomBytes(32));
    const challenge = base64url(await webCryptoConnector.sha256(verifier));
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'HTTPS://CONNECTOR.EXAMPLE:443/mcp/',
      state: 'round trip',
    });
    const authorized = await f.call('GET', `/oauth/authorize?${query}`);
    expect(authorized.status).toBe(302);
    const waitingUrl = authorized.headers.get('location') ?? '';
    const waiting = await f.call('GET', waitingUrl);
    expect(waiting.status).toBe(200);
    expect(waiting.body).toContain('Integration client');
    const pending = (await f.authority.pending())[0];
    expect(waiting.body).toContain(pending?.matchCode ?? 'missing');
    expect((await f.authority.approve(pending?.id ?? '', 'admin-cli')).ok).toBe(true);
    const approved = await f.call('GET', waitingUrl);
    expect(approved.status).toBe(302);
    const callback = new URL(approved.headers.get('location') ?? '');
    expect(callback.searchParams.get('state')).toBe('round trip');
    expect(callback.searchParams.get('iss')).toBe('https://connector.example');
    const code = callback.searchParams.get('code') ?? '';
    const exchanged = await f.call('POST', '/oauth/token', {
      client_id: client.client_id,
      client_secret: client.client_secret,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource: 'https://connector.example/mcp',
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toBe('no-store');
    const tokens = JSON.parse(exchanged.body);
    expect(await f.authority.verify(tokens.access_token)).toMatchObject({
      clientName: 'Integration client',
      scopes: ['fleet:read', 'fleet:write'],
    });
    const rotated = await f.call('POST', '/oauth/token', {
      client_id: client.client_id,
      client_secret: client.client_secret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    });
    expect(rotated.status).toBe(200);
    const next = JSON.parse(rotated.body);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(await f.authority.verify(next.access_token)).toBeDefined();
    const revoked = await f.call('POST', '/oauth/revoke', {
      client_id: client.client_id,
      client_secret: client.client_secret,
      token: next.refresh_token,
    });
    expect(revoked.status).toBe(200);
    expect(await f.authority.verify(next.access_token)).toBeUndefined();
    expect(await f.authority.verify(tokens.access_token)).toBeUndefined();
    const file = join(f.directory, 'connector', 'connector.json');
    const serialized = await readFile(file, 'utf8');
    for (const value of [
      tokens.access_token,
      tokens.refresh_token,
      next.access_token,
      next.refresh_token,
      client.client_secret,
      code,
      new URL(waitingUrl).searchParams.get('h'),
    ])
      expect(serialized).not.toContain(value);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.directory, 'connector'))).mode & 0o777).toBe(0o700);
  });

  test('damaged JSON and foreign shapes close every store operation without resetting the file', async () => {
    const f = await setup();
    await f.store.save({ version: 1, clients: [], grants: [] });
    const file = join(f.directory, 'connector', 'connector.json');
    for (const damaged of [
      '{',
      '{"version":1,"clients":[],"grants":[{}]}',
      '{"version":999,"clients":[],"grants":[]}',
    ]) {
      await writeFile(file, damaged);
      await expect(f.store.load()).rejects.toBeInstanceOf(ConnectorStoreError);
      const response = await f.call('POST', '/oauth/register', {
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      });
      expect(response.status).toBe(503);
      expect(await readFile(file, 'utf8')).toBe(damaged);
    }
  });

  test('serialized writes always leave a complete validated document', async () => {
    const f = await setup();
    await Promise.all(Array.from({ length: 20 }, () => f.store.save({ version: 1, clients: [], grants: [] })));
    expect(await f.store.load()).toEqual({ version: 1, clients: [], grants: [] });
  });
});
