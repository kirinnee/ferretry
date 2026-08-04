import { describe, it } from 'bun:test';
import should from 'should';
import {
  type HostedRelayControlNamespace,
  releaseHostedRelayReservation,
  requestHostedRelayDecision,
} from '../../src/adapters/index.ts';
import { HostedRelayControlDurableObject } from '../../src/adapters/worker.ts';
import {
  DEFAULT_HOSTED_RELAY_LIMITS,
  type HostedRelayConfigurationInput,
  initialHostedRelayDaemonMetrics,
  initialHostedRelayGlobalMetrics,
  RELAY_CLOSE_CODES,
} from '../../src/lib/index.ts';
import { FakeHostedRelayControlStorage } from '../support/hosted-control-fakes.ts';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const otherDaemonId = `fy_daemon_${'b'.repeat(43)}`;

function enabledConfiguration(
  overrides: Partial<HostedRelayConfigurationInput['limits']> = {},
): HostedRelayConfigurationInput {
  return {
    version: 1,
    relayUrl: 'https://relay.example',
    limits: { ...DEFAULT_HOSTED_RELAY_LIMITS, ...overrides },
  };
}

function makeObject() {
  const storage = new FakeHostedRelayControlStorage();
  const runtime = { clock: 1_000, now: () => runtime.clock };
  const object = new HostedRelayControlDurableObject({ storage }, {}, runtime);
  return { storage, runtime, object };
}

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://relay-control.invalid${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
  });
}

async function configure(harness: ReturnType<typeof makeObject>, input = enabledConfiguration()): Promise<void> {
  const response = await harness.object.fetch(request('/operator/configuration', 'PUT', input));
  should(response.status).equal(200);
}

describe('hosted relay control Durable Object', () => {
  it('should expose a known disabled virgin state without mistaking stray evidence for empty', async () => {
    const harness = makeObject();
    const publicResponse = await harness.object.fetch(request('/public/configuration'));
    should(publicResponse.status).equal(200);
    should(publicResponse.headers.get('Access-Control-Allow-Origin')).equal('*');
    should(await publicResponse.json()).deepEqual({ version: 1, relayUrl: null });

    const operator = await harness.object.fetch(request('/operator/configuration'));
    should(await operator.json()).match({ configured: false, configuration: { relayUrl: null } });
    const metrics = await harness.object.fetch(request('/operator/metrics'));
    should(await metrics.json()).match({ configured: false, global: { trackedDaemons: 0 }, daemons: [] });

    for (const [path, body] of [
      ['/internal/reserve', { daemonId, reservationId: 'reservation_0001' }],
      ['/internal/meter', { daemonId, bytes: 1 }],
      ['/internal/inspect', { daemonId }],
    ] as const) {
      should(await (await harness.object.fetch(request(path, 'POST', body))).json()).match({
        ok: false,
        code: RELAY_CLOSE_CODES.hostedDisabled,
      });
    }

    harness.storage.values.set('metrics:daemon:orphan', {});
    should((await harness.object.fetch(request('/public/configuration'))).status).equal(503);
  });

  it('should validate, normalize and replace runtime configuration without a deploy', async () => {
    const harness = makeObject();
    should((await harness.object.fetch(request('/operator/configuration', 'PUT', '{'))).status).equal(400);
    should(
      (
        await harness.object.fetch(
          request('/operator/configuration', 'PUT', { ...enabledConfiguration(), relayUrl: 'http://relay.example' }),
        )
      ).status,
    ).equal(400);

    await configure(harness, { ...enabledConfiguration(), relayUrl: 'https://relay.example/' });
    const configured = (await (await harness.object.fetch(request('/operator/configuration'))).json()) as {
      configuration: { relayUrl: string | null; updatedAt: number };
    };
    should(configured.configuration).match({ relayUrl: 'https://relay.example', updatedAt: 1_000 });

    harness.runtime.clock = 2_000;
    await configure(harness, { ...enabledConfiguration(), relayUrl: null });
    should(await (await harness.object.fetch(request('/public/configuration'))).json()).deepEqual({
      version: 1,
      relayUrl: null,
    });
  });

  it('should reserve, meter, inspect, release and report one daemon atomically', async () => {
    const harness = makeObject();
    await configure(harness);
    harness.runtime.clock += 1;

    const reserved = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await reserved.json()).deepEqual({ ok: true });
    const duplicate = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await duplicate.json()).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });

    harness.runtime.clock += 1;
    should(
      await (await harness.object.fetch(request('/internal/meter', 'POST', { daemonId, bytes: 4_096 }))).json(),
    ).deepEqual({ ok: true });
    should(await (await harness.object.fetch(request('/internal/inspect', 'POST', { daemonId }))).json()).deepEqual({
      ok: true,
    });

    const metrics = (await (await harness.object.fetch(request('/operator/metrics'))).json()) as {
      global: { requestCount: number; bytesRelayed: number; concurrentConnections: number };
      daemons: { daemonId: string; requestCount: number; bytesRelayed: number; concurrentConnections: number }[];
    };
    should(metrics.global).match({ requestCount: 2, bytesRelayed: 4_096, concurrentConnections: 1 });
    should(metrics.daemons).deepEqual([
      { ...metrics.daemons[0], daemonId, requestCount: 2, bytesRelayed: 4_096, concurrentConnections: 1 },
    ]);

    harness.runtime.clock += 1;
    should(
      await (
        await harness.object.fetch(request('/internal/release', 'POST', { reservationId: 'reservation_0001' }))
      ).json(),
    ).deepEqual({ ok: true });
    should(
      await (
        await harness.object.fetch(request('/internal/release', 'POST', { reservationId: 'reservation_0001' }))
      ).json(),
    ).deepEqual({ ok: true });
    should(
      (
        (await (await harness.object.fetch(request('/operator/metrics'))).json()) as {
          global: { concurrentConnections: number };
        }
      ).global.concurrentConnections,
    ).equal(0);
  });

  it('should fail closed at connection and bandwidth ceilings and after the kill switch flips', async () => {
    const harness = makeObject();
    await configure(
      harness,
      enabledConfiguration({
        maxConcurrentConnectionsPerDaemon: 1,
        maxConcurrentConnectionsGlobal: 1,
        maxBytesPerMinutePerDaemon: 10,
        maxBytesPerMinuteGlobal: 10,
        maxBytesPerDayPerDaemon: 10,
        maxBytesPerDayGlobal: 10,
      }),
    );
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0002' }),
        )
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(
      await (await harness.object.fetch(request('/internal/meter', 'POST', { daemonId, bytes: 10 }))).json(),
    ).deepEqual({
      ok: true,
    });
    should(await (await harness.object.fetch(request('/internal/meter', 'POST', { daemonId, bytes: 1 }))).json()).match(
      { ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth },
    );

    await configure(harness, { ...enabledConfiguration(), relayUrl: null });
    should(await (await harness.object.fetch(request('/internal/inspect', 'POST', { daemonId }))).json()).match({
      ok: false,
      code: RELAY_CLOSE_CODES.hostedDisabled,
    });
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId: otherDaemonId, reservationId: 'reservation_0003' }),
        )
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedDisabled });
  });

  it('should reject malformed internal calls and unknown routes', async () => {
    const harness = makeObject();
    await configure(harness);
    for (const path of ['/internal/reserve', '/internal/meter', '/internal/release', '/internal/inspect']) {
      should((await harness.object.fetch(request(path, 'POST', {}))).status).equal(400);
    }
    should((await harness.object.fetch(request('/unknown'))).status).equal(404);
    should((await harness.object.fetch(request('/unknown', 'POST', {}))).status).equal(404);
    should((await harness.object.fetch(request('/internal/reserve', 'GET'))).status).equal(404);
  });

  it('should surface damaged configuration, global, daemon and reservation state', async () => {
    const harness = makeObject();
    await configure(harness);
    const configuration = harness.storage.values.get('control:configuration');
    harness.storage.values.delete('metrics:global');
    should((await harness.object.fetch(request('/operator/configuration'))).status).equal(503);

    harness.storage.values.set('metrics:global', initialHostedRelayGlobalMetrics(harness.runtime.clock));
    harness.storage.values.set('control:configuration', { broken: true });
    should((await harness.object.fetch(request('/operator/configuration'))).status).equal(503);
    harness.storage.values.set('control:configuration', configuration);
    harness.storage.values.set(`metrics:daemon:${daemonId}`, { daemonId, broken: true });
    should(
      (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).status,
    ).equal(503);

    harness.storage.values.set(`metrics:daemon:${daemonId}`, initialHostedRelayDaemonMetrics(daemonId, 1_000));
    harness.storage.values.set('reservation:reservation_0001', { broken: true });
    should(
      (await harness.object.fetch(request('/internal/release', 'POST', { reservationId: 'reservation_0001' }))).status,
    ).equal(503);
  });

  it('should refuse a metrics snapshot when durable keys and counters disagree', async () => {
    const harness = makeObject();
    await configure(harness);
    harness.storage.values.set(`metrics:daemon:${daemonId}`, initialHostedRelayDaemonMetrics(daemonId, 1_000));
    should((await harness.object.fetch(request('/operator/metrics'))).status).equal(503);

    harness.storage.values.set('metrics:global', { ...initialHostedRelayGlobalMetrics(1_000), trackedDaemons: 1 });
    harness.storage.values.set('reservation:not_the_record_id', {
      reservationId: 'reservation_0001',
      daemonId,
      openedAt: 1_000,
    });
    should((await harness.object.fetch(request('/operator/metrics'))).status).equal(503);
  });

  it('should page through every daemon metric row deterministically', async () => {
    const harness = makeObject();
    await configure(harness);
    for (let index = 0; index < 1_000; index += 1) {
      const id = `fy_daemon_${String(index).padStart(43, 'a')}`;
      harness.storage.values.set(`metrics:daemon:${id}`, initialHostedRelayDaemonMetrics(id, 1_000));
    }
    harness.storage.values.set('metrics:global', { ...initialHostedRelayGlobalMetrics(1_000), trackedDaemons: 1_000 });
    const response = await harness.object.fetch(request('/operator/metrics'));
    should(response.status).equal(200);
    should(((await response.json()) as { daemons: unknown[] }).daemons.length).equal(1_000);
  });
});

describe('hosted relay control clients', () => {
  it('should parse decisions and make releases through the named singleton', async () => {
    const harness = makeObject();
    await configure(harness);
    const names: string[] = [];
    const namespace: HostedRelayControlNamespace = {
      idFromName: name => {
        names.push(name);
        return name;
      },
      get: () => ({ fetch: request => harness.object.fetch(request) }),
    };
    should(
      await requestHostedRelayDecision(namespace, 'reserve', { daemonId, reservationId: 'reservation_0001' }),
    ).deepEqual({ ok: true });
    should(await requestHostedRelayDecision(namespace, 'meter', { daemonId, bytes: 1 })).deepEqual({ ok: true });
    should(await requestHostedRelayDecision(namespace, 'inspect', { daemonId })).deepEqual({ ok: true });
    should(await releaseHostedRelayReservation(namespace, 'reservation_0001')).be.true();
    should(names.every(name => name === 'ferretry-relay-control/v1')).be.true();
  });

  it('should treat transport, status and body ambiguity as unavailable', async () => {
    const namespace = (response: () => Promise<Response>): HostedRelayControlNamespace => ({
      idFromName: name => name,
      get: () => ({ fetch: response }),
    });
    should(
      await requestHostedRelayDecision(
        namespace(async () => new Response(null, { status: 503 })),
        'inspect',
        {},
      ),
    ).be.null();
    should(
      await requestHostedRelayDecision(
        namespace(async () => new Response('{}')),
        'inspect',
        {},
      ),
    ).be.null();
    should(
      await requestHostedRelayDecision(
        namespace(async () => Promise.reject(new Error('down'))),
        'inspect',
        {},
      ),
    ).be.null();
    should(
      await releaseHostedRelayReservation(
        namespace(async () => new Response(null, { status: 503 })),
        'valid_id_0000001',
      ),
    ).be.false();
    should(
      await releaseHostedRelayReservation(
        namespace(async () => new Response('{}')),
        'valid_id_0000001',
      ),
    ).be.false();
    should(
      await releaseHostedRelayReservation(
        namespace(async () => Promise.reject(new Error('down'))),
        'valid_id_0000001',
      ),
    ).be.false();
  });
});
