/**
 * JOINING A PUBLISHER AS A CATALOG MEMBER, ON EITHER CARRIER.
 *
 * A share link carries the publisher's address, its fingerprint and ONE single-use code. This module is
 * the browser's half of docs/relay-protocol.md §14 "Member sessions": it proves the publisher against
 * the link's fingerprint BEFORE the code leaves the browser (the session refuses to key a channel to
 * anything else), sends one sealed `join` record, and reads one sealed outcome.
 *
 * THE WALK IS PAIRING'S: the publisher's own address first, then the one rendezvous this build
 * discovered. Only a TRANSPORT failure advances it. A sealed `join-refused` is final and ends the walk,
 * because carrying the same code to a second carrier would spend another guess to be told the same thing.
 * There is ONE refusal for every cause, so there is one sentence for it.
 *
 * NOTHING IS KEPT HERE. The keys are minted by the caller, held in memory, and saved only after a
 * `joined` outcome; this module neither reads nor writes a store.
 */

import {
  type DaemonCarrier,
  isLoopbackHost,
  isLoopbackLinkAddress,
  type MemberJoinedResponse,
  type ShareLinkSeed,
} from '@ferretry/protocol';
import {
  type ConnectionMethod,
  connectionSocketUrl,
  HEARTBEAT_GRACE_SECONDS,
  type PrivateKeyHandle,
  parseDaemonId,
  publishedConnectionMethods,
  RELAY_CLOSE_CODES,
} from '@ferretry/relay';
import { daemonRelayCarrier, type RelayCarrier } from './daemon-connection.ts';
import type { MintedMemberKeys } from './member-keys.ts';
import {
  browserHeartbeat,
  browserRelayDial,
  driveRelaySession,
  type RelayDial,
  type RelayHeartbeatSchedule,
} from './relay-carrier.ts';
import {
  RelayClientSession,
  type RelayClientSessionDependencies,
  RelayJoinRefusedError,
  RelaySessionError,
} from './relay-session.ts';

/** The two carriers a join or a member session may cross. */
export type MemberCarrierMethod = Extract<ConnectionMethod, { kind: 'direct' | 'relay' }>;

/** How long the publisher's own address may take before the walk moves on. */
export const DIRECT_JOIN_TIMEOUT_MS = 4_000;

const discoveredRendezvous = (hostedRelayUrl: string | undefined): RelayCarrier | undefined => {
  if (hostedRelayUrl === undefined) return undefined;
  try {
    return daemonRelayCarrier({ kind: 'relay', relayUrl: hostedRelayUrl, operator: 'hosted' });
  } catch {
    return undefined;
  }
};

/**
 * Whether this app itself was opened on a loopback origin: a local build, on the machine whose loopback a link's
 * address may name. Read from the page, so a hosted app is never "local" whatever its address resolves to.
 */
const pageOnLoopback = (): boolean =>
  typeof location !== 'undefined' && typeof location.hostname === 'string' && isLoopbackHost(location.hostname);

/**
 * The publisher's own address goes first, unless it is LOOPBACK. A publisher that only answers on its own
 * loopback mints a share link only because it dials a rendezvous the reader can discover, and from the reader's
 * device that address names the reader's OWN computer: dialling it would stall the walk, could ask the reader
 * for local-network permission (a grant that then stays with the hosted origin), and could reach the reader's
 * own daemon — refused by the pinned fingerprint before the code leaves, but noise in that daemon's log. So
 * beside any rendezvous a loopback address is NOT dialled at all, unless this app was itself opened on loopback
 * (a local build, the one place that address can mean the publisher), where it is tried last. With no rendezvous
 * to try it is the only candidate, and is kept.
 */
const inWalkOrder = (
  direct: MemberCarrierMethod & { readonly kind: 'direct' },
  relays: readonly MemberCarrierMethod[],
  servedFromLoopback: boolean,
): readonly MemberCarrierMethod[] => {
  if (!isLoopbackLinkAddress(direct.daemonUrl) || relays.length === 0) return [direct, ...relays];
  return servedFromLoopback ? [...relays, direct] : relays;
};

/**
 * Every carrier a join walks, in §1's order: the publisher's own address, then the one rendezvous this
 * build discovered — for a loopback address, see {@link inWalkOrder}. A fingerprint this
 * protocol cannot address gets nothing, not even the direct address.
 */
export const joinCandidates = (
  seed: Pick<ShareLinkSeed, 'daemonId' | 'daemonUrl'>,
  hostedRelayUrl: string | undefined,
  servedFromLoopback: boolean = pageOnLoopback(),
): readonly MemberCarrierMethod[] => {
  if (parseDaemonId(seed.daemonId) === null) return [];
  const discovered = discoveredRendezvous(hostedRelayUrl);
  return inWalkOrder(
    { kind: 'direct', daemonUrl: seed.daemonUrl },
    discovered === undefined ? [] : [discovered],
    servedFromLoopback,
  );
};

/**
 * Every carrier a member session to an already-joined publisher may try: its own address, then whatever
 * relays it published, then the discovered rendezvous if none of those is it — for a loopback address, see
 * {@link inWalkOrder}. A tunnel is not a member carrier, and a published address is held to the
 * protocol's own rule before anything dials it.
 */
export const memberCandidates = (
  subscription: { readonly daemonId: string; readonly daemonUrl: string; readonly carriers: readonly DaemonCarrier[] },
  hostedRelayUrl: string | undefined,
  servedFromLoopback: boolean = pageOnLoopback(),
): readonly MemberCarrierMethod[] => {
  if (parseDaemonId(subscription.daemonId) === null) return [];
  const published = publishedConnectionMethods(subscription.carriers, hostedRelayUrl).filter(
    (method): method is MemberCarrierMethod => method.kind === 'direct' || method.kind === 'relay',
  );
  const rest = published.filter(method => !(method.kind === 'direct' && method.daemonUrl === subscription.daemonUrl));
  const discovered = discoveredRendezvous(hostedRelayUrl);
  const hasDiscovered = rest.some(method => method.kind === 'relay' && method.relayUrl === hostedRelayUrl);
  return inWalkOrder(
    { kind: 'direct', daemonUrl: subscription.daemonUrl },
    [...rest, ...(discovered === undefined || hasDiscovered ? [] : [discovered])],
    servedFromLoopback,
  );
};

export interface JoinAttemptOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly seed: ShareLinkSeed;
  readonly clientName: string;
  readonly method: MemberCarrierMethod;
  readonly keys: MintedMemberKeys;
  readonly key: PrivateKeyHandle;
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
  readonly deadlineMs?: number;
}

/**
 * The `join` record crossed, and the session ended before the publisher's sealed answer did. The share
 * may have been spent with nobody left to hear it, so a refusal after this is not the whole story.
 */
export class JoinOutcomeUnknownError extends Error {
  constructor(override readonly cause: unknown) {
    super('the share link reached the publisher, but the session ended before its answer arrived');
    this.name = 'JoinOutcomeUnknownError';
  }
}

/**
 * One join attempt over one carrier. Resolves with the publisher's `joined` response; rejects with
 * `RelayJoinRefusedError` when it refused inside the channel, `JoinOutcomeUnknownError` when the code
 * was sent and no answer came, and `RelaySessionError` when nothing reached it.
 */
export const joinInSession = async ({
  crypto,
  seed,
  clientName,
  method,
  keys,
  key,
  dial = browserRelayDial,
  heartbeat,
  deadlineMs = HEARTBEAT_GRACE_SECONDS * 1_000,
}: JoinAttemptOptions): Promise<MemberJoinedResponse> => {
  const url = connectionSocketUrl(method, seed.daemonId, 'client');
  if (url === null) {
    throw new RelaySessionError('this publisher fingerprint cannot address a session', RELAY_CLOSE_CODES.protocolError);
  }
  const socket = dial(url);
  const session = new RelayClientSession({
    crypto,
    daemonId: seed.daemonId,
    mode: { kind: 'join', code: seed.code, clientName, memberKey: keys.publicKey, boxKey: keys.boxKey, key },
    socket,
  });
  let outcome: Awaited<ReturnType<RelayClientSession['joined']>>;
  try {
    outcome = await driveRelaySession({
      socket,
      session,
      heartbeat: heartbeat ?? browserHeartbeat,
      settled: session.joined(),
      keepAlive: false,
      deadlineMs,
    });
  } catch (reason) {
    socket.close(1000, 'this join attempt is over');
    if (reason instanceof RelayJoinRefusedError || !session.credentialSent()) throw reason;
    throw new JoinOutcomeUnknownError(reason);
  }
  socket.close(1000, 'this join attempt is complete');
  return outcome.response;
};

export interface JoinPublisherOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'] & {
    deviceKeyHandle(key: CryptoKey): PrivateKeyHandle;
  };
  readonly seed: ShareLinkSeed;
  readonly clientName: string;
  readonly keys: MintedMemberKeys;
  readonly hostedRelayUrl: string | undefined;
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
  readonly directTimeoutMs?: number;
  /** The rendezvous leg's deadline. The heartbeat grace by default; a parameter so a suite can prove it in ms. */
  readonly relayTimeoutMs?: number;
  /** Whether this app was opened on loopback; read from the page by default (see `inWalkOrder`). */
  readonly servedFromLoopback?: boolean;
}

/** What walking every carrier came to. */
export type JoinResult =
  | { readonly kind: 'joined'; readonly response: MemberJoinedResponse; readonly carrier: MemberCarrierMethod }
  | { readonly kind: 'refused'; readonly maybeSpentUnheard: boolean }
  | { readonly kind: 'unreachable'; readonly maybeSpentUnheard: boolean; readonly tried: number };

/** Walks the carriers until one answers. Never throws for an outcome; only a transport problem is "unreachable". */
export const joinPublisher = async (options: JoinPublisherOptions): Promise<JoinResult> => {
  const key = options.crypto.deviceKeyHandle(options.keys.signingKey);
  const candidates = joinCandidates(options.seed, options.hostedRelayUrl, options.servedFromLoopback);
  let spentUnheard = false;
  for (const method of candidates) {
    try {
      const response = await joinInSession({
        crypto: options.crypto,
        seed: options.seed,
        clientName: options.clientName,
        method,
        keys: options.keys,
        key,
        ...(options.dial === undefined ? {} : { dial: options.dial }),
        ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
        ...(method.kind === 'direct'
          ? { deadlineMs: options.directTimeoutMs ?? DIRECT_JOIN_TIMEOUT_MS }
          : options.relayTimeoutMs === undefined
            ? {}
            : { deadlineMs: options.relayTimeoutMs }),
      });
      return { kind: 'joined', response, carrier: method };
    } catch (reason) {
      if (reason instanceof RelayJoinRefusedError) return { kind: 'refused', maybeSpentUnheard: spentUnheard };
      if (reason instanceof JoinOutcomeUnknownError) spentUnheard = true;
    }
  }
  return { kind: 'unreachable', maybeSpentUnheard: spentUnheard, tried: candidates.length };
};
