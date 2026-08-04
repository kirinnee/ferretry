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

import { connectionSocketUrl, HEARTBEAT_GRACE_SECONDS, HEARTBEAT_SECONDS } from '@ferretry/relay';
import type { DaemonRelayConfig } from '../runtime/config.ts';

/** How often this side must prove it is alive, and how long silence is tolerated. */
export const RELAY_HEARTBEAT_MS = HEARTBEAT_SECONDS * 1_000;
export const RELAY_SILENCE_LIMIT_MS = HEARTBEAT_GRACE_SECONDS * 1_000;

export type RelayCarrierDecision =
  | {
      readonly kind: 'dial';
      /** The `wss://…/v1/rendezvous/<daemonId>/daemon` address, derived once, here. */
      readonly socketUrl: string;
      /** The host as the configured URL spells it. The claim signature covers this exact string. */
      readonly relayHost: string;
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
