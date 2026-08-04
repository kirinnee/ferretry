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
  HOSTED_RELAY_DAY_MILLISECONDS,
  type HostedRelayConfigurationInput,
  type HostedRelayDaemonMetrics,
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

  it('should keep the operator snapshot readable after a first-time daemon is refused at the global cap', async () => {
    const harness = makeObject();
    await configure(
      harness,
      enabledConfiguration({ maxConcurrentConnectionsPerDaemon: 1, maxConcurrentConnectionsGlobal: 1 }),
    );
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });

    harness.runtime.clock += 1;
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId: otherDaemonId, reservationId: 'reservation_0002' }),
        )
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });

    // The refusal must not have left an uncounted row behind, or this snapshot 503s forever.
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.false();
    const snapshot = await harness.object.fetch(request('/operator/metrics'));
    should(snapshot.status).equal(200);
    const body = (await snapshot.json()) as {
      global: { trackedDaemons: number; connectionRefusals: number };
      daemons: { daemonId: string }[];
    };
    should(body.global.trackedDaemons).equal(body.daemons.length);
    should(body.daemons.map(daemon => daemon.daemonId)).deepEqual([daemonId]);
    should(body.global.connectionRefusals).equal(1);
  });
});

describe('hosted relay daemon row cap recovery', () => {
  const staleClock = 1_000;
  const laterDay = HOSTED_RELAY_DAY_MILLISECONDS * 3 + 5_000;

  /** One census of `rows` stored rows with matching global counters, so the snapshot is consistent. */
  async function atRowCap(
    rows: readonly HostedRelayDaemonMetrics[],
    reservations: readonly HostedRelayReservationRow[],
    census = rows.length,
  ) {
    const harness = makeObject();
    await configure(harness, enabledConfiguration({ maxTrackedDaemons: Math.max(census, 1) }));
    for (const row of rows) harness.storage.values.set(`metrics:daemon:${row.daemonId}`, row);
    for (const reservation of reservations) {
      harness.storage.values.set(`reservation:${reservation.reservationId}`, reservation);
    }
    harness.storage.values.set('metrics:global', {
      ...initialHostedRelayGlobalMetrics(staleClock),
      requestCount: 41,
      bytesRelayed: 4_096,
      trackedDaemons: census,
      concurrentConnections: reservations.length,
      peakConcurrentConnections: reservations.length,
      ...(reservations.length === 0 ? {} : { lastActivityAt: staleClock, firstActivityAt: staleClock }),
    });
    harness.runtime.clock = laterDay;
    return harness;
  }

  interface HostedRelayReservationRow {
    readonly reservationId: string;
    readonly daemonId: string;
    readonly openedAt: number;
  }

  function staleRow(id: string): HostedRelayDaemonMetrics {
    return { ...initialHostedRelayDaemonMetrics(id, staleClock), requestCount: 7, lastActivityAt: staleClock };
  }

  it('should reclaim an idle row from a completed day and admit the new daemon', async () => {
    const harness = await atRowCap([staleRow(otherDaemonId)], []);
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });

    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.false();
    should(harness.storage.values.has(`metrics:daemon:${daemonId}`)).be.true();
    const snapshot = await harness.object.fetch(request('/operator/metrics'));
    should(snapshot.status).equal(200);
    const body = (await snapshot.json()) as {
      global: { trackedDaemons: number; requestCount: number; bytesRelayed: number };
      daemons: { daemonId: string }[];
    };
    should(body.global.trackedDaemons).equal(1);
    should(body.daemons.map(daemon => daemon.daemonId)).deepEqual([daemonId]);
    // Forgetting a row tidies the census, never the bill the account already ran up.
    should(body.global.requestCount).be.above(41);
    should(body.global.bytesRelayed).equal(4_096);
  });

  it('should refuse rather than reclaim a row that is live or still inside the current day', async () => {
    const live = await atRowCap(
      [{ ...staleRow(otherDaemonId), concurrentConnections: 1 }],
      [{ reservationId: 'reservation_live001', daemonId: otherDaemonId, openedAt: staleClock }],
    );
    should(
      await (
        await live.object.fetch(request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }))
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(live.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
    should((await live.object.fetch(request('/operator/metrics'))).status).equal(200);

    const today = await atRowCap(
      [
        {
          ...staleRow(otherDaemonId),
          lastActivityAt: laterDay,
          day: { startedAt: HOSTED_RELAY_DAY_MILLISECONDS * 3, bytes: 128 },
        },
      ],
      [],
    );
    should(
      await (
        await today.object.fetch(request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0002' }))
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(today.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
  });

  it('should keep an unstamped row instead of reclaiming evidence it cannot account for', async () => {
    const harness = await atRowCap([{ ...staleRow(otherDaemonId), lastActivityAt: null }], []);
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
  });

  it('should fail closed on a damaged row rather than delete what it cannot read', async () => {
    const harness = await atRowCap([staleRow(otherDaemonId)], []);
    harness.storage.values.set(`metrics:daemon:${otherDaemonId}`, { daemonId: otherDaemonId, broken: true });
    const refused = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(refused.status).equal(503);
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
    should(harness.storage.values.has(`metrics:daemon:${daemonId}`)).be.false();
  });

  it('should carry the sweep forward so a row the last pass never reached is still recovered', async () => {
    const harness = await atRowCap([staleRow(otherDaemonId)], []);
    // The last pass stopped past every stored row, so this pass starts beyond the only stale row.
    harness.storage.values.set('control:reclaim-cursor', {
      scannedThrough: `${'metrics:daemon:fy_daemon_'}${'z'.repeat(43)}`,
    });

    const beyondHorizon = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await beyondHorizon.json()).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
    // A pass that recovered nothing still has to leave the next one somewhere new: wrapped to the start.
    should(harness.storage.values.get('control:reclaim-cursor')).deepEqual({ scannedThrough: null });

    // Recovery is therefore a matter of attempts, not of where a fingerprint happens to sort.
    harness.runtime.clock += 1;
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0002' }),
        )
      ).json(),
    ).deepEqual({ ok: true });
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.false();
    should((await harness.object.fetch(request('/operator/metrics'))).status).equal(200);
  });

  it('should count the whole census even when it may only forget one batch of it', async () => {
    // More stale rows than one batch may forget. Filling the batch must not make the sweep abandon
    // the rest of the page and report 64 as if it were the durable row total.
    const crowded = Array.from({ length: 70 }, (_unused, index) =>
      staleRow(`fy_daemon_${String(index).padStart(43, 'a')}`),
    );
    const harness = await atRowCap(crowded, []);

    const admitted = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await admitted.json()).deepEqual({ ok: true });
    // The pass read the whole prefix, so it wrapped rather than stopping where the batch filled.
    should(harness.storage.values.get('control:reclaim-cursor')).deepEqual({ scannedThrough: null });

    // 64 forgotten, 6 left, plus the daemon just admitted — and the census still agrees with storage.
    const snapshot = await harness.object.fetch(request('/operator/metrics'));
    should(snapshot.status).equal(200);
    const body = (await snapshot.json()) as { global: { trackedDaemons: number }; daemons: unknown[] };
    should(body.daemons.length).equal(7);
    should(body.global.trackedDaemons).equal(7);
  });

  it('should leave the next pass a new place to look when the census outruns one sweep budget', async () => {
    // A census larger than a single sweep can read: the pass must stop somewhere concrete rather than
    // wrap, or every later attempt would re-read the same rows and the ceiling would never recover.
    const beyondBudget = Array.from({ length: 12_001 }, (_unused, index) =>
      staleRow(`fy_daemon_${String(index).padStart(43, 'a')}`),
    );
    const harness = await atRowCap(beyondBudget, []);

    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });
    const cursor = harness.storage.values.get('control:reclaim-cursor') as { scannedThrough: string | null };
    should(cursor.scannedThrough).be.a.String();
    should(cursor.scannedThrough).startWith('metrics:daemon:');
  });

  it('should fail closed on a damaged sweep cursor instead of restarting from the top', async () => {
    const harness = await atRowCap([staleRow(otherDaemonId)], []);
    for (const damaged of [
      { scannedThrough: 'reservation:not-a-daemon-key' },
      // Right prefix, but not a key this object could ever have written.
      { scannedThrough: `${'metrics:daemon:'}not-a-fingerprint` },
      { broken: true },
      'not-an-object',
    ]) {
      harness.storage.values.set('control:reclaim-cursor', damaged);
      should(
        (
          await harness.object.fetch(
            request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
          )
        ).status,
      ).equal(503);
    }
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
  });

  it('should refuse to tidy rows while the census already disagrees with what storage holds', async () => {
    // The census claims two rows; storage holds one. Deleting the stale row would bury that, not fix it.
    const harness = await atRowCap([staleRow(otherDaemonId)], [], 2);
    const refused = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(refused.status).equal(503);
    should(await refused.json()).deepEqual({ error: 'relay metrics and daemon rows disagree' });
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
    should(harness.storage.values.has('control:reclaim-cursor')).be.false();
  });

  it('should fail closed when a row key disagrees with the fingerprint inside it', async () => {
    const harness = await atRowCap([staleRow(otherDaemonId)], []);
    harness.storage.values.delete(`metrics:daemon:${otherDaemonId}`);
    harness.storage.values.set(`metrics:daemon:${otherDaemonId}`, staleRow(`fy_daemon_${'c'.repeat(43)}`));
    should(
      (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).status,
    ).equal(503);
  });
});

describe('hosted relay operator configuration contract', () => {
  it('should refuse a stored document echoed back and accept the same edit without the server-owned stamp', async () => {
    const harness = makeObject();
    await configure(harness);
    const stored = (await (await harness.object.fetch(request('/operator/configuration'))).json()) as {
      configuration: Record<string, unknown>;
    };
    should(stored.configuration).have.property('updatedAt');

    // Echoing the GET document straight back is what silently disabled the kill switch.
    const echoed = await harness.object.fetch(
      request('/operator/configuration', 'PUT', { ...stored.configuration, relayUrl: null }),
    );
    should(echoed.status).equal(400);
    should(await echoed.json()).deepEqual({ error: 'invalid hosted relay configuration' });
    should(await (await harness.object.fetch(request('/public/configuration'))).json()).match({
      relayUrl: 'https://relay.example',
    });

    harness.runtime.clock = 5_000;
    const { updatedAt: _ignored, ...operatorOwned } = stored.configuration;
    const projected = await harness.object.fetch(
      request('/operator/configuration', 'PUT', { ...operatorOwned, relayUrl: null }),
    );
    should(projected.status).equal(200);
    should(await projected.json()).match({ configured: true, configuration: { relayUrl: null, updatedAt: 5_000 } });
    should(await (await harness.object.fetch(request('/public/configuration'))).json()).deepEqual({
      version: 1,
      relayUrl: null,
    });
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
