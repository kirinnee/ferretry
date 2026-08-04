import { describe, it } from 'bun:test';
import {
  admitHostedRelayConnection,
  advertiseHostedRelay,
  configureHostedRelay,
  DEFAULT_HOSTED_RELAY_LIMITS,
  HOSTED_RELAY_CONFIG_VERSION,
  HOSTED_RELAY_DAY_MILLISECONDS,
  HOSTED_RELAY_MINUTE_MILLISECONDS,
  HostedRelayAdvertisementSchema,
  type HostedRelayConfiguration,
  HostedRelayConfigurationSchema,
  type HostedRelayDaemonMetrics,
  HostedRelayDaemonMetricsSchema,
  HostedRelayDecisionSchema,
  type HostedRelayGlobalMetrics,
  HostedRelayGlobalMetricsSchema,
  type HostedRelayLimits,
  HostedRelayLimitsSchema,
  HostedRelayReservationSchema,
  hostedRelayConnection,
  initialHostedRelayConfiguration,
  initialHostedRelayDaemonMetrics,
  initialHostedRelayGlobalMetrics,
  inspectHostedRelayCapacity,
  MAX_FRAME_BYTES,
  meterHostedRelayRequest,
  RELAY_CLOSE_CODES,
  releaseHostedRelayConnection,
} from '@ferretry/relay';
import should from 'should';

const daemonId = `fy_daemon_${'a'.repeat(43)}`;
const otherDaemonId = `fy_daemon_${'b'.repeat(43)}`;
const at = HOSTED_RELAY_DAY_MILLISECONDS * 2 + HOSTED_RELAY_MINUTE_MILLISECONDS * 3;

function limits(overrides: Partial<HostedRelayLimits> = {}): HostedRelayLimits {
  return { ...DEFAULT_HOSTED_RELAY_LIMITS, ...overrides };
}

function configuration(overrides: Partial<HostedRelayLimits> = {}): HostedRelayConfiguration {
  return configureHostedRelay(
    { version: HOSTED_RELAY_CONFIG_VERSION, relayUrl: 'https://relay.example/', limits: limits(overrides) },
    at,
  );
}

function admitted(config: HostedRelayConfiguration = configuration()): {
  global: HostedRelayGlobalMetrics;
  daemon: HostedRelayDaemonMetrics;
} {
  const result = admitHostedRelayConnection(config, initialHostedRelayGlobalMetrics(at), null, daemonId, at + 1);
  if (!result.decision.ok || result.daemon === null) throw new Error('test admission was refused');
  return { global: result.global, daemon: result.daemon };
}

describe('hosted relay runtime configuration', () => {
  it('should start disabled and advertise no address until the operator configures one', () => {
    const initial = initialHostedRelayConfiguration(at);
    should(initial.relayUrl).be.null();
    should(initial.limits).deepEqual(DEFAULT_HOSTED_RELAY_LIMITS);
    should(advertiseHostedRelay(initial)).deepEqual({ version: 1, relayUrl: null });
    should(hostedRelayConnection(advertiseHostedRelay(initial))).be.null();
    should(HostedRelayConfigurationSchema.parse(initial)).deepEqual(initial);
  });

  it('should turn a remotely supplied address into the existing relay carrier', () => {
    const configured = configuration();
    const advertisement = advertiseHostedRelay(configured);
    should(advertisement).deepEqual({ version: 1, relayUrl: 'https://relay.example' });
    should(HostedRelayAdvertisementSchema.parse(advertisement)).deepEqual(advertisement);
    should(hostedRelayConnection(advertisement)).deepEqual({
      kind: 'relay',
      relayUrl: 'https://relay.example',
      operator: 'hosted',
    });
  });

  it('should refuse malformed addresses, timestamps and incoherent limits', () => {
    const input = (candidate: HostedRelayLimits) => ({
      version: HOSTED_RELAY_CONFIG_VERSION,
      relayUrl: 'https://relay.example',
      limits: candidate,
    });
    should(() => configureHostedRelay({ ...input(limits()), relayUrl: 'http://relay.example' }, at)).throw();
    should(() => configureHostedRelay(input(limits()), -1)).throw();
    should(
      HostedRelayLimitsSchema.safeParse(
        limits({ maxConcurrentConnectionsPerDaemon: 3, maxConcurrentConnectionsGlobal: 2 }),
      ).success,
    ).be.false();
    should(
      HostedRelayLimitsSchema.safeParse(limits({ maxBytesPerMinutePerDaemon: 20, maxBytesPerMinuteGlobal: 10 }))
        .success,
    ).be.false();
    should(
      HostedRelayLimitsSchema.safeParse(limits({ maxBytesPerDayPerDaemon: 20, maxBytesPerDayGlobal: 10 })).success,
    ).be.false();
    should(
      HostedRelayLimitsSchema.safeParse(limits({ maxBytesPerMinutePerDaemon: 20, maxBytesPerDayPerDaemon: 10 }))
        .success,
    ).be.false();
    should(
      HostedRelayLimitsSchema.safeParse(limits({ maxBytesPerMinuteGlobal: 20, maxBytesPerDayGlobal: 10 })).success,
    ).be.false();
  });

  it('should validate durable metric, reservation and decision documents exactly', () => {
    const global = initialHostedRelayGlobalMetrics(at);
    const daemon = initialHostedRelayDaemonMetrics(daemonId, at);
    should(HostedRelayGlobalMetricsSchema.parse(global)).deepEqual(global);
    should(HostedRelayDaemonMetricsSchema.parse(daemon)).deepEqual(daemon);
    should(HostedRelayReservationSchema.parse({ reservationId: 'abcdefghijklmnop', daemonId, openedAt: at })).match({
      daemonId,
    });
    should(
      HostedRelayReservationSchema.safeParse({ reservationId: '../escape', daemonId, openedAt: at }).success,
    ).be.false();
    should(HostedRelayDecisionSchema.parse({ ok: true })).deepEqual({ ok: true });
    should(
      HostedRelayDecisionSchema.parse({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity, reason: 'full' }),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(
      HostedRelayDecisionSchema.safeParse({ ok: false, code: 200, reason: 'not a close code' }).success,
    ).be.false();
  });
});

describe('hosted relay connection admission', () => {
  it('should fail closed while disabled without allocating a daemon metric row', () => {
    const result = admitHostedRelayConnection(
      initialHostedRelayConfiguration(at),
      initialHostedRelayGlobalMetrics(at),
      null,
      daemonId,
      at + 1,
    );
    should(result.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedDisabled });
    should(result.daemon).be.null();
    should(result.global).match({ requestCount: 1, connectionRefusals: 1, trackedDaemons: 0 });
  });

  it('should key accepted counts and concurrent reservations by daemon', () => {
    const first = admitHostedRelayConnection(
      configuration(),
      initialHostedRelayGlobalMetrics(at),
      null,
      daemonId,
      at + 1,
    );
    should(first.decision).deepEqual({ ok: true });
    should(first.global).match({
      requestCount: 1,
      acceptedConnections: 1,
      concurrentConnections: 1,
      peakConcurrentConnections: 1,
      trackedDaemons: 1,
      firstActivityAt: at + 1,
      lastActivityAt: at + 1,
    });
    should(first.daemon).match({ daemonId, acceptedConnections: 1, concurrentConnections: 1 });
    if (first.daemon === null) throw new Error('daemon metric row was not created');

    const second = admitHostedRelayConnection(configuration(), first.global, first.daemon, daemonId, at + 2);
    should(second.decision).deepEqual({ ok: true });
    should(second.global).match({ concurrentConnections: 2, peakConcurrentConnections: 2, trackedDaemons: 1 });
    should(second.daemon).match({ concurrentConnections: 2, peakConcurrentConnections: 2 });
  });

  it('should refuse per-daemon, global and tracked-daemon ceilings clearly', () => {
    const base = admitted();
    const perDaemon = admitHostedRelayConnection(
      configuration({ maxConcurrentConnectionsPerDaemon: 1 }),
      base.global,
      base.daemon,
      daemonId,
      at + 2,
    );
    should(perDaemon.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(perDaemon.daemon).match({ connectionRefusals: 1 });

    const global = admitHostedRelayConnection(
      configuration({ maxConcurrentConnectionsPerDaemon: 2, maxConcurrentConnectionsGlobal: 2 }),
      { ...base.global, concurrentConnections: 2, peakConcurrentConnections: 2 },
      base.daemon,
      daemonId,
      at + 2,
    );
    should(global.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });

    const tracked = admitHostedRelayConnection(
      configuration({ maxTrackedDaemons: 1 }),
      base.global,
      null,
      otherDaemonId,
      at + 2,
    );
    should(tracked.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(tracked.daemon).be.null();
  });

  it('should refuse cross-daemon or backwards-clock evidence rather than reuse it', () => {
    const base = admitted();
    const crossed = admitHostedRelayConnection(configuration(), base.global, base.daemon, otherDaemonId, at + 2);
    should(crossed.decision).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });

    const globalBackwards = admitHostedRelayConnection(
      configuration(),
      { ...base.global, lastActivityAt: at + 10 },
      base.daemon,
      daemonId,
      at + 2,
    );
    should(globalBackwards.decision).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });

    const daemonBackwards = admitHostedRelayConnection(
      configuration(),
      { ...base.global, lastActivityAt: at + 1 },
      { ...base.daemon, lastActivityAt: at + 10 },
      daemonId,
      at + 2,
    );
    should(daemonBackwards.decision).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });
  });
});

describe('hosted relay byte and request metering', () => {
  it('should count protocol work separately from opaque bytes actually forwarded', () => {
    const base = admitted();
    const control = meterHostedRelayRequest(configuration(), base.global, base.daemon, 0, at + 2);
    should(control.decision).deepEqual({ ok: true });
    should(control.global).match({ requestCount: 2, bytesRelayed: 0 });
    if (control.daemon === null) throw new Error('daemon metrics disappeared');

    const data = meterHostedRelayRequest(configuration(), control.global, control.daemon, 4_096, at + 3);
    should(data.decision).deepEqual({ ok: true });
    should(data.global).match({ requestCount: 3, bytesRelayed: 4_096 });
    should(data.daemon).match({ bytesRelayed: 4_096 });
  });

  it('should refuse invalid counts, disabled service and missing reservations', () => {
    const base = admitted();
    for (const bytes of [-1, 0.5, MAX_FRAME_BYTES + 1]) {
      should(meterHostedRelayRequest(configuration(), base.global, base.daemon, bytes, at + 2).decision).match({
        ok: false,
        code: RELAY_CLOSE_CODES.relayInternal,
      });
    }
    should(
      meterHostedRelayRequest(initialHostedRelayConfiguration(at), base.global, base.daemon, 1, at + 2).decision,
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedDisabled });
    should(
      meterHostedRelayRequest(configuration(), { ...base.global, concurrentConnections: 0 }, base.daemon, 1, at + 2)
        .decision,
    ).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });
  });

  it('should fail closed on backwards clocks in activity or usage windows', () => {
    const base = admitted();
    should(
      meterHostedRelayRequest(configuration(), { ...base.global, lastActivityAt: at + 10 }, base.daemon, 1, at + 2)
        .decision,
    ).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });
    should(
      meterHostedRelayRequest(
        configuration(),
        { ...base.global, minute: { startedAt: at + HOSTED_RELAY_MINUTE_MILLISECONDS, bytes: 0 } },
        { ...base.daemon, minute: { startedAt: at + HOSTED_RELAY_MINUTE_MILLISECONDS, bytes: 0 } },
        1,
        at + 2,
      ).decision,
    ).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });
  });

  it('should enforce every per-daemon and global minute and daily ceiling with a reset time', () => {
    const base = admitted();
    const cap = 100;
    const config = configuration({
      maxBytesPerMinutePerDaemon: cap,
      maxBytesPerMinuteGlobal: cap * 2,
      maxBytesPerDayPerDaemon: cap * 3,
      maxBytesPerDayGlobal: cap * 4,
    });
    const cases: readonly [HostedRelayGlobalMetrics, HostedRelayDaemonMetrics][] = [
      [base.global, { ...base.daemon, minute: { ...base.daemon.minute, bytes: cap - 1 } }],
      [{ ...base.global, minute: { ...base.global.minute, bytes: cap * 2 - 1 } }, base.daemon],
      [base.global, { ...base.daemon, day: { ...base.daemon.day, bytes: cap * 3 - 1 } }],
      [{ ...base.global, day: { ...base.global.day, bytes: cap * 4 - 1 } }, base.daemon],
    ];
    for (const [global, daemon] of cases) {
      const result = meterHostedRelayRequest(config, global, daemon, 2, at + 2);
      should(result.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth });
      if (result.decision.ok) throw new Error('bandwidth ceiling did not refuse');
      should(result.decision.retryAt).be.above(at);
      should(result.global.bandwidthRefusals).equal(1);
      should(result.daemon?.bandwidthRefusals).equal(1);
    }
  });

  it('should reset elapsed windows without erasing cumulative byte counts', () => {
    const base = admitted();
    const filled = meterHostedRelayRequest(configuration(), base.global, base.daemon, 100, at + 2);
    if (!filled.decision.ok || filled.daemon === null) throw new Error('initial bytes were refused');
    const nextMinute = filled.global.minute.startedAt + HOSTED_RELAY_MINUTE_MILLISECONDS;
    const rolled = meterHostedRelayRequest(configuration(), filled.global, filled.daemon, 50, nextMinute);
    should(rolled.decision).deepEqual({ ok: true });
    should(rolled.global).match({ bytesRelayed: 150, minute: { startedAt: nextMinute, bytes: 50 } });
  });
});

describe('hosted relay live reservation checks', () => {
  it('should release a reservation exactly once and refuse damaged evidence', () => {
    const base = admitted();
    const released = releaseHostedRelayConnection(base.global, base.daemon, at + 2);
    should(released.decision).deepEqual({ ok: true });
    should(released.global.concurrentConnections).equal(0);
    should(released.daemon?.concurrentConnections).equal(0);

    should(releaseHostedRelayConnection(released.global, released.daemon ?? base.daemon, at + 3).decision).match({
      ok: false,
      code: RELAY_CLOSE_CODES.relayInternal,
    });
    should(releaseHostedRelayConnection(base.global, base.daemon, at).decision).match({
      ok: false,
      code: RELAY_CLOSE_CODES.relayInternal,
    });
  });

  it('should close live reservations when the switch, evidence or connection caps no longer allow them', () => {
    const base = admitted();
    should(inspectHostedRelayCapacity(initialHostedRelayConfiguration(at), base.global, base.daemon, at + 2)).match({
      ok: false,
      code: RELAY_CLOSE_CODES.hostedDisabled,
    });
    should(inspectHostedRelayCapacity(configuration(), base.global, null, at + 2)).match({
      ok: false,
      code: RELAY_CLOSE_CODES.relayInternal,
    });
    should(
      inspectHostedRelayCapacity(
        configuration({ maxConcurrentConnectionsPerDaemon: 1 }),
        { ...base.global, concurrentConnections: 2 },
        { ...base.daemon, concurrentConnections: 2 },
        at + 2,
      ),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    should(
      inspectHostedRelayCapacity(
        configuration({ maxConcurrentConnectionsPerDaemon: 1, maxConcurrentConnectionsGlobal: 1 }),
        { ...base.global, concurrentConnections: 2 },
        base.daemon,
        at + 2,
      ),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
  });

  it('should inspect each byte window, expire old windows, and reject backwards evidence', () => {
    const base = admitted();
    const cap = 100;
    const config = configuration({
      maxBytesPerMinutePerDaemon: cap,
      maxBytesPerMinuteGlobal: cap * 2,
      maxBytesPerDayPerDaemon: cap * 3,
      maxBytesPerDayGlobal: cap * 4,
    });
    const cases: readonly [HostedRelayGlobalMetrics, HostedRelayDaemonMetrics][] = [
      [base.global, { ...base.daemon, minute: { ...base.daemon.minute, bytes: cap } }],
      [{ ...base.global, minute: { ...base.global.minute, bytes: cap * 2 } }, base.daemon],
      [base.global, { ...base.daemon, day: { ...base.daemon.day, bytes: cap * 3 } }],
      [{ ...base.global, day: { ...base.global.day, bytes: cap * 4 } }, base.daemon],
    ];
    for (const [global, daemon] of cases) {
      should(inspectHostedRelayCapacity(config, global, daemon, at + 2)).match({
        ok: false,
        code: RELAY_CLOSE_CODES.hostedBandwidth,
      });
    }

    should(
      inspectHostedRelayCapacity(
        config,
        { ...base.global, minute: { startedAt: at + HOSTED_RELAY_MINUTE_MILLISECONDS, bytes: 0 } },
        base.daemon,
        at + 2,
      ),
    ).match({ ok: false, code: RELAY_CLOSE_CODES.relayInternal });

    const nextMinute = base.global.minute.startedAt + HOSTED_RELAY_MINUTE_MILLISECONDS;
    should(
      inspectHostedRelayCapacity(
        config,
        { ...base.global, minute: { ...base.global.minute, bytes: cap * 2 } },
        { ...base.daemon, minute: { ...base.daemon.minute, bytes: cap } },
        nextMinute,
      ),
    ).deepEqual({ ok: true });
    should(inspectHostedRelayCapacity(config, base.global, base.daemon, at + 2)).deepEqual({ ok: true });
  });
});
