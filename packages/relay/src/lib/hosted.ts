/**
 * The hosted relay's control plane, without Cloudflare attached.
 *
 * A hosted deployment is deliberately a different operating mode from a relay somebody runs for
 * themselves. The wire protocol and ciphertext are identical; what changes is who pays, so this
 * module owns only the things that bound that bill: a runtime kill switch, exact request/byte
 * counters, and per-daemon plus account-wide ceilings.
 *
 * Nothing here receives a frame payload. Metering is told only the encoded byte length and the
 * daemon fingerprint that already addresses the Durable Object. Keeping that interface narrow is
 * what makes "the relay cannot read content" a structural property rather than a logging promise.
 */

import { DaemonIdSchema } from '@ferretry/protocol';
import { z } from 'zod';
import { type ConnectionMethod, SocketEndpointSchema } from './connection.ts';
import { MAX_FRAME_BYTES, RELAY_CLOSE_CODES, type RelayCloseCode } from './constants.ts';

export const HOSTED_RELAY_CONFIG_VERSION = 1 as const;
export const HOSTED_RELAY_MINUTE_MILLISECONDS = 60_000 as const;
export const HOSTED_RELAY_DAY_MILLISECONDS = 86_400_000 as const;

const SafeCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveLimitSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = SafeCountSchema;

/** Runtime limits. They are data in the control Durable Object, never build-time constants. */
export const HostedRelayLimitsSchema = z
  .strictObject({
    maxConcurrentConnectionsPerDaemon: PositiveLimitSchema.max(64),
    maxConcurrentConnectionsGlobal: PositiveLimitSchema.max(16_384),
    maxBytesPerMinutePerDaemon: PositiveLimitSchema,
    maxBytesPerMinuteGlobal: PositiveLimitSchema,
    maxBytesPerDayPerDaemon: PositiveLimitSchema,
    maxBytesPerDayGlobal: PositiveLimitSchema,
    /** Bounds durable per-daemon metric rows even if fingerprints are sprayed at the service. */
    maxTrackedDaemons: PositiveLimitSchema.max(100_000),
  })
  .superRefine((limits, context) => {
    if (limits.maxConcurrentConnectionsGlobal < limits.maxConcurrentConnectionsPerDaemon) {
      context.addIssue({ code: 'custom', message: 'global connection limit is below the per-daemon limit' });
    }
    if (limits.maxBytesPerMinuteGlobal < limits.maxBytesPerMinutePerDaemon) {
      context.addIssue({ code: 'custom', message: 'global minute-byte limit is below the per-daemon limit' });
    }
    if (limits.maxBytesPerDayGlobal < limits.maxBytesPerDayPerDaemon) {
      context.addIssue({ code: 'custom', message: 'global day-byte limit is below the per-daemon limit' });
    }
    if (limits.maxBytesPerDayPerDaemon < limits.maxBytesPerMinutePerDaemon) {
      context.addIssue({ code: 'custom', message: 'per-daemon day-byte limit is below its minute limit' });
    }
    if (limits.maxBytesPerDayGlobal < limits.maxBytesPerMinuteGlobal) {
      context.addIssue({ code: 'custom', message: 'global day-byte limit is below its minute limit' });
    }
  });
export type HostedRelayLimits = z.infer<typeof HostedRelayLimitsSchema>;

/**
 * Conservative first-deployment limits, intentionally mutable through the operator endpoint.
 * They are defaults for a new control object, not a baked-in relay address or an immutable policy.
 */
export const DEFAULT_HOSTED_RELAY_LIMITS: HostedRelayLimits = {
  maxConcurrentConnectionsPerDaemon: 16,
  maxConcurrentConnectionsGlobal: 512,
  maxBytesPerMinutePerDaemon: 64 * 1024 * 1024,
  maxBytesPerMinuteGlobal: 1024 * 1024 * 1024,
  maxBytesPerDayPerDaemon: 1024 * 1024 * 1024,
  maxBytesPerDayGlobal: 16 * 1024 * 1024 * 1024,
  maxTrackedDaemons: 10_000,
};

export const HostedRelayConfigurationInputSchema = z.strictObject({
  version: z.literal(HOSTED_RELAY_CONFIG_VERSION),
  /** `null` is the kill switch. No address means the hosted relay serves no new or live traffic. */
  relayUrl: SocketEndpointSchema.nullable(),
  limits: HostedRelayLimitsSchema,
});
export type HostedRelayConfigurationInput = z.infer<typeof HostedRelayConfigurationInputSchema>;

export const HostedRelayConfigurationSchema = HostedRelayConfigurationInputSchema.extend({
  updatedAt: TimestampSchema,
});
export type HostedRelayConfiguration = z.infer<typeof HostedRelayConfigurationSchema>;

export const HostedRelayAdvertisementSchema = z.strictObject({
  version: z.literal(HOSTED_RELAY_CONFIG_VERSION),
  relayUrl: SocketEndpointSchema.nullable(),
});
export type HostedRelayAdvertisement = z.infer<typeof HostedRelayAdvertisementSchema>;

export function initialHostedRelayConfiguration(at: number): HostedRelayConfiguration {
  return {
    version: HOSTED_RELAY_CONFIG_VERSION,
    relayUrl: null,
    limits: DEFAULT_HOSTED_RELAY_LIMITS,
    updatedAt: at,
  };
}

export function configureHostedRelay(input: HostedRelayConfigurationInput, at: number): HostedRelayConfiguration {
  return { ...HostedRelayConfigurationInputSchema.parse(input), updatedAt: TimestampSchema.parse(at) };
}

/** The small public document a browser reads. It contains configuration, never a compiled URL. */
export function advertiseHostedRelay(configuration: HostedRelayConfiguration): HostedRelayAdvertisement {
  return { version: HOSTED_RELAY_CONFIG_VERSION, relayUrl: configuration.relayUrl };
}

/** Convert an enabled advertisement into the existing relay carrier; BYO uses the same wire path. */
export function hostedRelayConnection(advertisement: HostedRelayAdvertisement): ConnectionMethod | null {
  return advertisement.relayUrl === null
    ? null
    : { kind: 'relay', relayUrl: advertisement.relayUrl, operator: 'hosted' };
}

export const HostedRelayUsageWindowSchema = z.strictObject({
  startedAt: TimestampSchema,
  bytes: SafeCountSchema,
});
export type HostedRelayUsageWindow = z.infer<typeof HostedRelayUsageWindowSchema>;

const HostedRelayUsageShape = {
  requestCount: SafeCountSchema,
  acceptedConnections: SafeCountSchema,
  connectionRefusals: SafeCountSchema,
  bytesRelayed: SafeCountSchema,
  bandwidthRefusals: SafeCountSchema,
  concurrentConnections: SafeCountSchema,
  peakConcurrentConnections: SafeCountSchema,
  firstActivityAt: TimestampSchema.nullable(),
  lastActivityAt: TimestampSchema.nullable(),
  minute: HostedRelayUsageWindowSchema,
  day: HostedRelayUsageWindowSchema,
} as const;

export const HostedRelayGlobalMetricsSchema = z.strictObject({
  ...HostedRelayUsageShape,
  trackedDaemons: SafeCountSchema,
});
export type HostedRelayGlobalMetrics = z.infer<typeof HostedRelayGlobalMetricsSchema>;

export const HostedRelayDaemonMetricsSchema = z.strictObject({
  ...HostedRelayUsageShape,
  daemonId: DaemonIdSchema,
});
export type HostedRelayDaemonMetrics = z.infer<typeof HostedRelayDaemonMetricsSchema>;

export const HostedRelayReservationSchema = z.strictObject({
  reservationId: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/u),
  daemonId: DaemonIdSchema,
  openedAt: TimestampSchema,
});
export type HostedRelayReservation = z.infer<typeof HostedRelayReservationSchema>;

const RelayCloseCodeSchema = z
  .number()
  .int()
  .min(4000)
  .max(4999)
  .transform(value => value as RelayCloseCode);
export const HostedRelayDecisionSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    code: RelayCloseCodeSchema,
    reason: z.string().min(1).max(200),
    retryAt: TimestampSchema.optional(),
  }),
]);
export type HostedRelayDecision = z.infer<typeof HostedRelayDecisionSchema>;

export interface HostedRelayMetricsTransition {
  readonly global: HostedRelayGlobalMetrics;
  readonly daemon: HostedRelayDaemonMetrics | null;
  readonly decision: HostedRelayDecision;
}

export function initialHostedRelayGlobalMetrics(at: number): HostedRelayGlobalMetrics {
  return { ...emptyUsage(at), trackedDaemons: 0 };
}

export function initialHostedRelayDaemonMetrics(daemonId: string, at: number): HostedRelayDaemonMetrics {
  return { ...emptyUsage(at), daemonId: DaemonIdSchema.parse(daemonId) };
}

/** Atomically decide whether one more WebSocket may be admitted. */
export function admitHostedRelayConnection(
  configuration: HostedRelayConfiguration,
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics | null,
  daemonId: string,
  at: number,
): HostedRelayMetricsTransition {
  const parsedDaemonId = DaemonIdSchema.parse(daemonId);
  const touchedGlobal = touchRequest(global, at);
  if (touchedGlobal === null) return internalFailure(global, daemon, 'relay meter clock moved backwards');

  if (configuration.relayUrl === null) {
    return refuseConnection(touchedGlobal, daemon, RELAY_CLOSE_CODES.hostedDisabled, 'hosted relay is disabled');
  }
  if (daemon !== null && daemon.daemonId !== parsedDaemonId) {
    return internalFailure(touchedGlobal, daemon, 'daemon metrics belong to another rendezvous');
  }
  if (daemon === null && touchedGlobal.trackedDaemons >= configuration.limits.maxTrackedDaemons) {
    return refuseConnection(
      touchedGlobal,
      null,
      RELAY_CLOSE_CODES.hostedCapacity,
      'hosted relay daemon capacity is reached',
    );
  }

  const baseDaemon = daemon ?? initialHostedRelayDaemonMetrics(parsedDaemonId, at);
  const touchedDaemon = touchRequest(baseDaemon, at);
  if (touchedDaemon === null) return internalFailure(touchedGlobal, baseDaemon, 'relay meter clock moved backwards');
  if (touchedDaemon.concurrentConnections >= configuration.limits.maxConcurrentConnectionsPerDaemon) {
    return refuseConnection(
      touchedGlobal,
      touchedDaemon,
      RELAY_CLOSE_CODES.hostedCapacity,
      'hosted relay per-daemon connection ceiling is reached',
    );
  }
  if (touchedGlobal.concurrentConnections >= configuration.limits.maxConcurrentConnectionsGlobal) {
    return refuseConnection(
      touchedGlobal,
      touchedDaemon,
      RELAY_CLOSE_CODES.hostedCapacity,
      'hosted relay global connection ceiling is reached',
    );
  }

  const nextGlobal = acceptConnection(touchedGlobal, daemon === null ? 1 : 0);
  const nextDaemon = acceptConnection(touchedDaemon, 0);
  return { global: nextGlobal, daemon: nextDaemon, decision: { ok: true } };
}

/**
 * Count one frame event and, when it will actually be forwarded, reserve its opaque encoded bytes.
 * A zero-byte call counts protocol/control work without claiming content was relayed.
 */
export function meterHostedRelayRequest(
  configuration: HostedRelayConfiguration,
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics,
  bytes: number,
  at: number,
): HostedRelayMetricsTransition {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FRAME_BYTES) {
    return internalFailure(global, daemon, 'relay meter received an invalid byte count');
  }
  const touchedGlobal = touchRequest(global, at);
  const touchedDaemon = touchRequest(daemon, at);
  if (touchedGlobal === null || touchedDaemon === null) {
    return internalFailure(global, daemon, 'relay meter clock moved backwards');
  }
  if (configuration.relayUrl === null) {
    return refuseBandwidth(touchedGlobal, touchedDaemon, RELAY_CLOSE_CODES.hostedDisabled, 'hosted relay is disabled');
  }
  if (touchedGlobal.concurrentConnections === 0 || touchedDaemon.concurrentConnections === 0) {
    return internalFailure(touchedGlobal, touchedDaemon, 'relay meter has no connection reservation');
  }
  if (bytes === 0) return { global: touchedGlobal, daemon: touchedDaemon, decision: { ok: true } };

  const rolledGlobal = rollUsage(touchedGlobal, at);
  const rolledDaemon = rollUsage(touchedDaemon, at);
  if (rolledGlobal === null || rolledDaemon === null) {
    return internalFailure(touchedGlobal, touchedDaemon, 'relay meter clock moved backwards');
  }

  const checks: readonly [number, number, string, number][] = [
    [
      rolledDaemon.minute.bytes,
      configuration.limits.maxBytesPerMinutePerDaemon,
      'hosted relay per-daemon minute bandwidth ceiling is reached',
      rolledDaemon.minute.startedAt + HOSTED_RELAY_MINUTE_MILLISECONDS,
    ],
    [
      rolledGlobal.minute.bytes,
      configuration.limits.maxBytesPerMinuteGlobal,
      'hosted relay global minute bandwidth ceiling is reached',
      rolledGlobal.minute.startedAt + HOSTED_RELAY_MINUTE_MILLISECONDS,
    ],
    [
      rolledDaemon.day.bytes,
      configuration.limits.maxBytesPerDayPerDaemon,
      'hosted relay per-daemon daily bandwidth ceiling is reached',
      rolledDaemon.day.startedAt + HOSTED_RELAY_DAY_MILLISECONDS,
    ],
    [
      rolledGlobal.day.bytes,
      configuration.limits.maxBytesPerDayGlobal,
      'hosted relay global daily bandwidth ceiling is reached',
      rolledGlobal.day.startedAt + HOSTED_RELAY_DAY_MILLISECONDS,
    ],
  ];
  for (const [used, limit, reason, retryAt] of checks) {
    if (bytes > limit - used) {
      return refuseBandwidth(rolledGlobal, rolledDaemon, RELAY_CLOSE_CODES.hostedBandwidth, reason, retryAt);
    }
  }

  return {
    global: addBytes(rolledGlobal, bytes),
    daemon: addBytes(rolledDaemon, bytes),
    decision: { ok: true },
  };
}

/** Release one durable reservation. Missing or mismatched evidence is an error, never an empty slot. */
export function releaseHostedRelayConnection(
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics,
  at: number,
): HostedRelayMetricsTransition {
  if (
    global.concurrentConnections === 0 ||
    daemon.concurrentConnections === 0 ||
    (global.lastActivityAt !== null && at < global.lastActivityAt) ||
    (daemon.lastActivityAt !== null && at < daemon.lastActivityAt)
  ) {
    return internalFailure(global, daemon, 'relay connection reservation is damaged');
  }
  return {
    global: { ...global, concurrentConnections: global.concurrentConnections - 1, lastActivityAt: at },
    daemon: { ...daemon, concurrentConnections: daemon.concurrentConnections - 1, lastActivityAt: at },
    decision: { ok: true },
  };
}

/** Re-check a live rendezvous after an operator changes the kill switch or ceilings. */
export function inspectHostedRelayCapacity(
  configuration: HostedRelayConfiguration,
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics | null,
  at: number,
): HostedRelayDecision {
  if (configuration.relayUrl === null) {
    return { ok: false, code: RELAY_CLOSE_CODES.hostedDisabled, reason: 'hosted relay is disabled' };
  }
  if (daemon === null || daemon.concurrentConnections === 0 || global.concurrentConnections === 0) {
    return { ok: false, code: RELAY_CLOSE_CODES.relayInternal, reason: 'relay connection reservation is lost' };
  }
  if (daemon.concurrentConnections > configuration.limits.maxConcurrentConnectionsPerDaemon) {
    return {
      ok: false,
      code: RELAY_CLOSE_CODES.hostedCapacity,
      reason: 'hosted relay per-daemon connection ceiling is exceeded',
    };
  }
  if (global.concurrentConnections > configuration.limits.maxConcurrentConnectionsGlobal) {
    return {
      ok: false,
      code: RELAY_CLOSE_CODES.hostedCapacity,
      reason: 'hosted relay global connection ceiling is exceeded',
    };
  }
  const rolledGlobal = rollUsage(global, at);
  const rolledDaemon = rollUsage(daemon, at);
  if (rolledGlobal === null || rolledDaemon === null) {
    return { ok: false, code: RELAY_CLOSE_CODES.relayInternal, reason: 'relay meter clock moved backwards' };
  }
  const checks: readonly [number, number, string, number][] = [
    [
      rolledDaemon.minute.bytes,
      configuration.limits.maxBytesPerMinutePerDaemon,
      'hosted relay per-daemon minute bandwidth ceiling is reached',
      rolledDaemon.minute.startedAt + HOSTED_RELAY_MINUTE_MILLISECONDS,
    ],
    [
      rolledGlobal.minute.bytes,
      configuration.limits.maxBytesPerMinuteGlobal,
      'hosted relay global minute bandwidth ceiling is reached',
      rolledGlobal.minute.startedAt + HOSTED_RELAY_MINUTE_MILLISECONDS,
    ],
    [
      rolledDaemon.day.bytes,
      configuration.limits.maxBytesPerDayPerDaemon,
      'hosted relay per-daemon daily bandwidth ceiling is reached',
      rolledDaemon.day.startedAt + HOSTED_RELAY_DAY_MILLISECONDS,
    ],
    [
      rolledGlobal.day.bytes,
      configuration.limits.maxBytesPerDayGlobal,
      'hosted relay global daily bandwidth ceiling is reached',
      rolledGlobal.day.startedAt + HOSTED_RELAY_DAY_MILLISECONDS,
    ],
  ];
  for (const [used, limit, reason, retryAt] of checks) {
    if (used >= limit) return { ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth, reason, retryAt };
  }
  return { ok: true };
}

function emptyUsage(at: number) {
  const stamp = TimestampSchema.parse(at);
  return {
    requestCount: 0,
    acceptedConnections: 0,
    connectionRefusals: 0,
    bytesRelayed: 0,
    bandwidthRefusals: 0,
    concurrentConnections: 0,
    peakConcurrentConnections: 0,
    firstActivityAt: null,
    lastActivityAt: null,
    minute: { startedAt: windowStart(stamp, HOSTED_RELAY_MINUTE_MILLISECONDS), bytes: 0 },
    day: { startedAt: windowStart(stamp, HOSTED_RELAY_DAY_MILLISECONDS), bytes: 0 },
  };
}

function windowStart(at: number, duration: number): number {
  return Math.floor(at / duration) * duration;
}

function safeAdd(value: number, amount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

function touchRequest<T extends HostedRelayGlobalMetrics | HostedRelayDaemonMetrics>(value: T, at: number): T | null {
  if (value.lastActivityAt !== null && at < value.lastActivityAt) return null;
  return {
    ...value,
    requestCount: safeAdd(value.requestCount, 1),
    firstActivityAt: value.firstActivityAt ?? at,
    lastActivityAt: at,
  };
}

function acceptConnection<T extends HostedRelayGlobalMetrics | HostedRelayDaemonMetrics>(
  value: T,
  trackedDaemons: number,
): T {
  const concurrentConnections = safeAdd(value.concurrentConnections, 1);
  return {
    ...value,
    acceptedConnections: safeAdd(value.acceptedConnections, 1),
    concurrentConnections,
    peakConcurrentConnections: Math.max(value.peakConcurrentConnections, concurrentConnections),
    ...('trackedDaemons' in value ? { trackedDaemons: safeAdd(value.trackedDaemons, trackedDaemons) } : {}),
  };
}

function refuseConnection(
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics | null,
  code: RelayCloseCode,
  reason: string,
): HostedRelayMetricsTransition {
  return {
    global: { ...global, connectionRefusals: safeAdd(global.connectionRefusals, 1) },
    daemon: daemon === null ? null : { ...daemon, connectionRefusals: safeAdd(daemon.connectionRefusals, 1) },
    decision: { ok: false, code, reason },
  };
}

function refuseBandwidth(
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics,
  code: RelayCloseCode,
  reason: string,
  retryAt?: number,
): HostedRelayMetricsTransition {
  return {
    global: { ...global, bandwidthRefusals: safeAdd(global.bandwidthRefusals, 1) },
    daemon: { ...daemon, bandwidthRefusals: safeAdd(daemon.bandwidthRefusals, 1) },
    decision: { ok: false, code, reason, ...(retryAt === undefined ? {} : { retryAt }) },
  };
}

function internalFailure(
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics | null,
  reason: string,
): HostedRelayMetricsTransition {
  return { global, daemon, decision: { ok: false, code: RELAY_CLOSE_CODES.relayInternal, reason } };
}

function rollUsage<T extends HostedRelayGlobalMetrics | HostedRelayDaemonMetrics>(value: T, at: number): T | null {
  if (at < value.minute.startedAt || at < value.day.startedAt) return null;
  const minuteStartedAt = windowStart(at, HOSTED_RELAY_MINUTE_MILLISECONDS);
  const dayStartedAt = windowStart(at, HOSTED_RELAY_DAY_MILLISECONDS);
  return {
    ...value,
    minute: minuteStartedAt === value.minute.startedAt ? value.minute : { startedAt: minuteStartedAt, bytes: 0 },
    day: dayStartedAt === value.day.startedAt ? value.day : { startedAt: dayStartedAt, bytes: 0 },
  };
}

function addBytes<T extends HostedRelayGlobalMetrics | HostedRelayDaemonMetrics>(value: T, bytes: number): T {
  return {
    ...value,
    bytesRelayed: safeAdd(value.bytesRelayed, bytes),
    minute: { ...value.minute, bytes: safeAdd(value.minute.bytes, bytes) },
    day: { ...value.day, bytes: safeAdd(value.day.bytes, bytes) },
  };
}
