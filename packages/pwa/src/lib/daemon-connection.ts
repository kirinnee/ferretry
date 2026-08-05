/**
 * A paired daemon is an explicit runtime value.  The static PWA bundle must
 * never provide a default daemon, URL, or credential.
 *
 * A CONNECTION IS NOW TWO ADDRESSES, NOT ONE, and neither is compiled in.
 * `baseUrl` is the daemon's own address, which pairing handed over; `relay` is a
 * rendezvous that can carry the same session when that address is not reachable
 * from wherever this browser is. `docs/relay-protocol.md` §1 is the contract:
 * direct is attempted first because it has fewer hops and fewer observers, the
 * relay is the automatic fallback, and neither is a question a conforming product
 * asks its user.
 *
 * There is deliberately no "which carrier" preference stored anywhere. The order
 * is a property of the protocol (`connectionPreferenceOrder`), so a stored
 * preference could only ever disagree with it.
 */
import {
  type ConnectionMethod,
  ConnectionMethodSchema,
  connectionPreferenceOrder,
  parseDaemonId,
} from '@ferretry/relay';

export type DaemonId = string & { readonly daemonId: unique symbol };

/** The relay half of a connection's carrier set. A daemon address is not one of these. */
export type RelayCarrier = Extract<ConnectionMethod, { kind: 'relay' }>;

export interface DaemonConnectionInput {
  daemonId: string;
  baseUrl: string;
  deviceToken: string;
  relay?: RelayCarrier | undefined;
}

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceToken: string;
  /**
   * The rendezvous this daemon may be reached through, when one is known.
   *
   * ABSENT MEANS DIRECT-ONLY, and it is the honest default: a hosted relay's
   * address is a runtime advertisement whose operator can withdraw it, and
   * `relayUrl: null` or a discovery failure means no hosted carrier rather than
   * permission to guess (§13). Nothing here invents an address.
   */
  readonly relay?: RelayCarrier;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/** Validates the durable daemon identity supplied by a successful pairing. */
export const daemonId = (value: string): DaemonId => requireNonEmpty(value, 'daemonId') as DaemonId;

/**
 * Normalizes only a daemon origin supplied at runtime. Credentials, paths,
 * queries, and fragments are deliberately rejected so every HTTP and
 * WebSocket adapter resolves the same `/v1` surface. A reverse-proxy prefix
 * would otherwise be preserved by the typed client and discarded by
 * origin-relative direct requests.
 */
export const daemonBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('daemon URL must be absolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('daemon URL must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('daemon URL may not include credentials, a query, or a fragment');
  }
  if (url.pathname !== '/') throw new Error('daemon URL must be an origin without a path');
  return url.origin;
};

/**
 * Parses a relay carrier by the protocol's own rule, or refuses it.
 *
 * `ConnectionMethodSchema` is the single spelling of "an address this protocol
 * will dial" — secure schemes anywhere, insecure only against loopback. Re-stating
 * that rule here would give the repository two of them, and the pair would drift.
 */
export const daemonRelayCarrier = (value: RelayCarrier): RelayCarrier => {
  const parsed = ConnectionMethodSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== 'relay') throw new Error('relay carrier is not a dialable rendezvous');
  return parsed.data;
};

/** Constructs an immutable connection from runtime pairing output. */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => ({
  daemonId: daemonId(input.daemonId),
  baseUrl: daemonBaseUrl(input.baseUrl),
  deviceToken: requireNonEmpty(input.deviceToken, 'deviceToken'),
  ...(input.relay === undefined ? {} : { relay: daemonRelayCarrier(input.relay) }),
});

/**
 * The carriers this connection may be tried on, in the order the protocol says.
 *
 * DIRECT FIRST, ALWAYS — the ordering is `connectionPreferenceOrder`'s, not this
 * function's, so a caller cannot accidentally probe a relay before the daemon
 * address it already has.
 *
 * A RELAY IS OFFERED ONLY WHEN THE PAIRING PINNED A FINGERPRINT THIS PROTOCOL CAN
 * ADDRESS. A rendezvous is addressed by `fy_daemon_<43 base64url>` (§4) and the
 * handshake is checked against that same string (§6), so a `daemonId` in any other
 * spelling has no rendezvous to reach and no fingerprint to verify against. That
 * is refused rather than dialled: a session keyed against an unverifiable
 * fingerprint is exactly what a hostile carrier would like this browser to open.
 */
export const daemonCarriers = (daemon: DaemonConnection): readonly ConnectionMethod[] => {
  const direct: ConnectionMethod = { kind: 'direct', daemonUrl: daemon.baseUrl };
  const relay = parseDaemonId(daemon.daemonId) === null ? undefined : daemon.relay;
  return connectionPreferenceOrder(relay === undefined ? [direct] : [direct, relay]);
};

/**
 * Is this the same LIVE connection? The liveness boundary for anything holding
 * a credential — an in-flight request, a poll generation, an open socket, the
 * pixels already painted.
 *
 * `daemonId` alone cannot answer it. The id is DURABLE ACROSS A RE-PAIR, and a
 * re-pair is exactly when the base URL or the device token rotates: the same
 * daemon id can afterwards name a new endpoint or a new device grant. A holder
 * that treated `(daemonId, sessionId)` as its whole identity would let the old
 * pairing's late answer land in the new one.
 *
 * Compared FIELD BY FIELD, deliberately, and on purpose not as a derived key
 * string. A host that rebuilds an equivalent connection object each render has
 * not re-paired, so object identity is the wrong test; and a key string
 * containing `deviceToken` invites the credential into a cache key, a DOM
 * attribute or a log line, none of which may ever hold it.
 *
 * DURABLE state is a separate question with a separate answer: a remembered
 * preference keyed by `(daemonId, sessionId)` — the browser engine memory, for
 * instance — SHOULD survive a re-pair. Only liveness may not.
 *
 * THE CARRIER IS PART OF THIS, because it is where the bytes physically go. A
 * connection whose relay address changed — the operator moved it, or withdrew it
 * and left direct alone — is not the connection an in-flight request was issued
 * against, and an answer that arrived over the old carrier must not be read as an
 * answer from the new one.
 */
export const sameDaemonConnection = (left: DaemonConnection, right: DaemonConnection): boolean =>
  left.daemonId === right.daemonId &&
  left.baseUrl === right.baseUrl &&
  left.deviceToken === right.deviceToken &&
  left.relay?.relayUrl === right.relay?.relayUrl &&
  left.relay?.operator === right.relay?.operator;
