/**
 * Whether this daemon dials a rendezvous at all, and where.
 *
 * Separated from the link and from the socket for one reason: "no carrier" is an answer a person has
 * to be able to read. A daemon that quietly does not dial looks exactly like a daemon whose relay is
 * broken, and this migration has shipped that confusion three times. So every refusal here carries
 * the sentence explaining it, and the caller is expected to say it out loud.
 *
 * There is no default address and no guess. An absent configuration block is a daemon with no relay
 * carrier — not an invitation to use whatever the last release compiled in, because no release
 * compiles one in on either end.
 */

import { connectionSocketUrl, HEARTBEAT_GRACE_SECONDS, RELAY_FEATURES_PARAM } from '@ferretry/relay';
import type { DaemonRelayConfig } from '../runtime/config.ts';

/**
 * How long silence is tolerated before the clock alone condemns a socket. This is the BACKSTOP, not
 * the detector: the ping/pong deadline below finds a dead path within 30 seconds, and this rule is
 * what finds one when the timers themselves did not run — a laptop that slept through its own ping,
 * woken to a tick that fires late. Seeing 45 seconds of silence on that first tick drops the socket
 * at once instead of pinging a corpse and waiting another ten seconds.
 */
export const RELAY_SILENCE_LIMIT_MS = HEARTBEAT_GRACE_SECONDS * 1_000;

/**
 * How often this side pings. The protocol says "at least every `heartbeatSeconds`" (§8), so a faster
 * cadence conforms, and the edge answers `fy-ping` without waking the Durable Object: it costs the
 * deployment nothing.
 */
export const RELAY_KEEPALIVE_MS = 20_000;

/**
 * The address actually dialled: the rendezvous route, asking for `claim-probe` and `claim-handover` (§5).
 *
 * In the query, not the path, because a rendezvous that does not speak it must not notice it was asked:
 * an older one ignores the query and answers a plain `claimed`, and this daemon then never probes.
 */
export const relayDialUrl = (socketUrl: string): string => {
  const url = new URL(socketUrl);
  url.searchParams.set(RELAY_FEATURES_PARAM, 'claim-probe,claim-handover');
  return url.toString();
};

/** How long a dial may take to open before it is abandoned and redialled. */
export const RELAY_CONNECT_DEADLINE_MS = 15_000;

/** After a ping, how long the socket may stay entirely silent before it is declared dead. ANY
 *  inbound message counts as an answer — a socket carrying traffic is not dead. */
export const RELAY_PONG_DEADLINE_MS = 10_000;

/** The redial schedule: the first redial is immediate, then equal jitter on `BASE × 2^(attempt − 1)`. */
export const RELAY_REDIAL_BASE_MS = 500;
export const RELAY_REDIAL_CEILING_MIN_MS = 1_000;
export const RELAY_REDIAL_CEILING_MAX_MS = 10_000;
const RELAY_REDIAL_CEILING_FALLBACK_MS = 5_000;

export type RelayCarrierDecision =
  | {
      readonly kind: 'dial';
      /** The `wss://…/v1/rendezvous/<daemonId>/daemon` address, derived once, here. */
      readonly socketUrl: string;
      /** The host as the configured URL spells it. The claim signature covers this exact string. */
      readonly relayHost: string;
      /** The scheme and authority only — the path carries the daemon fingerprint, so a log line names this. */
      readonly relayOrigin: string;
      /** The configured `reconnectSeconds`, in ms. It is the backoff CEILING, clamped where it is used. */
      readonly reconnectMs: number;
    }
  | { readonly kind: 'none'; readonly reason: string };

/**
 * Decide the carrier from configuration and this daemon's own fingerprint.
 *
 * The fingerprint is checked here because it addresses the rendezvous: a daemon whose identifier is
 * not a well-formed fingerprint cannot be addressed at all, and dialling anyway would put a socket on
 * a path the rendezvous will refuse.
 */
export function decideRelayCarrier(config: DaemonRelayConfig | undefined, daemonId: string): RelayCarrierDecision {
  if (config === undefined) {
    return { kind: 'none', reason: 'no relay is configured, so this daemon is reachable only directly' };
  }
  if (!config.enabled) {
    return {
      kind: 'none',
      reason: `the configured relay ${config.url} is switched off in this daemon's configuration`,
    };
  }
  const socketUrl = connectionSocketUrl({ kind: 'relay', relayUrl: config.url }, daemonId, 'daemon');
  if (socketUrl === null) {
    return { kind: 'none', reason: `${daemonId} is not a daemon fingerprint a rendezvous can be addressed by` };
  }
  return {
    kind: 'dial',
    socketUrl,
    relayHost: new URL(config.url).host,
    relayOrigin: new URL(config.url).origin,
    reconnectMs: config.reconnectSeconds * 1_000,
  };
}

/**
 * Has this socket gone quiet?
 *
 * NO EVIDENCE OF LIFE MEANS DEAD, which is the same reading the rendezvous applies to us. The
 * alternative — waiting for a close that a suspended laptop will never send — leaves the daemon
 * believing it holds a rendezvous slot it lost, and every client that arrives is told there is no
 * daemon here.
 */
export function relaySocketIsStale(lastSeenMs: number, nowMs: number): boolean {
  return nowMs - lastSeenMs >= RELAY_SILENCE_LIMIT_MS;
}

/**
 * How long to wait before redial number `attempt` (0 is the first redial after a socket ended).
 *
 * ATTEMPT 0 IS IMMEDIATE. A Worker redeploy drops every socket at once and the slot it held is gone
 * with it, so waiting only lengthens the outage; a dead path that the rendezvous has not yet swept
 * answers the redial with `4409`, which is just attempt 1, and the schedule backs off from there.
 * After that the window doubles from {@link RELAY_REDIAL_BASE_MS} to `ceilingMs`, and the delay lands in
 * the upper half of it (EQUAL JITTER): never below `window / 2`, so a long backoff cannot collapse
 * back to a storm, and never above `window`, so a fleet of daemons does not redial in one millisecond.
 *
 * `ceilingMs` is the operator's `reconnectSeconds`, reinterpreted as the CEILING and clamped to
 * [{@link RELAY_REDIAL_CEILING_MIN_MS}, {@link RELAY_REDIAL_CEILING_MAX_MS}].
 *
 * TOTAL, AND NEVER SHORTER THAN THE SCHEDULE ALLOWS. `Math.min`/`Math.max` propagate `NaN`, and a timer
 * coerces `NaN` to zero, so every input is normalised before it is clamped: an unusable `attempt`
 * (NaN, negative) is the first redial, an infinite one the longest window; an unusable `random` is
 * the bottom of the range; an unusable `ceilingMs` is the default five seconds, and an infinite one
 * the clamp's own end.
 */
export function relayRedialDelayMs(attempt: number, random: number, ceilingMs: number): number {
  const step = Number.isNaN(attempt) ? 0 : Math.max(0, Math.floor(attempt));
  if (step === 0) return 0;
  const ceiling = Number.isNaN(ceilingMs)
    ? RELAY_REDIAL_CEILING_FALLBACK_MS
    : Math.min(RELAY_REDIAL_CEILING_MAX_MS, Math.max(RELAY_REDIAL_CEILING_MIN_MS, ceilingMs));
  const windowMs = Math.min(ceiling, RELAY_REDIAL_BASE_MS * 2 ** (step - 1));
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.round(windowMs / 2 + (windowMs / 2) * jitter);
}

/** The first window after a hosted relay refuses this daemon a connection slot (`4432`). */
export const RELAY_CAPACITY_REDIAL_BASE_MS = 120_000;
/** The longest window a run of `4432` refusals backs off to. */
export const RELAY_CAPACITY_REDIAL_CEILING_MS = 600_000;
/**
 * How long to wait before redialling after the `refusals`th `4432` in a row (1 is the first).
 *
 * A CONNECTION CEILING IS NOT A DEAD PATH. Redialling it on the ordinary schedule — seconds — asked a
 * hosted relay that had already said no, fourteen thousand times in a day (2026-10-19), and each ask
 * spent the account's request budget on nothing. A ceiling clears when sockets close or the relay's
 * own audit reclaims what it lost, which takes minutes, so the window starts at
 * {@link RELAY_CAPACITY_REDIAL_BASE_MS} and doubles to {@link RELAY_CAPACITY_REDIAL_CEILING_MS}, with
 * the same equal jitter as {@link relayRedialDelayMs}: never below half the window, never above it.
 * Total in the same way: an unusable count is the first refusal, an unusable `random` the bottom.
 */
export function relayCapacityRedialDelayMs(refusals: number, random: number): number {
  const step = Number.isNaN(refusals) ? 1 : Math.max(1, Math.floor(refusals));
  const windowMs = Math.min(RELAY_CAPACITY_REDIAL_CEILING_MS, RELAY_CAPACITY_REDIAL_BASE_MS * 2 ** (step - 1));
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.round(windowMs / 2 + (windowMs / 2) * jitter);
}

/** The soonest a daemon redials after a hosted relay refuses it for bytes (`4433`). */
export const RELAY_BANDWIDTH_REDIAL_MIN_MS = 60_000;
/**
 * The longest a `4433` waits before asking again, however far away the reset is. The operator can
 * raise a ceiling at any time, and a daemon that slept until midnight would ignore that for hours.
 */
export const RELAY_BANDWIDTH_RECHECK_MS = 1_800_000;
/** How far past the reset a redial is spread, so every refused daemon does not dial at midnight UTC. */
export const RELAY_BANDWIDTH_REDIAL_SPREAD_MS = 30_000;

/**
 * How long to wait before redialling after a hosted relay refused this daemon for bytes.
 *
 * A BYTE CEILING IS A DATE, NOT A STORM TO RIDE OUT. A refused daemon that redialled on the ordinary
 * schedule was admitted, claimed, sent one frame and was refused again, every few seconds, until the
 * window rolled over — spending the account's request budget to learn what the refusal already said.
 * So it waits until the reset the refusal names (`untilResetMs`), never less than
 * {@link RELAY_BANDWIDTH_REDIAL_MIN_MS} and never more than {@link RELAY_BANDWIDTH_RECHECK_MS}, plus up
 * to {@link RELAY_BANDWIDTH_REDIAL_SPREAD_MS} of jitter. Total: an unusable `untilResetMs` waits the
 * recheck interval, an unusable `random` adds no jitter.
 */
export function relayBandwidthRedialDelayMs(untilResetMs: number, random: number): number {
  const until = Number.isNaN(untilResetMs) ? RELAY_BANDWIDTH_RECHECK_MS : untilResetMs;
  const wait = Math.min(RELAY_BANDWIDTH_RECHECK_MS, Math.max(RELAY_BANDWIDTH_REDIAL_MIN_MS, until));
  const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0;
  return Math.round(wait + RELAY_BANDWIDTH_REDIAL_SPREAD_MS * jitter);
}
