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
    // The same identifier again is a retry of a lost answer, and the stored reservation is the proof
    // it was already admitted. Saying yes again must not move a counter — see the metrics below.
    const retried = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await retried.json()).deepEqual({ ok: true });

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

  it('should recover a stale row wherever its fingerprint happens to sort', async () => {
    // Every row busy except the very last one in key order. A sweep that only read a leading window
    // would never reach it, and the ceiling would stay full for the life of the deployment.
    const busy = Array.from({ length: 200 }, (_unused, index) => ({
      ...staleRow(`fy_daemon_${String(index).padStart(43, 'a')}`),
      lastActivityAt: laterDay,
      day: { startedAt: HOSTED_RELAY_DAY_MILLISECONDS * 3, bytes: 1 },
    }));
    const lastInOrder = staleRow(`fy_daemon_${'z'.repeat(43)}`);
    const harness = await atRowCap([...busy, lastInOrder], []);

    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });
    should(harness.storage.values.has(`metrics:daemon:${lastInOrder.daemonId}`)).be.false();
    should(harness.storage.values.has(`metrics:daemon:fy_daemon_${'0'.padStart(43, 'a')}`)).be.true();
    should((await harness.object.fetch(request('/operator/metrics'))).status).equal(200);
  });

  it('should count the whole census even when it may only forget one batch of it', async () => {
    // More stale rows than one batch may forget. Filling the batch must not stop the counting, since
    // the count is the only thing that proves the census before anything is deleted.
    const crowded = Array.from({ length: 70 }, (_unused, index) =>
      staleRow(`fy_daemon_${String(index).padStart(43, 'a')}`),
    );
    const harness = await atRowCap(crowded, []);

    const admitted = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await admitted.json()).deepEqual({ ok: true });

    // 64 forgotten, 6 left, plus the daemon just admitted — and the census still agrees with storage.
    const snapshot = await harness.object.fetch(request('/operator/metrics'));
    should(snapshot.status).equal(200);
    const body = (await snapshot.json()) as { global: { trackedDaemons: number }; daemons: unknown[] };
    should(body.daemons.length).equal(7);
    should(body.global.trackedDaemons).equal(7);
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
  });

  it('should refuse a deficit no bounded window could ever have proved', async () => {
    // An operator-raised census far past any single-window budget, one row short of what it claims.
    // A sweep reading only a window would see fewer rows than the census and delete anyway, shedding
    // rows on every admission while the deficit itself survived untouched.
    const short = Array.from({ length: 12_001 }, (_unused, index) =>
      staleRow(`fy_daemon_${String(index).padStart(43, 'a')}`),
    );
    const harness = await atRowCap(short, [], 12_002);

    const refused = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(refused.status).equal(503);
    should(await refused.json()).deepEqual({ error: 'relay metrics and daemon rows disagree' });
    should([...harness.storage.values.keys()].filter(key => key.startsWith('metrics:daemon:')).length).equal(12_001);
  });

  it('should refuse a surplus of rows the census never accounted for', async () => {
    // The mirror image: more stored rows than the census claims. Counting stops as soon as the
    // surplus is proved, which is also what bounds the sweep.
    const harness = await atRowCap([staleRow(otherDaemonId), staleRow(`fy_daemon_${'c'.repeat(43)}`)], [], 1);
    const refused = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(refused.status).equal(503);
    should(await refused.json()).deepEqual({ error: 'relay metrics and daemon rows disagree' });
    should(harness.storage.values.has(`metrics:daemon:${otherDaemonId}`)).be.true();
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

  it('should page a mixed-case census correctly and reclaim from it', async () => {
    // Fingerprints are base64url, so mixed case is the norm, and byte order disagrees with locale
    // order on exactly that. Spanning more than one page is what turns the disagreement into either a
    // lost row or an invented census mismatch.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const mixedCase = Array.from({ length: 1_001 }, (_unused, index) => {
      const suffix = `${alphabet[index % alphabet.length]}${alphabet[(index * 7) % alphabet.length]}${String(index).padStart(3, '0')}`;
      return staleRow(`fy_daemon_${suffix.padEnd(43, 'Z')}`);
    });
    const harness = await atRowCap(mixedCase, []);
    should(new Set(mixedCase.map(row => row.daemonId)).size).equal(1_001);

    // A healthy census, so it must be accepted rather than reported as damaged.
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });
    const remaining = [...harness.storage.values.keys()].filter(key => key.startsWith('metrics:daemon:'));
    should(remaining.length).equal(1_001 - 64 + 1);
    should((await harness.object.fetch(request('/operator/metrics'))).status).equal(200);
  });
});

describe('hosted relay barren sweep marker', () => {
  const day = HOSTED_RELAY_DAY_MILLISECONDS;

  /** A full census of `count` rows that were all active today, so nothing is reclaimable. */
  async function fullOfBusyRows(count: number, clock: number) {
    const harness = makeObject();
    await configure(harness, enabledConfiguration({ maxTrackedDaemons: count }));
    for (let index = 0; index < count; index += 1) {
      const id = `fy_daemon_${String(index).padStart(43, 'a')}`;
      harness.storage.values.set(`metrics:daemon:${id}`, {
        ...initialHostedRelayDaemonMetrics(id, clock),
        lastActivityAt: clock,
      });
    }
    harness.storage.values.set('metrics:global', {
      ...initialHostedRelayGlobalMetrics(clock),
      trackedDaemons: count,
      lastActivityAt: clock,
      firstActivityAt: clock,
    });
    harness.runtime.clock = clock;
    harness.storage.listCalls = 0;
    return harness;
  }

  const reserve = (harness: ReturnType<typeof makeObject>, id: string) =>
    harness.object.fetch(request('/internal/reserve', 'POST', { daemonId, reservationId: id }));

  it('should refuse a second arrival without re-reading a prefix it already found barren', async () => {
    const clock = day * 4 + 7_000;
    const harness = await fullOfBusyRows(3, clock);

    should(await (await reserve(harness, 'reservation_0001')).json()).match({
      ok: false,
      code: RELAY_CLOSE_CODES.hostedCapacity,
    });
    const swept = harness.storage.listCalls;
    should(swept).be.above(0);
    should(harness.storage.values.get('control:reclaim-barren')).deepEqual({ coveredDay: day * 4 });

    // Nothing was freed, and nothing can become reclaimable today, so the scan must not repeat.
    harness.storage.listCalls = 0;
    should(await (await reserve(harness, 'reservation_0002')).json()).match({
      ok: false,
      code: RELAY_CLOSE_CODES.hostedCapacity,
    });
    should(harness.storage.listCalls).equal(0);
  });

  it('should sweep again once the UTC day the marker covered is over', async () => {
    const harness = await fullOfBusyRows(3, day * 4 + 7_000);
    should(await (await reserve(harness, 'reservation_0001')).json()).match({ ok: false });

    // Same rows, next day: they are now stale, so the marker must not hold the sweep back.
    harness.runtime.clock = day * 5 + 1_000;
    harness.storage.listCalls = 0;
    should(await (await reserve(harness, 'reservation_0002')).json()).deepEqual({ ok: true });
    should(harness.storage.listCalls).be.above(0);
    // A sweep that freed rows leaves no stale marker behind.
    should(harness.storage.values.has('control:reclaim-barren')).be.false();
    should((await harness.object.fetch(request('/operator/metrics'))).status).equal(200);
  });

  it('should fail closed on a marker nobody could have written rather than ignore it', async () => {
    const harness = await fullOfBusyRows(3, day * 4 + 7_000);
    for (const damaged of [
      { coveredDay: day * 4 + 1 }, // not a UTC day boundary
      { coveredDay: -1 },
      { coveredDay: day * 4, extra: true },
      { broken: true },
      'not-an-object',
    ]) {
      harness.storage.values.set('control:reclaim-barren', damaged);
      should((await reserve(harness, 'reservation_0001')).status).equal(503);
    }
  });

  it('should not let a marker survive as the only trace of a control object', async () => {
    const harness = makeObject();
    harness.storage.values.set('control:reclaim-barren', { coveredDay: 0 });
    // Virgin state plus a sweep marker is not an unused account; it is one that lost the rest.
    should((await harness.object.fetch(request('/public/configuration'))).status).equal(503);
  });

  it('should ignore a barren day entirely once the operator raises the ceiling', async () => {
    const harness = await fullOfBusyRows(3, day * 4 + 7_000);
    should(await (await reserve(harness, 'reservation_0001')).json()).match({ ok: false });
    should(harness.storage.values.has('control:reclaim-barren')).be.true();

    // Room above the census means there is nothing to reclaim for, so no sweep and no marker check.
    await configure(harness, enabledConfiguration({ maxTrackedDaemons: 4 }));
    harness.storage.listCalls = 0;
    should(await (await reserve(harness, 'reservation_0002')).json()).deepEqual({ ok: true });
    should(harness.storage.listCalls).equal(0);
  });

  it('should never record a barren day for a census it could not account for', async () => {
    const harness = await fullOfBusyRows(3, day * 4 + 7_000);
    // One row short of what the census claims: damaged, so nothing may be cached about it.
    harness.storage.values.delete(`metrics:daemon:fy_daemon_${'0'.padStart(43, 'a')}`);
    const refused = await reserve(harness, 'reservation_0001');
    should(refused.status).equal(503);
    should(await refused.json()).deepEqual({ error: 'relay metrics and daemon rows disagree' });
    should(harness.storage.values.has('control:reclaim-barren')).be.false();
  });
});

describe('hosted relay reservation retries', () => {
  it('should treat the same identifier as proof of the admission it already granted', async () => {
    const harness = makeObject();
    await configure(harness);
    const first = await harness.object.fetch(
      request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
    );
    should(await first.json()).deepEqual({ ok: true });
    const before = await (await harness.object.fetch(request('/operator/metrics'))).json();

    harness.runtime.clock += 5;
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).deepEqual({ ok: true });
    // Answering a retry must move nothing: not the counters, not the reservation, not the clock stamps.
    should(await (await harness.object.fetch(request('/operator/metrics'))).json()).match({
      global: (before as { global: unknown }).global,
    });
    should([...harness.storage.values.keys()].filter(key => key.startsWith('reservation:')).length).equal(1);
  });

  it('should refuse a duplicate identifier whose evidence belongs elsewhere or cannot be read', async () => {
    const harness = makeObject();
    await configure(harness);
    harness.storage.values.set('reservation:reservation_0001', {
      reservationId: 'reservation_0001',
      daemonId: otherDaemonId,
      openedAt: 1_000,
    });
    should(
      await (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).json(),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });

    harness.storage.values.set('reservation:reservation_0001', { broken: true });
    should(
      (
        await harness.object.fetch(
          request('/internal/reserve', 'POST', { daemonId, reservationId: 'reservation_0001' }),
        )
      ).status,
    ).equal(503);
    // Neither refusal invented a daemon row or a counter.
    should(harness.storage.values.has(`metrics:daemon:${daemonId}`)).be.false();
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
