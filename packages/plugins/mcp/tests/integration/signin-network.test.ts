import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { SealedDocumentDef, SealedDocumentHandle, SealedDocumentsApi } from '@ferretry/core-vault/contract';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { StatePort } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import mcp from '../../daemon/index.ts';
import { MAX_PENDING_FLOWS, MCP_OAUTH_FLOW_TTL_MS } from '../../daemon/lib/oauth/service.ts';
import manifest from '../../manifest.ts';
import { PWA_REDIRECT } from '../unit/oauth/support.ts';

/**
 * The MCP sign-in network, through the kernel test host: every request goes through the plugin's declared `network`
 * (the `mcp-sign-in` resolver), so a host the resolver does not answer never reaches `options.fetch`. No real network.
 */
const MCP = 'https://mcp.example.test';
const AUTH = 'https://auth.example.test';
const TOKEN = 'https://token.example.test';
const OTHER = 'https://mcp2.example.test';
const META = 'https://meta.example.test';

const ACCESS = 'access-secret-7f3a9c';
const REFRESH = 'refresh-secret-51be02';
const CODE = 'code-secret-c0ffee';
const SECRETS = [ACCESS, REFRESH, CODE];

const as = (...capabilities: string[]) => ({ kind: 'device', holder: 'dev_a', capabilities }) as const;
const CONFIGURE = as('fleet.configure');
const USE = as('fleet.use');

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Scenario {
  /** The `resource_metadata` address the server's 401 challenge names (default: its own). */
  readonly resourceMetadata?: string;
  /** The authorization server its protected-resource metadata names (default: a second public host). */
  readonly issuer?: string;
  /** The token endpoint the authorization server names (default: a third public host). */
  readonly tokenEndpoint?: string;
}

/** A fake MCP server, authorization server and token host, on three public names. Records what it was asked. */
function network(scenario: Scenario = {}) {
  const seen: string[] = [];
  const revoked: string[] = [];
  /** What a scenario flips while it runs: the authorization server's metadata answers 500, registration answers 500. */
  const broken = { authMetadata: false, registration: false };
  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    seen.push(`${method} ${url.href}`);
    const at = `${method} ${url.origin}${url.pathname}`;
    if (at === `GET ${META}/prm`) return json(200, { resource: `${MCP}/mcp`, authorization_servers: [AUTH] });
    if (broken.authMetadata && at === `GET ${AUTH}/.well-known/oauth-authorization-server`)
      return new Response('broken', { status: 500 });
    if (broken.registration && at === `POST ${AUTH}/register`) return new Response('broken', { status: 500 });
    if (at === `POST ${MCP}/mcp`)
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${scenario.resourceMetadata ?? `${MCP}/.well-known/oauth-protected-resource/mcp`}"`,
        },
      });
    if (at === `POST ${OTHER}/mcp`)
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${TOKEN}/prm"` },
      });
    if (at === `GET ${MCP}/.well-known/oauth-protected-resource/mcp`)
      return json(200, { resource: `${MCP}/mcp`, authorization_servers: [scenario.issuer ?? AUTH] });
    if (at === `GET ${AUTH}/.well-known/oauth-authorization-server`)
      return json(200, {
        issuer: AUTH,
        authorization_endpoint: `${AUTH}/authorize`,
        token_endpoint: scenario.tokenEndpoint ?? `${TOKEN}/token`,
        registration_endpoint: `${AUTH}/register`,
        revocation_endpoint: `${TOKEN}/revoke`,
        code_challenge_methods_supported: ['S256'],
      });
    if (at === `POST ${AUTH}/register`) return json(201, { client_id: 'client-1' });
    if (at === `POST ${TOKEN}/token`)
      return json(200, { access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 3600 });
    if (at === `POST ${TOKEN}/revoke`) {
      revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  const hosts = (): readonly string[] => [
    ...new Set(seen.map(line => new URL(line.slice(line.indexOf(' ') + 1)).host)),
  ];
  return { handle, seen, revoked, hosts, broken };
}

/**
 * Sealed documents in memory keyed by the document's path ALONE, not by the state port object, so a restarted host
 * (a new state port) still opens the same document. The refresh token a sign-in sealed survives the restart.
 */
class PersistentSealedDocuments implements SealedDocumentsApi {
  readonly #documents = new Map<string, Map<string, string>>();

  open(_own: StatePort, document: SealedDocumentDef): SealedDocumentHandle {
    const entries = (): Map<string, string> => {
      let held = this.#documents.get(document.state.path);
      if (held === undefined) {
        held = new Map();
        this.#documents.set(document.state.path, held);
      }
      return held;
    };
    return {
      names: async () => [...entries().keys()],
      put: async (name, value) => {
        entries().set(name, typeof value === 'string' ? value : new TextDecoder().decode(value));
      },
      get: async name => entries().get(name),
      getBytes: async name => {
        const held = entries().get(name);
        return held === undefined ? undefined : new TextEncoder().encode(held);
      },
      delete: async name => entries().delete(name),
    };
  }
}

async function host(
  fake: { readonly handle: (url: URL, init?: RequestInit) => Promise<Response> },
  options: { readonly config?: Record<string, { url: string; auth: 'oauth' }> } = {},
) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  return await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault: new FakeVault(), sealed: new PersistentSealedDocuments() },
    config: {
      mcp: options.config ?? {
        linear: { url: `${MCP}/mcp`, auth: 'oauth' },
        probe: { url: `${OTHER}/mcp`, auth: 'oauth' },
      },
    },
    fetch: fake.handle,
  });
}

const manyConfig = (count: number): Record<string, { url: string; auth: 'oauth' }> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `s${String(index)}`,
      { url: `https://mcp${String(index)}.example.test/mcp`, auth: 'oauth' as const },
    ]),
  );

/**
 * `count` servers, each on its own hosts (`mcpN`, `authN`, `tokN`), so one flow's hosts are never another's. Records
 * the token requests it answered.
 */
function manyNetwork() {
  const tokens: string[] = [];
  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const match = /^(mcp|auth|tok)(\d+)\.example\.test$/u.exec(url.hostname);
    if (match === null) return new Response('not found', { status: 404 });
    const [, kind, n] = match as unknown as [string, string, string];
    const mcpHost = `https://mcp${n}.example.test`;
    const authHost = `https://auth${n}.example.test`;
    const tokHost = `https://tok${n}.example.test`;
    const at = `${method} ${url.pathname}`;
    if (kind === 'mcp' && at === 'POST /mcp')
      return new Response(null, {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${mcpHost}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    if (kind === 'mcp' && at === 'GET /.well-known/oauth-protected-resource/mcp')
      return json(200, { resource: `${mcpHost}/mcp`, authorization_servers: [authHost] });
    if (kind === 'auth' && at === 'GET /.well-known/oauth-authorization-server')
      return json(200, {
        issuer: authHost,
        authorization_endpoint: `${authHost}/authorize`,
        token_endpoint: `${tokHost}/token`,
        registration_endpoint: `${authHost}/register`,
        code_challenge_methods_supported: ['S256'],
      });
    if (kind === 'auth' && at === 'POST /register') return json(201, { client_id: `client-${n}` });
    if (kind === 'tok' && at === 'POST /token') {
      tokens.push(n);
      return json(200, { access_token: ACCESS, refresh_token: REFRESH, token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response('not found', { status: 404 });
  };
  return { handle, tokens };
}

type Host = Awaited<ReturnType<typeof host>>;

interface Flow {
  readonly flowId: string;
  readonly authorizeUrl: string;
  readonly redirectUri: string;
}

const start = async (h: Host, component = 'linear') =>
  await h.request('POST', `/v1/mcp/auth/${component}`, { body: { redirectUri: PWA_REDIRECT }, as: CONFIGURE });

const callbackFor = (flow: Flow): string =>
  `${flow.redirectUri}?code=${CODE}&state=${new URL(flow.authorizeUrl).searchParams.get('state') as string}`;

/** Every response of this suite is uncacheable and carries no token, code or verifier. */
const clean = (response: { readonly headers: ReadonlyMap<string, string>; readonly body: string }): void => {
  expect(response.headers.get('cache-control')).toBe('no-store');
  for (const secret of SECRETS) expect(response.body).not.toContain(secret);
  expect(response.body).not.toContain('code_verifier');
};

describe('the MCP sign-in network', () => {
  test('the manifest declares the sign-in reach as a resolver, not a host list', () => {
    expect(manifest.permissions?.network).toEqual([{ resolver: 'mcp-sign-in' }]);
  });

  test('R-0291 starting a sign-in reaches only the server and the hosts its metadata named, and answers the flow', async () => {
    const fake = network();
    const h = await host(fake);
    const response = await start(h);
    expect(response.status).toBe(200);
    clean(response);
    const flow = response.json<Flow & { component: string; issuer: string; mode: string }>();
    expect(flow).toMatchObject({ component: 'linear', issuer: 'auth.example.test', mode: 'pwa' });
    expect(flow.authorizeUrl.startsWith(`${AUTH}/authorize?`)).toBe(true);
    // The server (configured), its authorization server (named by its metadata), and nothing else; no token host yet.
    expect(fake.hosts()).toEqual(['mcp.example.test', 'auth.example.test']);
  });

  test('R-0292 finishing a sign-in redeems the code at the token host the metadata named, and no token is answered', async () => {
    const fake = network();
    const h = await host(fake);
    const flow = (await start(h)).json<Flow>();
    const done = await h.request('POST', `/v1/mcp/auth/flows/${flow.flowId}`, {
      body: { callback: callbackFor(flow) },
      as: CONFIGURE,
    });
    expect(done.status).toBe(200);
    clean(done);
    expect(done.json()).toMatchObject({
      component: 'linear',
      connection: { component: 'linear', state: 'signed-in', issuer: 'auth.example.test', renewable: true },
    });
    expect(fake.seen).toContain(`POST ${TOKEN}/token`);
    // A flow that is gone cannot be finished twice.
    const again = await h.request('POST', `/v1/mcp/auth/flows/${flow.flowId}`, {
      body: { callback: callbackFor(flow) },
      as: CONFIGURE,
    });
    expect(again.status).toBe(404);
    expect(again.json()).toMatchObject({ code: 'mcp_auth_unknown_flow' });
    clean(again);
  });

  test('R-0087 the sign-in list says that a server is signed in and until when, with no token in the body', async () => {
    const fake = network();
    const h = await host(fake);
    const flow = (await start(h)).json<Flow>();
    await h.request('POST', `/v1/mcp/auth/flows/${flow.flowId}`, {
      body: { callback: callbackFor(flow) },
      as: CONFIGURE,
    });
    const listed = await h.request('GET', '/v1/mcp/auth', { as: USE });
    expect(listed.status).toBe(200);
    clean(listed);
    const connections = listed.json<{ connections: { component: string; state: string; issuer?: string }[] }>();
    expect(connections.connections.map(entry => [entry.component, entry.state, entry.issuer])).toEqual([
      ['linear', 'signed-in', 'auth.example.test'],
      ['probe', 'needs-sign-in', undefined],
    ]);
  });

  test('R-0018 signing out revokes at the recorded revocation host after the flow ended, and answers no token', async () => {
    const fake = network();
    const h = await host(fake);
    const flow = (await start(h)).json<Flow>();
    await h.request('POST', `/v1/mcp/auth/flows/${flow.flowId}`, {
      body: { callback: callbackFor(flow) },
      as: CONFIGURE,
    });
    const out = await h.request('DELETE', '/v1/mcp/auth/linear', { as: CONFIGURE });
    expect(out.status).toBe(200);
    clean(out);
    expect(out.json()).toEqual({ component: 'linear', removed: true, revoked: true });
    // The refresh token went to the host the metadata named, which the record (not the ended flow) kept reachable.
    expect(fake.revoked).toEqual([REFRESH]);
    const after = await h.request('GET', '/v1/mcp/auth', { as: USE });
    expect(after.status).toBe(200);
    clean(after);
    expect(after.json<{ connections: { component: string; state: string }[] }>().connections[0]).toMatchObject({
      component: 'linear',
      state: 'needs-sign-in',
    });
  });

  test('R-0019 cancelling a sign-in answers cancelled and releases its hosts, and a cancelled or expired flow finishes nothing', async () => {
    const fake = network();
    const h = await host(fake);
    const tokenRequests = (): number => fake.seen.filter(line => line === `POST ${TOKEN}/token`).length;
    const flow = (await start(h)).json<Flow>();
    const cancelled = await h.request('DELETE', `/v1/mcp/auth/flows/${flow.flowId}`, { as: CONFIGURE });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json()).toEqual({ flowId: flow.flowId, cancelled: true });
    clean(cancelled);
    const finished = await h.request('POST', `/v1/mcp/auth/flows/${flow.flowId}`, {
      body: { callback: callbackFor(flow) },
      as: CONFIGURE,
    });
    expect(finished.status).toBe(404);
    expect(finished.json()).toMatchObject({ code: 'mcp_auth_unknown_flow' });
    clean(finished);

    // And an unfinished flow lets go of them at its time to live.
    const second = (await start(h)).json<Flow>();
    await h.clock.advance(MCP_OAUTH_FLOW_TTL_MS + 1);
    const late = await h.request('POST', `/v1/mcp/auth/flows/${second.flowId}`, {
      body: { callback: callbackFor(second) },
      as: CONFIGURE,
    });
    expect(late.status).toBe(404);
    expect(late.json()).toMatchObject({ code: 'mcp_auth_unknown_flow' });
    clean(late);
    expect(tokenRequests()).toBe(0);
    // Cancelling a flow that is gone says so.
    const gone = await h.request('DELETE', `/v1/mcp/auth/flows/${flow.flowId}`, { as: CONFIGURE });
    expect(gone.json()).toEqual({ flowId: flow.flowId, cancelled: false });
    clean(gone);
  });

  test('R-0019 a cancelled flow releases its hosts, so cancelled starts never crowd out a pending flow’s', async () => {
    // One pending flow, then more cancelled starts than the reach holds. A cancel that kept its hosts would fill the
    // reach and push the pending flow's hosts out, and finishing it would fail at the token host.
    const count = 2 * MAX_PENDING_FLOWS + 1;
    const fake = manyNetwork();
    const h = await host(fake, { config: manyConfig(count) });
    const pending = (await start(h, 's0')).json<Flow>();
    for (let index = 1; index < count; index += 1) {
      const flow = (await start(h, `s${String(index)}`)).json<Flow>();
      const cancelled = await h.request('DELETE', `/v1/mcp/auth/flows/${flow.flowId}`, { as: CONFIGURE });
      expect(cancelled.json()).toEqual({ flowId: flow.flowId, cancelled: true });
    }
    const done = await h.request('POST', `/v1/mcp/auth/flows/${pending.flowId}`, {
      body: { callback: callbackFor(pending) },
      as: CONFIGURE,
    });
    expect(done.status).toBe(200);
    clean(done);
    expect(fake.tokens).toEqual(['0']);
  });

  test('R-0292 restarting one of the 16 pending sign-ins leaves the oldest flow able to finish', async () => {
    const fake = manyNetwork();
    const h = await host(fake, { config: manyConfig(MAX_PENDING_FLOWS) });
    const flows: Flow[] = [];
    for (let index = 0; index < MAX_PENDING_FLOWS; index += 1)
      flows.push((await start(h, `s${String(index)}`)).json<Flow>());
    // Restart the sixth server's sign-in: it takes a new flow and ends its old one.
    const restarted = await start(h, 's5');
    expect(restarted.status).toBe(200);
    clean(restarted);
    const oldest = flows[0] as Flow;
    const done = await h.request('POST', `/v1/mcp/auth/flows/${oldest.flowId}`, {
      body: { callback: callbackFor(oldest) },
      as: CONFIGURE,
    });
    expect(done.status).toBe(200);
    clean(done);
    expect(fake.tokens).toEqual(['0']);
  });

  test('R-0291 a loopback address a challenge names for its metadata is never fetched, and the server’s own is used', async () => {
    const fake = network({ resourceMetadata: 'https://127.0.0.1/prm' });
    const h = await host(fake);
    const response = await start(h);
    expect(response.status).toBe(200);
    clean(response);
    expect(fake.hosts()).not.toContain('127.0.0.1');
  });

  test('R-0291 a trailing dot does not turn a loopback name into a public one', async () => {
    // (`127.0.0.1.` is no case: the URL parser already turns it into `127.0.0.1`. Names it keeps are the ones below.)
    for (const named of ['https://localhost./prm', 'https://LOCALHOST./prm', 'https://app.localhost./prm']) {
      const fake = network({ resourceMetadata: named });
      const h = await host(fake);
      const response = await start(h);
      expect(response.status).toBe(200);
      clean(response);
      expect(fake.hosts().filter(name => name.includes('localhost'))).toEqual([]);
    }
  });

  test('R-0291 a challenge that names its resource metadata on another public host is followed, as it was', async () => {
    const fake = network({ resourceMetadata: `${META}/prm` });
    const h = await host(fake);
    const response = await start(h);
    expect(response.status).toBe(200);
    clean(response);
    expect(fake.hosts()).toEqual(['mcp.example.test', 'meta.example.test', 'auth.example.test']);
  });

  test('R-0292 a second start inside the first’s life gets its own expiry, and finishes after the first would have ended', async () => {
    const fake = network();
    const h = await host(fake);
    await start(h);
    await h.clock.advance(MCP_OAUTH_FLOW_TTL_MS - 60_000);
    const second = (await start(h)).json<Flow>();
    await h.clock.advance(120_000);
    const done = await h.request('POST', `/v1/mcp/auth/flows/${second.flowId}`, {
      body: { callback: callbackFor(second) },
      as: CONFIGURE,
    });
    expect(done.status).toBe(200);
    clean(done);
    expect(fake.seen).toContain(`POST ${TOKEN}/token`);
  });

  test('R-0292 a retry that fails does not take the hosts a pending flow still needs', async () => {
    const fake = network();
    const h = await host(fake);
    const first = (await start(h)).json<Flow>();
    fake.broken.authMetadata = true;
    const retry = await start(h);
    expect(retry.status).toBe(409);
    expect(retry.json()).toMatchObject({ code: 'mcp_auth_discovery' });
    clean(retry);
    fake.broken.authMetadata = false;
    const done = await h.request('POST', `/v1/mcp/auth/flows/${first.flowId}`, {
      body: { callback: callbackFor(first) },
      as: CONFIGURE,
    });
    expect(done.status).toBe(200);
    clean(done);
  });

  test('R-0291 a start that fails after discovery answers its refusal, and the next start is clean (release: service unit test)', async () => {
    const fake = network();
    const h = await host(fake);
    fake.broken.registration = true;
    const failed = await start(h);
    expect(failed.status).toBe(409);
    expect(failed.json()).toMatchObject({ code: 'mcp_auth_registration' });
    clean(failed);
    fake.broken.registration = false;
    const ok = (await start(h)).json<Flow>();
    expect(ok.flowId.length).toBeGreaterThan(0);
  });

  test('R-0018 a restart with oauth.json on file lists the sign-in and signs it out, with no flow and no token in a body', async () => {
    const fake = network();
    const h = await host(fake);
    const flow = (await start(h)).json<Flow>();
    await h.request('POST', `/v1/mcp/auth/flows/${flow.flowId}`, {
      body: { callback: callbackFor(flow) },
      as: CONFIGURE,
    });
    // A new daemon: no flow, no discovered host, only oauth.json on file (and the sealed refresh token, which the
    // test-local store keeps by document path across the restart).
    const again = await h.restart();
    const listed = await again.request('GET', '/v1/mcp/auth', { as: USE });
    expect(listed.status).toBe(200);
    clean(listed);
    expect(listed.json<{ connections: { component: string; state: string }[] }>().connections[0]).toMatchObject({
      component: 'linear',
      state: 'signed-in',
    });
    const out = await again.request('DELETE', '/v1/mcp/auth/linear', { as: CONFIGURE });
    expect(out.status).toBe(200);
    clean(out);
    expect(out.json()).toEqual({ component: 'linear', removed: true, revoked: true });
    // The revocation went to the host the record kept, after the restart.
    expect(fake.revoked).toEqual([REFRESH]);
  });

  test('R-0291 a public server that names a loopback authorization server is refused before anything is sent there', async () => {
    const fake = network({ issuer: 'https://127.0.0.1:8443' });
    const h = await host(fake);
    const response = await start(h);
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'mcp_auth_discovery' });
    clean(response);
    expect(fake.hosts()).toEqual(['mcp.example.test']);
  });

  test('R-0291 a public authorization server that names a private token endpoint is refused and nothing is sent there', async () => {
    const fake = network({ tokenEndpoint: 'https://10.0.0.5/token' });
    const h = await host(fake);
    const response = await start(h);
    expect(response.status).toBe(409);
    expect(response.json()).toMatchObject({ code: 'mcp_auth_discovery' });
    clean(response);
    expect(fake.hosts()).toEqual(['mcp.example.test', 'auth.example.test']);
  });
});
