import { describe, it } from 'bun:test';
import {
  admitHostedRelayConnection,
  advertiseHostedRelay,
  auditHostedRelayReservations,
  configureHostedRelay,
  DEFAULT_HOSTED_RELAY_LIMITS,
  forgetHostedRelayDaemons,
  HOSTED_RELAY_CONFIG_VERSION,
  HOSTED_RELAY_BANDWIDTH_REASONS,
  HOSTED_RELAY_DAEMON_CEILING_REASON,
  HOSTED_RELAY_DAY_MILLISECONDS,
  HOSTED_RELAY_MINUTE_MILLISECONDS,
  HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS,
  HOSTED_RELAY_RESERVATION_LEASE_MILLISECONDS,
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
  type HostedRelayReservation,
  HostedRelayReservationSchema,
  hostedBandwidthReason,
  hostedRelayConnection,
  hostedRelayDayStart,
  initialHostedRelayConfiguration,
  initialHostedRelayDaemonMetrics,
  initialHostedRelayGlobalMetrics,
  inspectHostedRelayCapacity,
  MAX_FRAME_BYTES,
  meterHostedRelayRequest,
  parseHostedBandwidthRefusal,
  RELAY_CLOSE_CODES,
  readHostedBandwidthRefusal,
  reclaimableHostedRelayDaemon,
  recountHostedRelayConnections,
  releaseHostedRelayConnection,
  SUPERSEDED_HOSTED_RELAY_LIMITS,
  upgradeHostedRelayConfiguration,
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

  it("should size the default byte ceilings for a working day of one person's machines", () => {
    const gibibyte = 1024 * 1024 * 1024;
    should(DEFAULT_HOSTED_RELAY_LIMITS).match({
      maxBytesPerMinutePerDaemon: gibibyte / 2,
      maxBytesPerMinuteGlobal: 4 * gibibyte,
      maxBytesPerDayPerDaemon: 20 * gibibyte,
      maxBytesPerDayGlobal: 200 * gibibyte,
    });
    should(HostedRelayLimitsSchema.parse(DEFAULT_HOSTED_RELAY_LIMITS)).deepEqual(DEFAULT_HOSTED_RELAY_LIMITS);
    for (const superseded of SUPERSEDED_HOSTED_RELAY_LIMITS) {
      should(HostedRelayLimitsSchema.parse(superseded)).deepEqual(superseded);
      should(superseded).not.deepEqual(DEFAULT_HOSTED_RELAY_LIMITS);
    }
  });

  it('should read a stored superseded default set as the current defaults and keep everything else', () => {
    const [firstDeployment] = SUPERSEDED_HOSTED_RELAY_LIMITS;
    if (firstDeployment === undefined) throw new Error('no superseded default set');
    should(firstDeployment.maxBytesPerDayPerDaemon).equal(1024 * 1024 * 1024);
    const stored = configureHostedRelay(
      { version: HOSTED_RELAY_CONFIG_VERSION, relayUrl: 'https://relay.example/', limits: firstDeployment },
      at,
    );
    const upgraded = upgradeHostedRelayConfiguration(stored);
    should(upgraded).deepEqual({ ...stored, limits: DEFAULT_HOSTED_RELAY_LIMITS });
    should(upgradeHostedRelayConfiguration(upgraded)).equal(upgraded);
    should(HostedRelayConfigurationSchema.parse(upgraded)).deepEqual(upgraded);

    // One field the operator chose is the operator's decision for the whole document.
    const customised = configureHostedRelay(
      {
        version: HOSTED_RELAY_CONFIG_VERSION,
        relayUrl: null,
        limits: { ...firstDeployment, maxTrackedDaemons: firstDeployment.maxTrackedDaemons - 1 },
      },
      at,
    );
    should(upgradeHostedRelayConfiguration(customised)).equal(customised);
    const current = configuration();
    should(upgradeHostedRelayConfiguration(current)).equal(current);
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
    should(result.global).match({
      requestCount: 1,
      connectionRefusals: 1,
      disabledRefusals: 1,
      bandwidthRefusals: 0,
      trackedDaemons: 0,
    });
  });

  it('should keep the tracked-daemon census equal to the rows it would store', () => {
    const base = admitted();
    const atCapacity = admitHostedRelayConnection(
      configuration({ maxConcurrentConnectionsPerDaemon: 2, maxConcurrentConnectionsGlobal: 2 }),
      { ...base.global, concurrentConnections: 2, peakConcurrentConnections: 2 },
      null,
      otherDaemonId,
      at + 2,
    );
    should(atCapacity.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedCapacity });
    // A row nobody counted is a row the operator snapshot can never reconcile again.
    should(atCapacity.daemon).be.null();
    should(atCapacity.global).match({ trackedDaemons: base.global.trackedDaemons, connectionRefusals: 1 });

    // A daemon that already has a row still gets its own refusal counted on that row.
    const known = admitHostedRelayConnection(
      configuration({ maxConcurrentConnectionsPerDaemon: 1 }),
      base.global,
      base.daemon,
      daemonId,
      at + 2,
    );
    should(known.daemon).match({ daemonId, connectionRefusals: 1 });
    should(known.global).match({ trackedDaemons: 1 });
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

  it('should count a reported batch as its events and bytes, and refuse a nonsensical batch', () => {
    // A rendezvous reports everything it forwarded while its previous report was in flight.
    const base = admitted();
    const batch = meterHostedRelayRequest(configuration(), base.global, base.daemon, 3 * 4_096, at + 2, 3);
    should(batch.decision).deepEqual({ ok: true });
    should(batch.global).match({ requestCount: base.global.requestCount + 3, bytesRelayed: 3 * 4_096 });
    for (const [bytes, events] of [
      [1, 0],
      [1, 1.5],
      [2 * MAX_FRAME_BYTES + 1, 2],
    ] as const) {
      should(meterHostedRelayRequest(configuration(), base.global, base.daemon, bytes, at + 2, events).decision).match({
        ok: false,
        code: RELAY_CLOSE_CODES.relayInternal,
      });
    }
  });

  it('should count bytes that already crossed a ceiling, then refuse what follows', () => {
    // The report trails the traffic, so the bytes it names were relayed: the bill keeps them.
    const base = admitted();
    const capped = meterHostedRelayRequest(
      configuration({ maxBytesPerMinutePerDaemon: 100 }),
      base.global,
      { ...base.daemon, minute: { ...base.daemon.minute, bytes: 90 } },
      20,
      at + 2,
      2,
    );
    should(capped.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth });
    should(capped.daemon).match({ bytesRelayed: base.daemon.bytesRelayed + 20, minute: { bytes: 110 } });
    should(capped.global).match({ bytesRelayed: base.global.bytesRelayed + 20 });
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

describe('hosted relay refusal counter semantics', () => {
  it('should count a switched-off frame as an intentional stop rather than an exhausted budget', () => {
    const base = admitted();
    const stopped = meterHostedRelayRequest(
      initialHostedRelayConfiguration(at),
      base.global,
      base.daemon,
      4_096,
      at + 2,
    );
    should(stopped.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedDisabled });
    should(stopped.global).match({
      disabledRefusals: 1,
      bandwidthRefusals: 0,
      // The frame event is still accounted for; only its label changed.
      requestCount: base.global.requestCount + 1,
      bytesRelayed: base.global.bytesRelayed,
    });
    should(stopped.daemon).match({ disabledRefusals: 1, bandwidthRefusals: 0 });
  });

  it('should count a switched-off connection against a daemon row that already exists', () => {
    const base = admitted();
    const refused = admitHostedRelayConnection(
      initialHostedRelayConfiguration(at),
      base.global,
      base.daemon,
      daemonId,
      at + 2,
    );
    should(refused.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedDisabled });
    should(refused.global).match({ disabledRefusals: 1, connectionRefusals: 1, bandwidthRefusals: 0 });
    should(refused.daemon).match({ daemonId, disabledRefusals: 1, connectionRefusals: 1, bandwidthRefusals: 0 });
  });

  it('should keep a real byte ceiling on the bandwidth counter alone', () => {
    const base = admitted();
    const capped = meterHostedRelayRequest(
      configuration({ maxBytesPerMinutePerDaemon: 1, maxBytesPerMinuteGlobal: 1, maxBytesPerDayPerDaemon: 1 }),
      base.global,
      base.daemon,
      4_096,
      at + 2,
    );
    should(capped.decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth });
    should(capped.global).match({ bandwidthRefusals: 1, disabledRefusals: 0 });
    should(capped.daemon).match({ bandwidthRefusals: 1, disabledRefusals: 0 });
  });
});

describe('hosted relay daemon row reclamation', () => {
  const today = HOSTED_RELAY_DAY_MILLISECONDS * 2;
  const yesterday = HOSTED_RELAY_DAY_MILLISECONDS;

  function row(overrides: Partial<HostedRelayDaemonMetrics> = {}): HostedRelayDaemonMetrics {
    return { ...initialHostedRelayDaemonMetrics(daemonId, yesterday), lastActivityAt: yesterday, ...overrides };
  }

  it('should name a UTC day by its first millisecond', () => {
    should(hostedRelayDayStart(today)).equal(today);
    should(hostedRelayDayStart(today + HOSTED_RELAY_DAY_MILLISECONDS - 1)).equal(today);
    should(hostedRelayDayStart(today + HOSTED_RELAY_DAY_MILLISECONDS)).equal(today + HOSTED_RELAY_DAY_MILLISECONDS);
    should(hostedRelayDayStart(0)).equal(0);
    should(() => hostedRelayDayStart(-1)).throw();
  });

  it('should forget only a validated row that is idle and finished with its accounting day', () => {
    should(reclaimableHostedRelayDaemon(row(), at)).be.true();
  });

  it('should never forget a row that is live or still inside the current day', () => {
    should(reclaimableHostedRelayDaemon(row({ concurrentConnections: 1 }), at)).be.false();
    should(reclaimableHostedRelayDaemon(row({ day: { startedAt: today, bytes: 0 } }), at)).be.false();
    // A refusal stamps activity without rolling the window, so the stamp is checked on its own.
    should(reclaimableHostedRelayDaemon(row({ lastActivityAt: at }), at)).be.false();
  });

  it('should keep a row whose activity stamp is missing rather than guess it is idle', () => {
    // Admission and metering both stamp a row before it is ever stored, so an unstamped stored row
    // is evidence nobody can explain. Fail-closed means keeping it, not tidying it away.
    should(reclaimableHostedRelayDaemon(row({ lastActivityAt: null }), at)).be.false();
  });

  it('should shrink the census by exactly what was deleted and leave cumulative totals alone', () => {
    const global = { ...initialHostedRelayGlobalMetrics(at), trackedDaemons: 3, requestCount: 99, bytesRelayed: 4_096 };
    const forgotten = forgetHostedRelayDaemons(global, 2);
    should(forgotten).match({ trackedDaemons: 1, requestCount: 99, bytesRelayed: 4_096 });
    should(forgetHostedRelayDaemons(global, 0)).deepEqual(global);
  });

  it('should refuse to shrink the census below the rows it claims to have', () => {
    const global = { ...initialHostedRelayGlobalMetrics(at), trackedDaemons: 1 };
    should(forgetHostedRelayDaemons(global, 2)).be.null();
    should(forgetHostedRelayDaemons(global, -1)).be.null();
    should(forgetHostedRelayDaemons(global, 1.5)).be.null();
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
    const expected = [
      ['daemon', 'minute'],
      ['global', 'minute'],
      ['daemon', 'day'],
      ['global', 'day'],
    ] as const;
    for (const [index, [global, daemon]] of cases.entries()) {
      const decision = inspectHostedRelayCapacity(config, global, daemon, at + 2);
      should(decision).match({ ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth });
      if (decision.ok) throw new Error('expected a refusal');
      // The reason names the window and carries the reset the decision computed.
      const [scope, window] = expected[index] ?? ['daemon', 'minute'];
      should(readHostedBandwidthRefusal(decision.reason)).deepEqual({ scope, window, resetsAt: decision.retryAt });
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

describe('hosted relay reservation audit', () => {
  const reservation = (reservationId: string, owner: string, openedAt: number, confirmedAt?: number) =>
    HostedRelayReservationSchema.parse({
      reservationId,
      daemonId: owner,
      openedAt,
      ...(confirmedAt === undefined ? {} : { confirmedAt }),
    }) as HostedRelayReservation;
  const old = at - HOSTED_RELAY_RESERVATION_LEASE_MILLISECONDS;
  const young = at - HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS + 1;

  it('should reclaim every reservation whose lease nobody renewed, the 2026-10-19 lockout', () => {
    const stuck = Array.from({ length: 16 }, (_, index) => reservation(`stuck_reservation_${index}`, daemonId, old));
    const audit = auditHostedRelayReservations(stuck, null, at);
    should(audit.reclaimed).have.length(16);
    should(audit.heldGlobal).equal(0);
    should(audit.heldByDaemon.get(daemonId)).equal(0);
    should(audit.renewed).deepEqual([]);
  });

  it('should keep a reservation inside its lease when no rendezvous gave evidence', () => {
    const renewedRecently = reservation('renewed_reservation_', daemonId, old, at - 1);
    const fresh = reservation('fresh_reservation_01', otherDaemonId, at - 1);
    const audit = auditHostedRelayReservations([renewedRecently, fresh], null, at);
    should(audit.reclaimed).deepEqual([]);
    should(audit.heldGlobal).equal(2);
    should([...audit.heldByDaemon]).deepEqual([
      [daemonId, 1],
      [otherDaemonId, 1],
    ]);
  });

  it('should trust the rendezvous for its own daemon and the lease for everyone else', () => {
    const audit = auditHostedRelayReservations(
      [
        reservation('live_reservation_001', daemonId, old),
        reservation('lost_reservation_001', daemonId, at - HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS),
        reservation('handoff_reservation1', daemonId, young),
        reservation('other_live_reserv01', otherDaemonId, old, at - 1),
        reservation('other_stale_reserv1', otherDaemonId, old),
      ],
      { daemonId, live: new Set(['live_reservation_001', 'other_live_reserv01']) },
      at,
    );
    // The lost one is past the handoff grace and no socket carries it; the handoff one is still
    // travelling from the Worker; another daemon's row is judged only on its own lease.
    should(audit.reclaimed).deepEqual(['lost_reservation_001', 'other_stale_reserv1']);
    should(audit.renewed.map(row => [row.reservationId, row.confirmedAt])).deepEqual([['live_reservation_001', at]]);
    should(audit.heldGlobal).equal(3);
    should(audit.heldByDaemon.get(daemonId)).equal(2);
    should(audit.heldByDaemon.get(otherDaemonId)).equal(1);
  });

  it('should name a daemon with no rows at all as holding none, and never reclaim on a clock that stepped back', () => {
    const empty = auditHostedRelayReservations([], { daemonId, live: new Set() }, at);
    should(empty.heldByDaemon.get(daemonId)).equal(0);
    const future = reservation('future_reservation01', otherDaemonId, at + 5_000, at + 5_000);
    const audit = auditHostedRelayReservations(
      [future],
      { daemonId: otherDaemonId, live: new Set([future.reservationId]) },
      at,
    );
    should(audit.reclaimed).deepEqual([]);
    should(audit.renewed[0]?.confirmedAt).equal(at + 5_000);
  });

  it('should recount a counter without touching history, and leave an exact one identical', () => {
    const base = admitted();
    should(recountHostedRelayConnections(base.daemon, 1)).equal(base.daemon);
    const healed = recountHostedRelayConnections({ ...base.daemon, concurrentConnections: 16 }, 0);
    should(healed).match({ concurrentConnections: 0, peakConcurrentConnections: 1, acceptedConnections: 1 });
  });

  it('should refuse a full daemon with the reason callers recognise', () => {
    const full = admitted(configuration({ maxConcurrentConnectionsPerDaemon: 1 }));
    const refused = admitHostedRelayConnection(
      configuration({ maxConcurrentConnectionsPerDaemon: 1 }),
      full.global,
      full.daemon,
      daemonId,
      at + 2,
    );
    should(refused.decision).match({ ok: false, reason: HOSTED_RELAY_DAEMON_CEILING_REASON });
  });
});

describe('hosted relay byte-ceiling refusal reasons', () => {
  const sentence = HOSTED_RELAY_BANDWIDTH_REASONS.daemon.day;
  const midnight = HOSTED_RELAY_DAY_MILLISECONDS * 3;

  it('should carry the reset inside a close reason a WebSocket can send', () => {
    for (const scope of ['daemon', 'global'] as const) {
      for (const window of ['minute', 'day'] as const) {
        const reason = hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS[scope][window], midnight);
        should(new TextEncoder().encode(reason).length).be.belowOrEqual(123);
        should(readHostedBandwidthRefusal(reason)).deepEqual({ scope, window, resetsAt: midnight });
        should(parseHostedBandwidthRefusal(reason, midnight - 1)).deepEqual({ scope, window, resetsAt: midnight });
      }
    }
  });

  it('should derive the reset an older relay did not say, and distrust one that is unreadable or past', () => {
    const now = midnight - 5_000;
    should(readHostedBandwidthRefusal(sentence)).deepEqual({ scope: 'daemon', window: 'day', resetsAt: null });
    should(parseHostedBandwidthRefusal(sentence, now)).deepEqual({
      scope: 'daemon',
      window: 'day',
      resetsAt: midnight,
    });
    should(parseHostedBandwidthRefusal(`${sentence}; resets yesterday`, now)).match({ resetsAt: midnight });
    should(parseHostedBandwidthRefusal(hostedBandwidthReason(sentence, now - 1), now)).match({ resetsAt: midnight });
    should(parseHostedBandwidthRefusal(HOSTED_RELAY_BANDWIDTH_REASONS.global.minute, now)).deepEqual({
      scope: 'global',
      window: 'minute',
      resetsAt: now + HOSTED_RELAY_MINUTE_MILLISECONDS,
    });
  });

  it('should not read any other refusal as a byte ceiling', () => {
    should(readHostedBandwidthRefusal(HOSTED_RELAY_DAEMON_CEILING_REASON)).be.null();
    should(parseHostedBandwidthRefusal('hosted relay is disabled', midnight)).be.null();
  });
});
