import { describe, it } from 'bun:test';
import should from 'should';
import { type RelayEnvironment, relayFetch } from '../../src/adapters/index.ts';
import relayWorker from '../../src/adapters/worker.ts';
import {
  type ControlMessage,
  decodeControlMessage,
  RELAY_CLOSE_CODES,
  RELAY_PROTOCOL_ID,
  type RelayFrame,
} from '../../src/lib/index.ts';
import { type TestRuntime, testRuntime } from '../support/workers-fakes.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const stranger = `fy_daemon_${'b'.repeat(43)}`;

function environment(configured?: string) {
  const routed: string[] = [];
  const value: RelayEnvironment = {
    RENDEZVOUS: {
      idFromName: name => {
        routed.push(String(name));
        return name;
      },
      get: () => ({ fetch: async () => new Response('durable', { status: 101 }) }),
    },
    RELAY_DAEMON_IDS: configured,
  };
  return { value, routed };
}

function upgrade(path: string): Request {
  return new Request(`https://relay.example${path}`, { headers: { Upgrade: 'WebSocket' } });
}

interface HostedOverrides {
  readonly controlFetch?: (request: Request) => Promise<Response>;
  readonly rendezvousFetch?: (request: Request) => Promise<Response>;
  readonly operatorToken?: string;
}

function hostedEnvironment(overrides: HostedOverrides = {}) {
  const routed: string[] = [];
  const controlRequests: Request[] = [];
  const rendezvousRequests: Request[] = [];
  const controlFetch =
    overrides.controlFetch ??
    (async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === '/public/configuration') return Response.json({ version: 1, relayUrl: 'https://relay.example' });
      if (path === '/operator/configuration') {
        return Response.json({ configured: true, configuration: { relayUrl: 'https://relay.example' } });
      }
      if (path === '/operator/metrics') return Response.json({ global: { requestCount: 1 }, daemons: [] });
      return Response.json({ ok: true });
    });
  const value: RelayEnvironment = {
    RELAY_MODE: 'hosted',
    RELAY_OPERATOR_TOKEN: overrides.operatorToken,
    RELAY_CONTROL: {
      idFromName: name => name,
      get: () => ({
        fetch: async request => {
          controlRequests.push(request);
          return controlFetch(request);
        },
      }),
    },
    RENDEZVOUS: {
      idFromName: name => {
        routed.push(String(name));
        return name;
      },
      get: () => ({
        fetch: async request => {
          rendezvousRequests.push(request);
          return (overrides.rendezvousFetch ?? (async () => new Response('durable', { status: 101 })))(request);
        },
      }),
    },
  };
  return { value, routed, controlRequests, rendezvousRequests };
}

function controlOf(frame: RelayFrame | undefined): ControlMessage | null {
  return frame === undefined ? null : decodeControlMessage(frame.payload);
}

function refusal(runtime: TestRuntime): { readonly control: ControlMessage | null; readonly code?: number } {
  const socket = runtime.pairs[0]?.server;
  if (socket === undefined) throw new Error('worker did not create a refusal socket');
  should(socket.accepted).be.true();
  return { control: controlOf(socket.frames()[0]), code: socket.closed?.code };
}

describe('relay worker route', () => {
  it('should route an allowed daemon to its own durable rendezvous', async () => {
    const { value, routed } = environment(daemonId);
    const response = await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/daemon`), value);
    should(response.status).equal(101);
    should(routed).deepEqual([`${RELAY_PROTOCOL_ID}:${daemonId}`]);
  });

  it('should refuse a fingerprint this deployment does not carry, without allocating anything', async () => {
    const { value, routed } = environment(daemonId);
    const response = await relayFetch(upgrade(`/v1/rendezvous/${stranger}/client`), value);
    should(response.status).equal(404);
    should(routed).deepEqual([]);
  });

  it('should serve nobody when the deployment lists nobody', async () => {
    const { value, routed } = environment(undefined);
    should((await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/client`), value)).status).equal(404);
    should(routed).deepEqual([]);
  });

  it('should answer a path that is not a rendezvous exactly as it answers an unknown daemon', async () => {
    const { value } = environment(daemonId);
    should((await relayFetch(upgrade('/'), value)).status).equal(404);
    should((await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/admin`), value)).status).equal(404);
  });

  it('should refuse a plain request to a socket route', async () => {
    const { value, routed } = environment(daemonId);
    const response = await relayFetch(new Request(`https://relay.example/v1/rendezvous/${daemonId}/client`), value);
    should(response.status).equal(426);
    should(routed).deepEqual([]);
  });

  it('should expose the same handler as the module default the platform loads', async () => {
    const { value } = environment(daemonId);
    should((await relayWorker.fetch(upgrade(`/v1/rendezvous/${daemonId}/daemon`), value)).status).equal(101);
  });

  it('should keep an explicit self-hosted mode on the existing allowlist path', async () => {
    const { value } = environment(daemonId);
    const explicit = { ...value, RELAY_MODE: 'self-hosted' };
    should((await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/daemon`), explicit)).status).equal(101);
    should((await relayFetch(upgrade(`/v1/rendezvous/${stranger}/daemon`), explicit)).status).equal(404);
  });

  it('should fail closed on an unknown deployment mode', async () => {
    const { value } = environment(daemonId);
    const response = await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/daemon`), {
      ...value,
      RELAY_MODE: 'typo',
    });
    should(response.status).equal(503);
  });
});

describe('hosted relay worker routes', () => {
  it('should reserve globally before routing any valid daemon and pass only the minted reservation', async () => {
    const harness = hostedEnvironment();
    const runtime = testRuntime();
    const response = await relayFetch(upgrade(`/v1/rendezvous/${stranger}/client`), harness.value, runtime);
    should(response.status).equal(101);
    should(harness.routed).deepEqual([`${RELAY_PROTOCOL_ID}:${stranger}`]);
    should(new URL(harness.controlRequests[0]?.url ?? '').pathname).equal('/internal/reserve');
    const reservation = harness.rendezvousRequests[0]?.headers.get('x-ferretry-relay-reservation');
    should(reservation?.length).be.above(10);
  });

  it('should accept a refusal socket, explain a capacity denial, and allocate no rendezvous', async () => {
    const harness = hostedEnvironment({
      controlFetch: async () =>
        Response.json({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity, reason: 'global connection ceiling' }),
    });
    const runtime = testRuntime();
    should((await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/client`), harness.value, runtime)).status).equal(200);
    should(refusal(runtime)).match({
      control: { t: 'error', code: RELAY_CLOSE_CODES.hostedCapacity, reason: 'global connection ceiling' },
      code: RELAY_CLOSE_CODES.hostedCapacity,
    });
    should(harness.routed).deepEqual([]);
  });

  it('should make missing, failed or malformed accounting a clear internal refusal', async () => {
    const cases: RelayEnvironment[] = [
      { ...hostedEnvironment().value, RELAY_CONTROL: undefined },
      hostedEnvironment({ controlFetch: async () => new Response(null, { status: 503 }) }).value,
      hostedEnvironment({ controlFetch: async () => Response.json({ maybe: true }) }).value,
      hostedEnvironment({ controlFetch: async () => Promise.reject(new Error('down')) }).value,
    ];
    for (const value of cases) {
      const runtime = testRuntime();
      await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/client`), value, runtime);
      should(refusal(runtime)).match({
        control: { t: 'error', code: RELAY_CLOSE_CODES.relayInternal },
        code: RELAY_CLOSE_CODES.relayInternal,
      });
    }
  });

  it('should release a reservation and explain a failed rendezvous handoff', async () => {
    for (const rendezvousFetch of [
      async () => new Response('no upgrade', { status: 503 }),
      async () => Promise.reject(new Error('down')),
    ]) {
      const harness = hostedEnvironment({ rendezvousFetch });
      const runtime = testRuntime();
      await relayFetch(upgrade(`/v1/rendezvous/${daemonId}/client`), harness.value, runtime);
      should(harness.controlRequests.map(request => new URL(request.url).pathname)).deepEqual([
        '/internal/reserve',
        '/internal/release',
      ]);
      should(refusal(runtime).code).equal(RELAY_CLOSE_CODES.relayInternal);
    }
  });

  it('should reject a non-upgrade before spending a control-plane request', async () => {
    const harness = hostedEnvironment();
    const response = await relayFetch(
      new Request(`https://relay.example/v1/rendezvous/${daemonId}/client`),
      harness.value,
      testRuntime(),
    );
    should(response.status).equal(426);
    should(harness.controlRequests).deepEqual([]);
  });

  it('should expose a no-store public advertisement with a CORS preflight', async () => {
    const harness = hostedEnvironment();
    const advertised = await relayFetch(new Request('https://relay.example/v1/default-relay'), harness.value);
    should(advertised.status).equal(200);
    should(await advertised.json()).deepEqual({ version: 1, relayUrl: 'https://relay.example' });

    const preflight = await relayFetch(
      new Request('https://relay.example/v1/default-relay', { method: 'OPTIONS' }),
      harness.value,
    );
    should(preflight.status).equal(204);
    should(preflight.headers.get('Access-Control-Allow-Origin')).equal('*');
    should(
      (await relayFetch(new Request('https://relay.example/v1/default-relay', { method: 'PUT' }), harness.value))
        .status,
    ).equal(405);
  });

  it('should fail public discovery closed when its control state cannot be read', async () => {
    should(
      (
        await relayFetch(new Request('https://relay.example/v1/default-relay'), {
          ...hostedEnvironment().value,
          RELAY_CONTROL: undefined,
        })
      ).status,
    ).equal(503);
    should(
      (
        await relayFetch(
          new Request('https://relay.example/v1/default-relay'),
          hostedEnvironment({ controlFetch: async () => Promise.reject(new Error('down')) }).value,
        )
      ).status,
    ).equal(503);
  });

  it('should authenticate and proxy operator configuration and metrics without exposing its secret', async () => {
    const harness = hostedEnvironment({ operatorToken: 'operator-secret' });
    should((await relayFetch(new Request('https://relay.example/v1/operator/config'), harness.value)).status).equal(
      401,
    );
    const authorized = (path: string, init: RequestInit = {}) =>
      new Request(`https://relay.example${path}`, {
        ...init,
        headers: { Authorization: 'Bearer operator-secret', ...init.headers },
      });
    should((await relayFetch(authorized('/v1/operator/config'), harness.value)).status).equal(200);
    should((await relayFetch(authorized('/v1/operator/metrics'), harness.value)).status).equal(200);
    should(
      (
        await relayFetch(
          authorized('/v1/operator/config', { method: 'PUT', body: JSON.stringify({ version: 1 }) }),
          harness.value,
        )
      ).status,
    ).equal(200);
    should((await relayFetch(authorized('/v1/operator/metrics', { method: 'PUT' }), harness.value)).status).equal(405);
    should(harness.controlRequests.map(request => new URL(request.url).pathname)).deepEqual([
      '/operator/configuration',
      '/operator/metrics',
      '/operator/configuration',
    ]);
  });

  it('should fail operator access closed when authentication or control is unavailable', async () => {
    const missing = hostedEnvironment();
    should((await relayFetch(new Request('https://relay.example/v1/operator/config'), missing.value)).status).equal(
      503,
    );

    const unavailable = hostedEnvironment({ operatorToken: 'secret', controlFetch: async () => Promise.reject() });
    should(
      (
        await relayFetch(
          new Request('https://relay.example/v1/operator/config', {
            headers: { Authorization: 'Bearer secret' },
          }),
          unavailable.value,
        )
      ).status,
    ).equal(503);
    should(
      (
        await relayFetch(
          new Request('https://relay.example/v1/operator/config', {
            headers: { Authorization: 'Bearer secret' },
          }),
          { ...hostedEnvironment({ operatorToken: 'secret' }).value, RELAY_CONTROL: undefined },
        )
      ).status,
    ).equal(503);
  });
});
