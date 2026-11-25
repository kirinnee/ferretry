/**
 * The connector over the built-in tunnel, end to end on loopback: the REAL connector module (authority, OAuth server,
 * `/mcp`, file store), the REAL tunnel listener surface on a real Bun listener, and the official MCP SDK client signing
 * in and calling a tool through it — exactly the path Claude takes through `https://<id>.ferretry.stream`, minus
 * Cloudflare. docs/mcp-connector.md "Over the built-in tunnel".
 */

import { afterEach, describe, it } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DAEMON_CAPABILITIES, type CapabilityGrants } from '@ferretry/protocol';
import { TUNNEL_CONNECTOR_PATH_PATTERN } from '@ferretry/relay';
import should from 'should';
import { connectorModule, type ConnectorModule } from '../../../bin/modules/connector.ts';
import { BunApiServer } from '../../../src/adapters/api/bun-api-server.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../src/lib/api/capability.ts';
import type { ApiRequest, ApiResponse } from '../../../src/lib/api/http.ts';
import type { SocketRoute } from '../../../src/lib/api/socket.ts';
import { CLAUDE_REDIRECT_URI } from '../../../src/lib/connector/config.ts';
import type { TextRedactor } from '../../../src/lib/secrets/redaction.ts';
import { tunnelListenerSurface, tunnelPeer } from '../../../src/lib/tunnel/listener.ts';
import type { ApiBindOptions, ApiServerPort, ApiSurface } from '../../../src/lib/api/server.ts';
import { request } from '../../unit/api/support.ts';
import { CREDENTIALS } from '../../unit/runtime/mounts/support.ts';
import { ok, sessionView } from '../../support/connector/mcp-fixtures.ts';

const ALL_GRANTS: CapabilityGrants = Object.fromEntries(
  DAEMON_CAPABILITIES.map(capability => [capability, { use: true, configure: true }]),
) as CapabilityGrants;

const IDENTITY_REDACTOR: TextRedactor = {
  redact: async text => text,
  redactData: async value => value,
  batch: async work => work({ text: text => text, data: value => value, cover: () => [] }),
};

/** The daemon's release list, as a test sees it: what registers is released after the case. */
const lifecycle = () => ({
  onRelease: (_label: string, release: () => void | Promise<void>) => void cleanups.push(async () => await release()),
  releasing: () => false,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SESSION_PATH = '/v1/rendezvous/fy_daemon_x/client';
const sessionRoute: SocketRoute = {
  method: 'GET',
  path: '/v1/rendezvous/:daemonId/client',
  minimum: 'none',
  caller: 'any',
  accept: async () => async () => ({
    open: async () => undefined,
    fromClient: () => undefined,
    close: () => undefined,
  }),
};

/** A listener port that records what it was asked to bind instead of binding it: no port is ever guessed. */
function recordingApi() {
  const bound: { surface: ApiSurface; options: ApiBindOptions }[] = [];
  const api: ApiServerPort = {
    listen: async (surface, options) => {
      bound.push({ surface, options });
      return {
        url: `http://127.0.0.1:${options.port}`,
        port: options.port,
        closeSockets: () => undefined,
        stop: async () => undefined,
      };
    },
  };
  return { api, bound };
}

async function rig(
  block: unknown,
  moduleApi?: ApiServerPort,
  options: { readBlock?: () => unknown; writeEnabled?: (enabled: boolean) => Promise<void>; listen?: boolean } = {},
) {
  const state = await mkdtemp(join(tmpdir(), 'fy-connector-tunnel-'));
  cleanups.push(async () => await rm(state, { recursive: true, force: true }));
  const written: boolean[] = [];
  const calls: string[] = [];
  let tunnelOrigin: string | undefined;
  const built = connectorModule.build(
    {
      block,
      stateDirectory: state,
      daemonId: () => 'fy_daemon_x',
      appOrigin: 'https://app.example',
      clock: { now: () => Date.now() },
      audit: { record: async () => undefined },
      daemonGrants: () => ALL_GRANTS,
      redactor: IDENTITY_REDACTOR,
      tunnelOrigin: () => tunnelOrigin,
      readBlock: async () => (options.readBlock === undefined ? block : options.readBlock()),
      writeEnabled: async enabled => {
        await options.writeEnabled?.(enabled);
        written.push(enabled);
      },
    },
    undefined,
    lifecycle(),
  );
  const module: ConnectorModule = built.provides;
  const api = new BunApiServer();
  if (options.listen !== false)
    await module.listen({
      api: moduleApi ?? api,
      dispatch: async (request: ApiRequest): Promise<ApiResponse> => {
        calls.push(`${request.method} ${request.path}`);
        return request.path === '/v1/sessions'
          ? {
              ...ok([
                sessionView({
                  id: 'mwuanehg-4531fa9e',
                  callsign: 'lizzette',
                  task: 'Build the tunnel',
                  turnState: 'working',
                }),
              ]),
              headers: new Map(),
            }
          : { status: 404, headers: new Map(), body: '{}' };
      },
      adminToken: () => CREDENTIALS.admin,
      remotePeer: tunnelPeer,
    });
  const listener = await api.listen(
    tunnelListenerSurface({
      route: sessionRoute,
      credentials: CREDENTIALS,
      guard: NO_GOVERNED_ROUTES_GUARD,
      corsOrigins: [],
      connector: () => module.tunnelHandlers(),
    }),
    { host: '127.0.0.1', port: 0, directLoopbackIsPrivileged: false, remotePeer: tunnelPeer },
  );
  cleanups.push(async () => {
    listener.closeSockets();
    await listener.stop();
  });
  const origin = `http://127.0.0.1:${listener.port}`;
  return {
    module,
    origin,
    written,
    calls,
    setTunnel: (value: 'up' | 'down' | string) => {
      tunnelOrigin = value === 'up' ? origin : value === 'down' ? undefined : value;
    },
  };
}

const status = async (url: string, init?: RequestInit) => (await fetch(url, { redirect: 'manual', ...init })).status;

/** Signs in as Claude would: DCR, authorize, owner approval, code exchange. Returns the access token. */
async function signIn(origin: string, module: ConnectorModule): Promise<string> {
  const registered = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT_URI] }),
  });
  should(registered.status).equal(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await fetch(
    `${origin}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${origin}/mcp`,
      state: 's',
    })}`,
    { redirect: 'manual' },
  );
  should(authorize.status).equal(302);
  const waiting = new URL(authorize.headers.get('location') ?? '', origin).toString();
  const pending = (await module.subsystem.acts.pending())[0];
  should((await module.subsystem.acts.approve(pending?.id ?? '', 'admin-cli')).ok).be.true();
  const approved = await fetch(waiting, { redirect: 'manual' });
  should(approved.status).equal(302);
  const code = new URL(approved.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const token = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  should(token.status).equal(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

describe('the connector over the built-in tunnel', () => {
  it('should serve nothing of the connector while it is off, then sign Claude in and answer list_ferrets once switched on and the tunnel has a hostname', async () => {
    // Arrange
    const r = await rig({});
    r.setTunnel('up');
    const paths = ['/mcp', '/oauth/register', '/.well-known/oauth-authorization-server'];

    // Assert — off by default: the same 404 as any other path.
    for (const path of paths) should(await status(`${r.origin}${path}`, { method: 'POST', body: '{}' })).equal(404);
    should(await r.module.subsystem.availability()).deepEqual({
      enabled: false,
      switchedOn: false,
      disabledReason: 'The connector is off. Switch it on in the app (Settings › Claude connector).',
    });

    // Act — switch it on, as the app's PUT would.
    should(await r.module.subsystem.change(true)).deepEqual({ ok: true });

    // Assert — written first, served on the tunnel's issuer.
    should(r.written).deepEqual([true]);
    should(await r.module.subsystem.availability()).deepEqual({
      enabled: true,
      publicUrl: r.origin,
      mcpUrl: `${r.origin}/mcp`,
      source: 'tunnel',
    });
    const metadata = (await (await fetch(`${r.origin}/.well-known/oauth-authorization-server`)).json()) as {
      issuer: string;
    };
    should(metadata.issuer).equal(r.origin);

    // Act — the official MCP SDK client, with a real OAuth sign-in, through the tunnel listener.
    const accessToken = await signIn(r.origin, r.module);
    const client = new Client({ name: 'integration', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${r.origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
    cleanups.push(async () => await client.close());
    const called = await client.callTool({ name: 'list_ferrets', arguments: {} });

    // Assert
    const text = (called.content as { type: string; text: string }[]).map(part => part.text).join('\n');
    should(called.isError).not.be.true();
    should(text).containEql('Lizzette');
    should(r.calls).containEql('GET /v1/sessions');
  });

  it('should expose nothing else on the tunnel listener, and leave the session route as it was', async () => {
    // Arrange
    const r = await rig({ enabled: true });
    r.setTunnel('up');
    const token = await signIn(r.origin, r.module);
    const bearer = { authorization: `Bearer ${token}` };

    // Act / Assert — every route the daemon owns, and the owner's connector routes, are the same 404 — with the
    // admin token, a connector token or nothing.
    for (const path of ['/v1/connector', '/v1/sessions', '/v1/tunnel', '/v1/health', '/', '/mcp/', '/oauth/other'])
      for (const headers of [{}, bearer, { authorization: `Bearer ${CREDENTIALS.admin}` }])
        should(await status(`${r.origin}${path}`, { headers })).equal(404);
    // The session path without an upgrade is still the same 404 (it is a socket route, claimed only for GET upgrades).
    should(await status(`${r.origin}${SESSION_PATH}`)).equal(404);
    should(await status(`${r.origin}${SESSION_PATH}`, { method: 'POST', body: '{}' })).equal(404);
    // /mcp itself refuses a stranger and a GET, as on the connector listener.
    should(await status(`${r.origin}/mcp`, { method: 'POST', body: '{}' })).equal(401);
    should(await status(`${r.origin}/mcp`, { headers: bearer })).equal(405);
  });

  it('should answer 404 again the moment it is switched off, and 404 while the tunnel has no hostname', async () => {
    // Arrange
    const r = await rig({ enabled: true });
    r.setTunnel('down');

    // Assert — on, but no address yet: nothing is served, and the sentence says what to do.
    should(await status(`${r.origin}/.well-known/oauth-authorization-server`)).equal(404);
    const waiting = await r.module.subsystem.availability();
    should(waiting.enabled).be.false();
    should(waiting.enabled === false && waiting.switchedOn).be.true();
    should(waiting.enabled === false && waiting.disabledReason).match(/Settings › Connection/u);

    // Act
    r.setTunnel('up');
    should(await status(`${r.origin}/.well-known/oauth-authorization-server`)).equal(200);
    should(await r.module.subsystem.change(false)).deepEqual({ ok: true });

    // Assert
    should(await status(`${r.origin}/.well-known/oauth-authorization-server`)).equal(404);
    should(r.written).deepEqual([false]);
  });

  it('should stop honouring a token when the tunnel hostname changes: the audience is the address', async () => {
    // Arrange
    const r = await rig({ enabled: true });
    r.setTunnel('up');
    const token = await signIn(r.origin, r.module);
    const mcp = async () =>
      await status(`${r.origin}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    should(await mcp()).equal(200);

    // Act — the hosted service gave this machine another hostname.
    r.setTunnel('https://other-id.ferretry.stream');

    // Assert
    should(await mcp()).equal(401);
  });

  it('should keep an operator’s own publicUrl: its own listener, no tunnel routes, the address never overwritten', async () => {
    // Arrange
    const own = recordingApi();
    const r = await rig({ enabled: true, publicUrl: 'https://ferretry.example.com', port: 7461 }, own.api);
    r.setTunnel('up');

    // Assert
    should(await r.module.subsystem.availability()).deepEqual({
      enabled: true,
      publicUrl: 'https://ferretry.example.com',
      mcpUrl: 'https://ferretry.example.com/mcp',
      source: 'configured',
    });
    should(r.module.tunnelHandlers()).deepEqual([]);
    should(await status(`${r.origin}/.well-known/oauth-authorization-server`)).equal(404);
    should(own.bound.map(entry => [entry.options.host, entry.options.port])).deepEqual([['127.0.0.1', 7461]]);
    const served = await own.bound[0]?.surface.http.dispatch(
      request({ path: '/.well-known/oauth-authorization-server' }),
    );
    should((JSON.parse(served?.body ?? '{}') as { issuer: string }).issuer).equal('https://ferretry.example.com');
  });

  it('should refuse a switch-on that cannot start and write nothing', async () => {
    // Arrange — a damaged connector.json refuses the store load.
    const r = await rig({});
    r.setTunnel('up');
    const damaged = await mkdtemp(join(tmpdir(), 'fy-connector-damaged-'));
    cleanups.push(async () => await rm(damaged, { recursive: true, force: true }));
    const broken = connectorModule.build(
      {
        block: {},
        stateDirectory: damaged,
        daemonId: () => 'fy_daemon_x',
        appOrigin: 'https://app.example',
        clock: { now: () => Date.now() },
        audit: { record: async () => undefined },
        daemonGrants: () => ALL_GRANTS,
        redactor: IDENTITY_REDACTOR,
        tunnelOrigin: () => r.origin,
        readBlock: async () => ({}),
        writeEnabled: async () => void r.written.push(true),
      },
      undefined,
      lifecycle(),
    );
    await Bun.write(join(damaged, 'connector', 'connector.json'), '{not json');
    await broken.provides.listen({
      api: new BunApiServer(),
      dispatch: async () => ({ status: 404, headers: new Map(), body: '' }),
      adminToken: () => CREDENTIALS.admin,
      remotePeer: tunnelPeer,
    });

    // Act
    const result = await broken.provides.subsystem.change(true);

    // Assert
    should(result.ok).be.false();
    should(r.written).deepEqual([]);
    should(await readFile(join(damaged, 'connector', 'connector.json'), 'utf8')).equal('{not json');
    should(broken.provides.tunnelHandlers()).deepEqual([]);
  });

  it('should refuse a switch-on beside settings that changed after boot, and write nothing', async () => {
    // Arrange — booted with no address; the operator has since added one (and then a typo).
    let now: unknown = { publicUrl: 'https://ferretry.example.com' };
    const r = await rig({}, undefined, { readBlock: () => now });
    r.setTunnel('up');

    // Act
    const changed = await r.module.subsystem.change(true);
    now = { enabled: false, port: 'x' };
    const damaged = await r.module.subsystem.change(true);

    // Assert
    should(changed.ok).be.false();
    should(!changed.ok && changed.message).match(/fy daemon restart/u);
    should(damaged.ok).be.false();
    should(r.written).deepEqual([]);
    should(r.module.tunnelHandlers()).deepEqual([]);
  });

  it('should not switch on before the daemon is serving, and say so', async () => {
    // Arrange
    const r = await rig({}, undefined, { listen: false });

    // Act
    const early = await r.module.subsystem.change(true);

    // Assert
    should(early.ok).be.false();
    should(!early.ok && early.message).match(/still starting/u);
    should(r.written).deepEqual([]);
  });

  it('should keep the operator’s own listener a 404 until the switch is committed, and again once it is off', async () => {
    // Arrange
    const own = recordingApi();
    const answers: number[] = [];
    let probe: () => Promise<number> = async () => 0;
    const r = await rig({ publicUrl: 'https://ferretry.example.com', port: 7461 }, own.api, {
      writeEnabled: async () => void answers.push(await probe()),
    });
    probe = async () =>
      (await own.bound[0]?.surface.http.dispatch(request({ path: '/.well-known/oauth-authorization-server' })))
        ?.status ?? 0;

    // Act
    const on = await r.module.subsystem.change(true);
    const during = answers[0];
    const afterOn = await probe();
    const off = await r.module.subsystem.change(false);

    // Assert — bound ahead of the write, but serving only after it.
    should(on.ok && off.ok).be.true();
    should(during).equal(404);
    should(afterOn).equal(200);
    should(own.bound).have.length(1);
  });

  it('should be reachable only on paths the edge forwards: every served path matches the Worker’s ingress pattern', async () => {
    // Arrange
    const r = await rig({ enabled: true });
    r.setTunnel('up');
    const pattern = new RegExp(TUNNEL_CONNECTOR_PATH_PATTERN, 'u');
    const served = [
      '/mcp',
      '/oauth/register',
      '/oauth/authorize',
      '/oauth/authorize/wait',
      '/oauth/token',
      '/oauth/revoke',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-authorization-server',
    ];

    // Assert — each is claimed by a handler (never the listener's 404), and the edge forwards each. The 404s above
    // prove nothing else is claimed.
    for (const path of served) {
      should(pattern.test(path)).be.true();
      const method = ['/oauth/register', '/oauth/token', '/oauth/revoke', '/mcp'].includes(path) ? 'POST' : 'GET';
      should(await status(`${r.origin}${path}`, { method, ...(method === 'POST' ? { body: '{}' } : {}) })).not.equal(
        404,
      );
    }
  });
});
