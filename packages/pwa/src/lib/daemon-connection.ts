/**
 * A paired daemon is an explicit runtime value.  The static PWA bundle must
 * never provide a default daemon, URL, or credential.
 *
 * A CONNECTION IS AN ORDERED CARRIER SET, and none of it is compiled in.
 * `baseUrl` is the direct address the pairing link arrived on; `carriers` is the
 * daemon-published cache that may contain that direct address, another direct
 * address, and up to four rendezvous links. `docs/relay-protocol.md` §13 is the
 * contract: every direct carrier is attempted first, then every relay, preserving
 * the daemon's order within each kind.
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
  carriers?: readonly ConnectionMethod[] | undefined;
}

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceToken: string;
  /**
   * The daemon's published carrier set, cached in the order the protocol tries it.
   *
   * The daemon is authoritative. Pairing seeds the cache and a successful live
   * connection replaces it from `GET /v1/carriers`; no client-side merge or
   * discovery branch is allowed to keep a relay the daemon has withdrawn.
   */
  readonly carriers: readonly ConnectionMethod[];
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

/** Validates one cached carrier without changing the daemon's preference within its kind. */
const daemonCarrier = (value: ConnectionMethod): ConnectionMethod => {
  if (value.kind === 'direct') return { kind: 'direct', daemonUrl: daemonBaseUrl(value.daemonUrl) };
  return daemonRelayCarrier(value);
};

/**
 * Constructs an immutable connection from runtime pairing output.
 *
 * A PAIRED DAEMON IS NEVER CARRIER-LESS. An absent carrier set and an empty one
 * are the same fact — nothing said where this daemon is — and the pairing already
 * answered it: `baseUrl` is the address the exchange succeeded over, so it is the
 * one carrier this browser can name without inventing a rendezvous.
 *
 * Left empty it would be a record with a valid credential and nowhere to send it,
 * which is a paired daemon presented as permanently unreachable. That is exactly
 * what a persisted set of carriers this build refuses to dial decays into, and
 * recovering to the known direct address is the only answer that can ever heal.
 */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => {
  const baseUrl = daemonBaseUrl(input.baseUrl);
  const direct: ConnectionMethod = { kind: 'direct', daemonUrl: baseUrl };
  const carriers = connectionPreferenceOrder((input.carriers ?? [direct]).map(daemonCarrier));
  return {
    daemonId: daemonId(input.daemonId),
    baseUrl,
    deviceToken: requireNonEmpty(input.deviceToken, 'deviceToken'),
    carriers: carriers.length === 0 ? [direct] : carriers,
  };
};

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
  if (parseDaemonId(daemon.daemonId) !== null) return daemon.carriers;
  return daemon.carriers.filter(carrier => carrier.kind === 'direct');
};

/**
 * The rendezvous a router may try when this daemon has authored NONE — dialled, never stored.
 *
 * WHY A DAEMON THAT PUBLISHES NOTHING IS NOT A DAEMON THAT IS DIRECT-ONLY. Until the carrier set
 * existed, each end read the hosted advertisement for itself and the two met by coincidence of
 * picking the same service; a phone away from its daemon's network reached it that way and nothing
 * was ever written down. A daemon too old to answer `GET /v1/carriers` still cannot say where it can
 * be reached, so a browser that offered it only the direct address it cannot get to would take that
 * working path away and have no way to learn it back: the refresh that would teach it needs a
 * connection it can no longer make, and pairing again is direct-only by construction.
 *
 * IT IS NOT PROMOTED INTO THE CACHE AND MUST NEVER BE. The stored set is what the DAEMON said, and a
 * guess written into it would outlive the advertisement that produced it — which is the kill switch
 * not working (§13). So this is computed per dial from the one advertisement read this document
 * performed: withdraw the address and the next load offers nothing, and the first set a daemon does
 * publish replaces this wholesale because it was never in the cache to survive.
 *
 * THE FINGERPRINT RULE IS `daemonCarriers`', unchanged: a rendezvous is addressed by a fingerprint
 * this protocol can verify against, so a pairing without one is offered no relay of any provenance.
 * The address is parsed rather than trusted for the same reason every other carrier is.
 */
export const hostedRelayFallbackCarrier = (
  daemon: DaemonConnection,
  hostedRelayUrl: string | undefined,
): RelayCarrier | undefined => {
  if (hostedRelayUrl === undefined) return undefined;
  if (parseDaemonId(daemon.daemonId) === null) return undefined;
  if (daemonCarriers(daemon).some(carrier => carrier.kind === 'relay')) return undefined;
  const parsed = ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl: hostedRelayUrl, operator: 'hosted' });
  return parsed.success && parsed.data.kind === 'relay' ? parsed.data : undefined;
};

/** Is this the same published address, dialled the same way? */
export const sameDaemonCarrier = (left: ConnectionMethod, right: ConnectionMethod): boolean =>
  left.kind === right.kind &&
  (left.kind === 'direct'
    ? right.kind === 'direct' && left.daemonUrl === right.daemonUrl
    : right.kind === 'relay' && left.relayUrl === right.relayUrl && left.operator === right.operator);

/** Equality for the daemon-authored cache, including published order. */
export const sameDaemonCarriers = (left: readonly ConnectionMethod[], right: readonly ConnectionMethod[]): boolean =>
  left.length === right.length &&
  left.every((carrier, index) => sameDaemonCarrier(carrier, right[index] as ConnectionMethod));

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
  sameDaemonCarriers(left.carriers, right.carriers);
