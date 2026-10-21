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

const MEBIBYTE = 1024 * 1024;
const GIBIBYTE = 1024 * MEBIBYTE;

/**
 * Limits for a new control object, intentionally mutable through the operator endpoint. They are
 * defaults, not a baked-in relay address or an immutable policy.
 *
 * The byte ceilings are cost guards sized for one person's machines, not a rationing scheme: the
 * first-deployment 1 GiB/day locked an owner out of their own daemon in an afternoon, while
 * Cloudflare bills Workers and Durable Objects by requests, messages and duration rather than by
 * bytes relayed. docs/relay-protocol.md §13 carries the sizing.
 */
export const DEFAULT_HOSTED_RELAY_LIMITS: HostedRelayLimits = {
  maxConcurrentConnectionsPerDaemon: 16,
  maxConcurrentConnectionsGlobal: 512,
  maxBytesPerMinutePerDaemon: 512 * MEBIBYTE,
  maxBytesPerMinuteGlobal: 4 * GIBIBYTE,
  maxBytesPerDayPerDaemon: 20 * GIBIBYTE,
  maxBytesPerDayGlobal: 200 * GIBIBYTE,
  maxTrackedDaemons: 10_000,
};

/**
 * Every default set this relay has ever shipped, oldest first, excluding the current one.
 *
 * A deploy seeds limits only into an untouched control object, so a stored configuration keeps
 * whatever defaults were current when it was first written. One that still holds a former default
 * set, field for field, was never chosen by its operator, and reading it as today's defaults is what
 * makes raising a default reach the deployments that already exist. Anything else — even one field
 * changed — is the operator's decision and is kept.
 */
export const SUPERSEDED_HOSTED_RELAY_LIMITS: readonly HostedRelayLimits[] = [
  {
    maxConcurrentConnectionsPerDaemon: 16,
    maxConcurrentConnectionsGlobal: 512,
    maxBytesPerMinutePerDaemon: 64 * MEBIBYTE,
    maxBytesPerMinuteGlobal: GIBIBYTE,
    maxBytesPerDayPerDaemon: GIBIBYTE,
    maxBytesPerDayGlobal: 16 * GIBIBYTE,
    maxTrackedDaemons: 10_000,
  },
];

function sameLimits(left: HostedRelayLimits, right: HostedRelayLimits): boolean {
  return (Object.keys(left) as (keyof HostedRelayLimits)[]).every(key => left[key] === right[key]);
}

/**
 * The configuration a stored document means today: a superseded default set reads as the current
 * defaults, and every other document is returned unchanged. Pure and idempotent, so it can run on
 * every read without a migration step that a failed write could leave half-done.
 */
export function upgradeHostedRelayConfiguration(configuration: HostedRelayConfiguration): HostedRelayConfiguration {
  return SUPERSEDED_HOSTED_RELAY_LIMITS.some(limits => sameLimits(limits, configuration.limits))
    ? { ...configuration, limits: DEFAULT_HOSTED_RELAY_LIMITS }
    : configuration;
}

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

/**
 * The three refusal counters answer three different questions and deliberately overlap.
 *
 * `connectionRefusals` counts admission attempts turned away for any reason at all.
 * `bandwidthRefusals` counts frame events turned away by a byte ceiling, and nothing else — a
 * kill-switch refusal recorded there would read as an over-budget account when no budget was spent.
 * `disabledRefusals` counts everything the runtime switch turned away, whether it arrived as a new
 * socket or as a frame on a live one, so an operator can tell an intentional stop from a real cap.
 */
const HostedRelayUsageShape = {
  requestCount: SafeCountSchema,
  acceptedConnections: SafeCountSchema,
  connectionRefusals: SafeCountSchema,
  bytesRelayed: SafeCountSchema,
  bandwidthRefusals: SafeCountSchema,
  disabledRefusals: SafeCountSchema,
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
  /** When a rendezvous last reported a live socket holding it. Absent until the first renewal. */
  confirmedAt: TimestampSchema.optional(),
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
    return refuseDisabledConnection(touchedGlobal, daemon, 'hosted relay is disabled');
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
  if (touchedDaemon === null) return internalFailure(touchedGlobal, daemon, 'relay meter clock moved backwards');
  /**
   * A refusal never invents a durable row.
   *
   * `trackedDaemons` is the census of stored per-daemon rows, and it only grows when a connection is
   * admitted. Handing a freshly minted row back on a refusal would persist a row nothing counted,
   * which desynchronises that census permanently and makes the operator snapshot unreadable.
   */
  const refusedDaemon = daemon === null ? null : touchedDaemon;
  if (touchedDaemon.concurrentConnections >= configuration.limits.maxConcurrentConnectionsPerDaemon) {
    return refuseConnection(
      touchedGlobal,
      refusedDaemon,
      RELAY_CLOSE_CODES.hostedCapacity,
      HOSTED_RELAY_DAEMON_CEILING_REASON,
    );
  }
  if (touchedGlobal.concurrentConnections >= configuration.limits.maxConcurrentConnectionsGlobal) {
    return refuseConnection(
      touchedGlobal,
      refusedDaemon,
      RELAY_CLOSE_CODES.hostedCapacity,
      'hosted relay global connection ceiling is reached',
    );
  }

  const nextGlobal = acceptConnection(touchedGlobal, daemon === null ? 1 : 0);
  const nextDaemon = acceptConnection(touchedDaemon, 0);
  return { global: nextGlobal, daemon: nextDaemon, decision: { ok: true } };
}

/**
 * Count a batch of frame events a rendezvous has ALREADY forwarded, and the opaque encoded bytes they
 * carried, then decide whether that rendezvous may keep forwarding.
 *
 * A rendezvous reports in batches — every frame it forwarded while its previous report was in flight
 * (§13, "What is metered and capped") — so the meter is never on a frame's path. The bytes were
 * relayed, so they are counted even when they cross a ceiling: the bill does not shrink because the
 * report arrived after the bytes did. Crossing is what refuses, and the refusal stops what follows.
 * A zero-byte event counts protocol/control work without claiming content was relayed.
 */
export function meterHostedRelayRequest(
  configuration: HostedRelayConfiguration,
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics,
  bytes: number,
  at: number,
  events = 1,
): HostedRelayMetricsTransition {
  if (!Number.isSafeInteger(events) || events < 1) {
    return internalFailure(global, daemon, 'relay meter received an invalid event count');
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > events * MAX_FRAME_BYTES) {
    return internalFailure(global, daemon, 'relay meter received an invalid byte count');
  }
  const touchedGlobal = touchRequest(global, at, events);
  const touchedDaemon = touchRequest(daemon, at, events);
  if (touchedGlobal === null || touchedDaemon === null) {
    return internalFailure(global, daemon, 'relay meter clock moved backwards');
  }
  if (configuration.relayUrl === null) {
    return refuseDisabledFrame(touchedGlobal, touchedDaemon, 'hosted relay is disabled');
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

  const checks = bandwidthChecks(configuration, rolledGlobal, rolledDaemon);
  for (const { used, limit, reason, retryAt } of checks) {
    if (bytes > limit - used) {
      return refuseBandwidth(
        addBytes(rolledGlobal, bytes),
        addBytes(rolledDaemon, bytes),
        RELAY_CLOSE_CODES.hostedBandwidth,
        reason,
        retryAt,
      );
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

/** The UTC day an instant belongs to, named by its first millisecond. */
export function hostedRelayDayStart(at: number): number {
  return windowStart(TimestampSchema.parse(at), HOSTED_RELAY_DAY_MILLISECONDS);
}

/**
 * May this stored daemon row be forgotten to make room for a daemon that has never been seen?
 *
 * `maxTrackedDaemons` bounds durable rows, and a bound that only ever fills is a bound that
 * eventually refuses every new daemon forever. Reclaiming is what keeps it a ceiling rather than a
 * one-way lock, so the test has to be strict in the other direction: a row may only go when nothing
 * is using it and its accounting day is over. Both the day window and the last activity stamp must
 * predate the current UTC day, because a refusal can stamp activity on a row without rolling its
 * window, and either one alone would let today's traffic be forgotten out from under its own caps.
 *
 * A missing activity stamp is kept rather than reclaimed. Every row that reaches durable storage has
 * been through {@link admitHostedRelayConnection} or {@link meterHostedRelayRequest}, both of which
 * stamp it, so a stored row with no stamp is evidence nobody can account for — and the fail-closed
 * reading of evidence nobody can account for is that it is still in use.
 */
export function reclaimableHostedRelayDaemon(daemon: HostedRelayDaemonMetrics, at: number): boolean {
  const today = hostedRelayDayStart(at);
  return (
    daemon.concurrentConnections === 0 &&
    daemon.day.startedAt < today &&
    daemon.lastActivityAt !== null &&
    daemon.lastActivityAt < today
  );
}

/**
 * Shrink the row census by rows that were actually deleted, and change nothing else.
 *
 * Cumulative totals are deliberately untouched: the bill an account already ran up does not become
 * smaller because a quiet daemon's row was tidied away. A count that exceeds the census is damaged
 * evidence rather than an empty account, so it returns null and the caller fails closed.
 */
export function forgetHostedRelayDaemons(
  global: HostedRelayGlobalMetrics,
  forgotten: number,
): HostedRelayGlobalMetrics | null {
  if (!Number.isSafeInteger(forgotten) || forgotten < 0 || forgotten > global.trackedDaemons) return null;
  return { ...global, trackedDaemons: global.trackedDaemons - forgotten };
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
  const checks = bandwidthChecks(configuration, rolledGlobal, rolledDaemon);
  for (const { used, limit, reason, retryAt } of checks) {
    if (used >= limit) return { ok: false, code: RELAY_CLOSE_CODES.hostedBandwidth, reason, retryAt };
  }
  return { ok: true };
}

interface BandwidthCheck {
  readonly used: number;
  readonly limit: number;
  /** The refusal reason, with the reset instant already in it. */
  readonly reason: string;
  readonly retryAt: number;
}

/** The four byte ceilings in the order they are tested, shared by metering and inspection. */
function bandwidthChecks(
  configuration: HostedRelayConfiguration,
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics,
): readonly BandwidthCheck[] {
  const { limits } = configuration;
  return (
    [
      [daemon.minute, limits.maxBytesPerMinutePerDaemon, 'daemon', 'minute'],
      [global.minute, limits.maxBytesPerMinuteGlobal, 'global', 'minute'],
      [daemon.day, limits.maxBytesPerDayPerDaemon, 'daemon', 'day'],
      [global.day, limits.maxBytesPerDayGlobal, 'global', 'day'],
    ] as const
  ).map(([window, limit, scope, span]) => {
    const retryAt =
      window.startedAt + (span === 'minute' ? HOSTED_RELAY_MINUTE_MILLISECONDS : HOSTED_RELAY_DAY_MILLISECONDS);
    return {
      used: window.bytes,
      limit,
      reason: hostedBandwidthReason(HOSTED_RELAY_BANDWIDTH_REASONS[scope][span], retryAt),
      retryAt,
    };
  });
}

function emptyUsage(at: number) {
  const stamp = TimestampSchema.parse(at);
  return {
    requestCount: 0,
    acceptedConnections: 0,
    connectionRefusals: 0,
    bytesRelayed: 0,
    bandwidthRefusals: 0,
    disabledRefusals: 0,
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

function touchRequest<T extends HostedRelayGlobalMetrics | HostedRelayDaemonMetrics>(
  value: T,
  at: number,
  events = 1,
): T | null {
  if (value.lastActivityAt !== null && at < value.lastActivityAt) return null;
  return {
    ...value,
    requestCount: safeAdd(value.requestCount, events),
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

/** A socket turned away by the switch is still a refused connection, and also an intentional stop. */
function refuseDisabledConnection(
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics | null,
  reason: string,
): HostedRelayMetricsTransition {
  const refused = refuseConnection(global, daemon, RELAY_CLOSE_CODES.hostedDisabled, reason);
  return {
    global: { ...refused.global, disabledRefusals: safeAdd(refused.global.disabledRefusals, 1) },
    daemon:
      refused.daemon === null
        ? null
        : { ...refused.daemon, disabledRefusals: safeAdd(refused.daemon.disabledRefusals, 1) },
    decision: refused.decision,
  };
}

/** A frame turned away by the switch spent no bandwidth, so only the switch counter moves. */
function refuseDisabledFrame(
  global: HostedRelayGlobalMetrics,
  daemon: HostedRelayDaemonMetrics,
  reason: string,
): HostedRelayMetricsTransition {
  return {
    global: { ...global, disabledRefusals: safeAdd(global.disabledRefusals, 1) },
    daemon: { ...daemon, disabledRefusals: safeAdd(daemon.disabledRefusals, 1) },
    decision: { ok: false, code: RELAY_CLOSE_CODES.hostedDisabled, reason },
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

/**
 * How long a reservation may go unseen by its rendezvous before it is someone else's handoff no more.
 *
 * The Worker reserves, THEN hands the socket to the rendezvous, so for a moment a reservation exists
 * that no rendezvous lists yet. A rendezvous reporting its live sockets must not reclaim that one, so a
 * reservation younger than this is kept whatever the report says. The handoff takes milliseconds; the
 * bound is generous so a slow edge cannot turn a fresh admission into a reclaimed one.
 */
export const HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS = 30_000 as const;

/**
 * How long a reservation stays held with no renewal from the rendezvous that owns it.
 *
 * A live rendezvous renews every reservation it still holds a socket for on its heartbeat sweep (§13,
 * "Reservations are leases"), far more often than this. A reservation nobody renewed for this long
 * belongs to no socket anyone holds — the rendezvous lost it without a close callback, or the Worker
 * died between admission and handoff — and keeping it would be the permanent lockout of 2026-10-19.
 * The bound is several times the renewal interval AND several times the control-object outage grace,
 * so neither a missed renewal nor a tolerated outage can expire a reservation a live socket holds.
 */
export const HOSTED_RELAY_RESERVATION_LEASE_MILLISECONDS = 600_000 as const;

/**
 * The four byte-ceiling refusals, named once so a daemon and a browser can recognise them.
 *
 * A refusal is a `4433` close whose reason is one of these followed by {@link HOSTED_RELAY_RESETS_MARK}
 * and the UTC instant the window rolls over. The instant travels inside the reason rather than as a new
 * control-frame field because `error` is a strict wire shape: an added field would make every older
 * build discard the frame, and with it the only explanation it was going to get.
 */
export const HOSTED_RELAY_BANDWIDTH_REASONS = {
  daemon: {
    minute: 'hosted relay per-daemon minute bandwidth ceiling is reached',
    day: 'hosted relay per-daemon daily bandwidth ceiling is reached',
  },
  global: {
    minute: 'hosted relay global minute bandwidth ceiling is reached',
    day: 'hosted relay global daily bandwidth ceiling is reached',
  },
} as const;
export const HOSTED_RELAY_RESETS_MARK = '; resets ' as const;

/**
 * A byte-ceiling refusal reason with its reset instant. The longest is 91 characters, inside the
 * 123-byte WebSocket close reason the same text is also sent as.
 */
export function hostedBandwidthReason(reason: string, retryAt: number): string {
  return `${reason}${HOSTED_RELAY_RESETS_MARK}${new Date(retryAt).toISOString()}`;
}

/** What a `4433` reason says: whose allowance ran out, and over which window. */
export interface HostedBandwidthRefusalReason {
  readonly scope: 'daemon' | 'global';
  readonly window: 'minute' | 'day';
  /** The reset instant the relay carried, or `null` when it carried none or one that does not parse. */
  readonly resetsAt: number | null;
}

/** A refusal with a reset instant that is always known. */
export interface HostedBandwidthRefusal extends HostedBandwidthRefusalReason {
  readonly resetsAt: number;
}

/**
 * Read a `4433` reason without a clock, or `null` for one that is not a byte-ceiling refusal. A relay
 * deployed before the reset was carried says only the bare sentence, so `resetsAt` may be `null`.
 */
export function readHostedBandwidthRefusal(reason: string): HostedBandwidthRefusalReason | null {
  for (const scope of ['daemon', 'global'] as const) {
    for (const window of ['minute', 'day'] as const) {
      const sentence = HOSTED_RELAY_BANDWIDTH_REASONS[scope][window];
      if (!reason.startsWith(sentence)) continue;
      const rest = reason.slice(sentence.length);
      const carried = rest.startsWith(HOSTED_RELAY_RESETS_MARK)
        ? Date.parse(rest.slice(HOSTED_RELAY_RESETS_MARK.length))
        : Number.NaN;
      return { scope, window, resetsAt: Number.isFinite(carried) ? carried : null };
    }
  }
  return null;
}

/**
 * Read a `4433` reason against `now`, so the reset is always an instant to wait for.
 *
 * The windows are the UTC minute and the UTC day on every relay version, so a missing reset is derived
 * — the next UTC midnight for a day, a minute from now for a minute. A carried instant already in the
 * past is derived the same way rather than trusted.
 */
export function parseHostedBandwidthRefusal(reason: string, now: number): HostedBandwidthRefusal | null {
  const read = readHostedBandwidthRefusal(reason);
  if (read === null) return null;
  if (read.resetsAt !== null && read.resetsAt > now) return { ...read, resetsAt: read.resetsAt };
  const resetsAt =
    read.window === 'day'
      ? Math.floor(now / HOSTED_RELAY_DAY_MILLISECONDS) * HOSTED_RELAY_DAY_MILLISECONDS + HOSTED_RELAY_DAY_MILLISECONDS
      : now + HOSTED_RELAY_MINUTE_MILLISECONDS;
  return { ...read, resetsAt };
}

/** The refusal a per-daemon connection ceiling produces, named once so callers can recognise it. */
export const HOSTED_RELAY_DAEMON_CEILING_REASON = 'hosted relay per-daemon connection ceiling is reached' as const;

/** What a rendezvous saw: the reservations its live sockets carry, for one daemon. */
export interface HostedRelayLiveEvidence {
  readonly daemonId: string;
  readonly live: ReadonlySet<string>;
}

/** Which stored reservations survive an audit, and what the counters must say afterwards. */
export interface HostedRelayReservationAudit {
  /** Reservation identifiers no live socket holds and no lease protects. */
  readonly reclaimed: readonly string[];
  /** Reservations a live socket was seen holding, renewed to `at`. */
  readonly renewed: readonly HostedRelayReservation[];
  /** Rows kept, per daemon fingerprint. A daemon with none kept is listed with 0 when it had any. */
  readonly heldByDaemon: ReadonlyMap<string, number>;
  /** Every reservation still held, across every daemon: what the global counter must equal. */
  readonly heldGlobal: number;
}

/**
 * Decide, from the durable reservations alone plus whatever a rendezvous could see, which ones are
 * still held.
 *
 * THE COUNTERS ARE DERIVED, NEVER TRUSTED. A counter that only moves on admit and release drifts
 * permanently the first time a release is lost, so an audit recounts from the reservation rows, which
 * are per socket and so cannot double count. Two kinds of evidence reclaim a row:
 *
 * - **The rendezvous's word.** Its runtime lists every socket it accepted, hibernating ones included,
 *   and each carries its reservation. A row of THAT daemon's that no live socket carries, and that is
 *   past the handoff grace, belongs to nothing.
 * - **An expired lease.** A row nobody renewed within {@link HOSTED_RELAY_RESERVATION_LEASE_MILLISECONDS}
 *   — the case where no rendezvous is left to say anything, which is exactly the one that locked a
 *   daemon out.
 *
 * A timestamp in the future (a clock that stepped back) counts as fresh: an audit may under-reclaim
 * on bad evidence, never over-reclaim.
 */
export function auditHostedRelayReservations(
  reservations: readonly HostedRelayReservation[],
  evidence: HostedRelayLiveEvidence | null,
  at: number,
): HostedRelayReservationAudit {
  const reclaimed: string[] = [];
  const renewed: HostedRelayReservation[] = [];
  const heldByDaemon = new Map<string, number>();
  let heldGlobal = 0;
  for (const reservation of reservations) {
    const own = evidence !== null && reservation.daemonId === evidence.daemonId;
    const seen = own && evidence.live.has(reservation.reservationId);
    const age = at - reservation.openedAt;
    const unrenewed = at - (reservation.confirmedAt ?? reservation.openedAt);
    const gone = own
      ? !seen && age >= HOSTED_RELAY_RESERVATION_HANDOFF_GRACE_MILLISECONDS
      : unrenewed >= HOSTED_RELAY_RESERVATION_LEASE_MILLISECONDS;
    heldByDaemon.set(reservation.daemonId, (heldByDaemon.get(reservation.daemonId) ?? 0) + (gone ? 0 : 1));
    if (gone) {
      reclaimed.push(reservation.reservationId);
      continue;
    }
    heldGlobal += 1;
    if (seen) renewed.push({ ...reservation, confirmedAt: Math.max(at, reservation.confirmedAt ?? 0) });
  }
  if (evidence !== null && !heldByDaemon.has(evidence.daemonId)) heldByDaemon.set(evidence.daemonId, 0);
  return { reclaimed, renewed, heldByDaemon, heldGlobal };
}

/** Set a counter to what the reservations prove. Peak and cumulative totals are history, untouched. */
export function recountHostedRelayConnections<T extends HostedRelayGlobalMetrics | HostedRelayDaemonMetrics>(
  value: T,
  held: number,
): T {
  return value.concurrentConnections === held ? value : { ...value, concurrentConnections: held };
}
