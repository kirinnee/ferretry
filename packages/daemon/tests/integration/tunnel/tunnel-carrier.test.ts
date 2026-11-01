/**
 * THE TUNNEL CARRIER WITH EVERY PRODUCTION ADAPTER: a real Bun listener, a fake `cloudflared` that is a
 * real executable, and a fake hosted provisioner on loopback that verifies each signature over the host
 * it is actually served on.
 *
 * What this proves at the transport, where it can only be proved: the dedicated listener stamps every
 * arrival remote and keys it by `CF-Connecting-IP`, so a query-string token that the main listener
 * honours from loopback is refused here; nothing but the session upgrade is served on its port; the
 * connector token reaches the child's environment and nowhere else; and the tunnel is published only
 * while the connector is registered.
 */

import { afterEach, describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DaemonIdentity } from '@ferretry/relay';
import { WebCryptoRelayCrypto } from '@ferretry/relay/adapters';
import should from 'should';
import { BunApiServer } from '../../../src/adapters/api/bun-api-server.ts';
import {
  BunConnectorProcesses,
  CloudflaredLocator,
  FileTunnelHolding,
  HostedTunnelProvisioner,
  HostedTunnelService,
} from '../../../src/adapters/tunnel/index.ts';
import type { ApiCredentials } from '../../../src/lib/api/authentication.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../src/lib/api/capability.ts';
import type { ApiRequest } from '../../../src/lib/api/http.ts';
import type { SocketRoute } from '../../../src/lib/api/socket.ts';
import { DaemonTunnelCarrierSchema, IMPLIED_TUNNEL_CARRIER } from '../../../src/lib/runtime/carriers.ts';
import {
  CLOUDFLARED_ARGUMENTS,
  CONNECTOR_INHERITED_VARIABLES,
  connectorBaseEnvironment,
  TunnelCarrier,
  type TunnelCarrierDependencies,
  TunnelCarrierSwitch,
  tunnelListenerSurface,
  tunnelPeer,
} from '../../../src/lib/tunnel/index.ts';
import {
  connectorRecords,
  FakeHostedService,
  fakeCloudflared,
  removeTempDirectories,
  sha256,
  tempDirectory,
  waitFor,
} from './support.ts';

/** The entry an operator writes to turn the tunnel on: no `enabled` key means on. */
const TUNNEL_ON = DaemonTunnelCarrierSchema.parse({ kind: 'tunnel', source: 'discovery' });

const crypto_ = new WebCryptoRelayCrypto();
const CREDENTIALS: ApiCredentials = { admin: 'admin-secret-for-the-test' };
const TOKEN = 'fake-connector-token-INTEGRATION';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await removeTempDirectories();
});

async function newIdentity(): Promise<DaemonIdentity> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return await crypto_.importDaemonIdentity(
    ['-----BEGIN PRIVATE KEY-----', ...(base64.match(/.{1,64}/gu) ?? []), '-----END PRIVATE KEY-----', ''].join('\n'),
  );
}

/** A socket route that records how each arrival was stamped, and holds the socket open. */
function recordingRoute(minimum: SocketRoute['minimum'], arrivals: ApiRequest[]): SocketRoute {
  return {
    method: 'GET',
    path: '/v1/rendezvous/:daemonId/client',
    minimum,
    caller: 'any',
    accept: async ({ request }) => {
      arrivals.push(request);
      return async () => ({ open: async () => undefined, fromClient: () => undefined, close: () => undefined });
    },
  };
}

/** Opens a WebSocket and answers whether the upgrade was accepted, or the status it was refused with. */
async function upgrade(url: string, headers: Record<string, string> = {}): Promise<'open' | number> {
  const response = await fetch(url.replace(/^ws/u, 'http'), {
    headers: {
      ...headers,
      upgrade: 'websocket',
      connection: 'upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'AAAAAAAAAAAAAAAAAAAAAA==',
    },
  });
  return response.status === 101 ? 'open' : response.status;
}

interface Harness {
  readonly service: FakeHostedService;
  readonly published: (string | undefined)[];
  readonly stated: string[];
  readonly steps: string[];
  readonly arrivals: ApiRequest[];
  readonly record: string;
  readonly holdingFile: string;
  readonly identity: DaemonIdentity;
  readonly port: () => number;
  readonly carrier: (overrides?: Partial<TunnelCarrierDependencies>) => TunnelCarrier;
}

async function harness(): Promise<Harness> {
  const service = new FakeHostedService();
  cleanups.push(() => service.stop());
  const fake = await fakeCloudflared();
  const state = await tempDirectory('tunnel-state');
  const identity = await newIdentity();
  const published: (string | undefined)[] = [];
  const stated: string[] = [];
  const steps: string[] = [];
  const arrivals: ApiRequest[] = [];
  let port = 0;
  const holdingFile = join(state, 'tunnel.json');
  const carrier = (overrides: Partial<TunnelCarrierDependencies> = {}) =>
    new TunnelCarrier({
      entry: TUNNEL_ON,
      explicit: true,
      discoveryOrigin: service.origin,
      cloudflared: new CloudflaredLocator({ FY_CLOUDFLARED: fake.path, PATH: '' }),
      service: new HostedTunnelService(service.origin),
      holding: new FileTunnelHolding(holdingFile),
      identity: async () => ({ ok: true, identity }),
      crypto: crypto_,
      provisioner: origin => new HostedTunnelProvisioner(origin),
      openListener: async () => {
        const listener = await new BunApiServer().listen(
          tunnelListenerSurface({
            route: recordingRoute('none', arrivals),
            credentials: CREDENTIALS,
            guard: NO_GOVERNED_ROUTES_GUARD,
            corsOrigins: [],
          }),
          { host: '127.0.0.1', port: 0, directLoopbackIsPrivileged: true, remotePeer: tunnelPeer },
        );
        port = listener.port;
        return {
          port: listener.port,
          close: async () => {
            listener.closeSockets();
            await listener.stop();
          },
        };
      },
      // Exactly what production hands the child: an allowlist — here of an environment that ALSO holds a
      // secret and a stray TUNNEL_ flag, neither of which may reach it.
      processes: new BunConnectorProcesses(
        connectorBaseEnvironment({
          ...process.env,
          FY_SECRET_DATABASE_URL: 'operator-secret',
          TUNNEL_LOGLEVEL: 'debug',
        }),
      ),
      scheduler: {
        after: (milliseconds, action) => {
          const handle = setTimeout(action, milliseconds);
          return { cancel: () => clearTimeout(handle) };
        },
      },
      random: Math.random,
      publish: url => published.push(url),
      notices: {
        step: (what, detail) => steps.push(detail === undefined ? what : `${what}: ${detail}`),
        state: line => stated.push(line),
      },
      ...overrides,
    });
  return {
    service,
    published,
    stated,
    steps,
    arrivals,
    record: fake.record,
    holdingFile,
    identity,
    port: () => port,
    carrier,
  };
}

describe('the hosted tunnel carrier, with every production adapter', () => {
  it('should provision its own listener, run cloudflared with the token in its environment only, and publish once registered', async () => {
    // Arrange
    const world = await harness();
    const subject = world.carrier();
    cleanups.push(() => subject.stop());

    // Act
    subject.start();
    await subject.idle();
    await waitFor(() => world.published.length > 0, 'the tunnel to be published');
    const [record] = await connectorRecords(world.record);
    const holding = await readFile(world.holdingFile, 'utf8');
    await subject.stop();

    // Assert
    should(world.service.verdicts).deepEqual([true]);
    should(world.service.provisions).deepEqual([{ originPort: world.port(), daemonId: world.identity.daemonId }]);
    should(record?.argv).deepEqual([...CLOUDFLARED_ARGUMENTS]);
    should(record?.tokenSha256).equal(sha256(TOKEN));
    // The child inherited the allowlist and the token — no secret, no stray flag. (A runtime may add
    // its own bookkeeping variables to a child it starts; none of them is the daemon's.)
    const allowed = new Set([...CONNECTOR_INHERITED_VARIABLES, 'TUNNEL_TOKEN']);
    should(record?.environment.filter(name => name.startsWith('FY_') || name.startsWith('TUNNEL_'))).deepEqual([
      'TUNNEL_TOKEN',
    ]);
    should(record?.environment.filter(name => !allowed.has(name) && !/^(BUN|_)/u.test(name))).deepEqual([]);
    should(world.published).deepEqual(['https://quiet-otter.tunnels.example', undefined]);
    should(JSON.parse(holding)).deepEqual({
      version: 1,
      origin: world.service.origin,
      tunnelUrl: 'https://quiet-otter.tunnels.example',
    });
    should(holding.includes(TOKEN)).be.false();
    should([...world.steps, ...world.stated].join('\n').includes(TOKEN)).be.false();
    should(world.stated).deepEqual([]);
    // The child went with the carrier.
    should(() => process.kill(record?.pid ?? 0, 0)).throw();
  });

  it('should serve only the session upgrade, and stamp every arrival remote and keyed by CF-Connecting-IP', async () => {
    // Arrange — the listener is bound loopback-only AND told loopback is privileged, the strongest
    // claim a direct bind can make; the tunnel rule must override it.
    const world = await harness();
    const subject = world.carrier();
    cleanups.push(() => subject.stop());
    subject.start();
    await subject.idle();
    const base = `http://127.0.0.1:${String(world.port())}`;
    const session = `ws://127.0.0.1:${String(world.port())}/v1/rendezvous/${world.identity.daemonId}/client`;

    // Act
    const withEdgeAddress = await upgrade(session, { 'cf-connecting-ip': '203.0.113.9' });
    const withoutEdgeAddress = await upgrade(`${session}?token=${CREDENTIALS.admin}`);
    const plainGet = await fetch(`${base}/v1/rendezvous/${world.identity.daemonId}/client`);
    const others = await Promise.all(
      ['/healthz', '/v1/health', '/v1/carriers', `/v1/health?token=${CREDENTIALS.admin}`].map(
        async path =>
          (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${CREDENTIALS.admin}` } })).status,
      ),
    );
    const otherSocket = await upgrade(`ws://127.0.0.1:${String(world.port())}/v1/events`);
    const posted = await fetch(`${base}/v1/rendezvous/${world.identity.daemonId}/client`, { method: 'POST' });
    const preflight = await fetch(`${base}/v1/health`, {
      method: 'OPTIONS',
      headers: { origin: 'https://ferretry.pages.dev', 'access-control-request-method': 'GET' },
    });
    const foreignOrigin = await fetch(`${base}/v1/health`, { headers: { origin: 'https://stranger.example' } });

    // Assert
    should([withEdgeAddress, withoutEdgeAddress]).deepEqual(['open', 'open']);
    should(
      world.arrivals.map(arrival => [arrival.loopback, arrival.privilegedLoopback, arrival.clientAddress]),
    ).deepEqual([
      [false, false, '203.0.113.9'],
      [false, false, 'tunnel'],
    ]);
    should([plainGet.status, ...others, otherSocket, posted.status, preflight.status, foreignOrigin.status]).deepEqual([
      404, 404, 404, 404, 404, 404, 404, 404, 404,
    ]);
    should(preflight.headers.get('access-control-allow-origin')).be.null();
  });

  it('should honour a query-string token on neither a loopback listener nor the tunnel listener', async () => {
    // A route that wants a credential, served once on an ordinary loopback listener and once with the
    // tunnel's rule. A token in a URL reaches argv and every access log, so no listener reads one: the
    // same `?token=` is refused on both.
    // Arrange
    const arrivals: ApiRequest[] = [];
    const surface = tunnelListenerSurface({
      route: recordingRoute('operator', arrivals),
      credentials: CREDENTIALS,
      guard: NO_GOVERNED_ROUTES_GUARD,
      corsOrigins: [],
    });
    const server = new BunApiServer();
    const loopback = await server.listen(surface, { host: '127.0.0.1', port: 0, directLoopbackIsPrivileged: true });
    const tunnel = await server.listen(surface, {
      host: '127.0.0.1',
      port: 0,
      directLoopbackIsPrivileged: true,
      remotePeer: tunnelPeer,
    });
    cleanups.push(async () => {
      for (const listener of [loopback, tunnel]) {
        listener.closeSockets();
        await listener.stop();
      }
    });
    const path = `/v1/rendezvous/fy_daemon_any/client?token=${CREDENTIALS.admin}`;

    // Act
    const fromLoopback = await upgrade(`ws://127.0.0.1:${String(loopback.port)}${path}`);
    const fromTunnel = await upgrade(`ws://127.0.0.1:${String(tunnel.port)}${path}`);

    // Assert
    should(fromLoopback).equal(401);
    should(fromTunnel).equal(401);
    should(arrivals).deepEqual([]);
  });

  it('should withdraw the tunnel while cloudflared is down, and keep restarting it', async () => {
    // Arrange — a connector that exits as soon as it starts.
    const world = await harness();
    const fake = await fakeCloudflared('exit');
    const subject = world.carrier({ cloudflared: new CloudflaredLocator({ FY_CLOUDFLARED: fake.path }) });
    cleanups.push(() => subject.stop());

    // Act
    subject.start();
    await subject.idle();
    await waitFor(() => world.stated.length > 0, 'the connector to exit');

    // Assert
    should(world.published).deepEqual([]);
    should(world.stated[0]).match(/^tunnel connector down — cloudflared exited \(code 3\); restarting in \d+s$/u);
  });

  it('should be off with the remedy when FY_CLOUDFLARED names nothing, and say why when the service is not set up', async () => {
    // Arrange
    const world = await harness();
    world.service.available = false;

    // Act
    const absent = world.carrier({
      cloudflared: new CloudflaredLocator({ FY_CLOUDFLARED: '/nonexistent/cloudflared' }),
    });
    absent.start();
    await absent.idle();
    const unset = world.carrier();
    unset.start();
    await unset.idle();

    // Assert
    should(world.stated).deepEqual([
      `tunnel carrier off — FY_CLOUDFLARED names /nonexistent/cloudflared, which is not an executable file, so this daemon has no tunnel carrier — install cloudflared (Homebrew: brew install cloudflared; Nix: the ferretry package carries it; otherwise your package manager) or set FY_CLOUDFLARED to its path, then restart. Ferretry never downloads it itself.`,
      'tunnel carrier off — the hosted tunnel service is not set up by its operator',
    ]);
    should(world.service.paths).deepEqual(['GET /v1/tunnel-service']);
  });

  it('should release the tunnel an earlier boot held once the entry is switched off', async () => {
    // Arrange — a boot that provisions, then a boot with the carrier switched off.
    const world = await harness();
    const first = world.carrier();
    first.start();
    await first.idle();
    await first.stop();

    // Act
    const off = world.carrier({ entry: { kind: 'tunnel', source: 'discovery', enabled: false } });
    off.start();
    await off.idle();

    // Assert
    should(world.service.releases).deepEqual([world.identity.daemonId]);
    should(world.service.verdicts).deepEqual([true, true]);
    await should(readFile(world.holdingFile, 'utf8')).be.rejected();
    should(world.steps).containEql(
      'tunnel released: https://quiet-otter.tunnels.example, because the tunnel carrier is switched off',
    );
  });

  it('should release on update a tunnel the old implied-on default provisioned, and say how to turn it on', async () => {
    // Arrange — a boot from the release where an undeclared tunnel was implied on.
    const world = await harness();
    const first = world.carrier({ explicit: false });
    first.start();
    await first.idle();
    await first.stop();

    // Act — the same document after the update: no tunnel entry, which now means off.
    const updated = world.carrier({ entry: IMPLIED_TUNNEL_CARRIER, explicit: false });
    updated.start();
    await updated.idle();

    // Assert
    should(world.service.releases).deepEqual([world.identity.daemonId]);
    await should(readFile(world.holdingFile, 'utf8')).be.rejected();
    should(world.stated).containEql(
      'tunnel carrier off (opt-in) — released https://quiet-otter.tunnels.example; turn on with `fy daemon tunnel on`',
    );
  });

  it('should switch on and off live: provision and publish, then withdraw, stop and release at once', async () => {
    // Arrange — the opt-in default, with the switch's decisions recorded where a document would hold them.
    const world = await harness();
    const writes: boolean[] = [];
    const tunnel = new TunnelCarrierSwitch({
      entry: IMPLIED_TUNNEL_CARRIER,
      explicit: false,
      store: { write: async entry => void writes.push(entry.enabled) },
    });
    tunnel.start((entry, explicit) => world.carrier({ entry, explicit }));
    cleanups.push(() => tunnel.stop());
    const before = tunnel.view();

    // Act — on, until the connector registers and the tunnel is published.
    await tunnel.change(true);
    await waitFor(() => tunnel.view().state === 'up', 'the tunnel to come up');
    const up = tunnel.view();
    const listenerPort = world.port();
    // Off: the answer comes once the tunnel is back in the pool.
    const off = await tunnel.change(false);

    // Assert
    should(before.state).equal('off');
    should(world.service.provisions.length).equal(1);
    should(up).deepEqual({
      enabled: true,
      explicit: true,
      state: 'up',
      tunnelUrl: 'https://quiet-otter.tunnels.example',
      sentence: 'Tunnel: up — https://quiet-otter.tunnels.example',
    });
    should(world.published).deepEqual(['https://quiet-otter.tunnels.example', undefined]);
    should(world.service.releases).deepEqual([world.identity.daemonId]);
    await should(readFile(world.holdingFile, 'utf8')).be.rejected();
    should(off.state).equal('off');
    should(writes).deepEqual([true, false]);
    should(await fetch(`http://127.0.0.1:${String(listenerPort)}/`).catch(() => 'refused')).equal('refused');
  });
});
