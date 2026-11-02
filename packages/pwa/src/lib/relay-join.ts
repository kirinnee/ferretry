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
  type JoinProofOptions,
  type MemberJoinedResponse,
  type MemberJoinProof,
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
  /** One of the person's passkeys signing the publisher's challenge; absent on a first join. */
  readonly passkey?: MemberJoinProof;
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
  passkey,
}: JoinAttemptOptions): Promise<MemberJoinedResponse> => {
  const url = connectionSocketUrl(method, seed.daemonId, 'client');
  if (url === null) {
    throw new RelaySessionError('this publisher fingerprint cannot address a session', RELAY_CLOSE_CODES.protocolError);
  }
  const socket = dial(url);
  const session = new RelayClientSession({
    crypto,
    daemonId: seed.daemonId,
    mode: {
      kind: 'join',
      code: seed.code,
      clientName,
      memberKey: keys.publicKey,
      boxKey: keys.boxKey,
      key,
      ...(passkey === undefined ? {} : { passkey }),
    },
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
  // Only a `joined` answers a `join`: the session refuses any other shape before it gets here.
  return (outcome as Extract<typeof outcome, { kind: 'joined' }>).response;
};

/** The publisher closed with `4400` on the `join-options` record: it is older than the question. */
export class JoinOptionsUnknownError extends Error {
  constructor(override readonly cause: unknown) {
    super('the publisher does not know join-options');
    this.name = 'JoinOptionsUnknownError';
  }
}

/** What the publisher said joining with this code needs. */
export type JoinOptionsAnswer =
  | { readonly kind: 'open'; readonly why: 'first-browser' | 'owner-approved' }
  | { readonly kind: 'challenge'; readonly memberLabel: string; readonly options: JoinProofOptions };

export interface JoinOptionsAttemptOptions {
  readonly crypto: RelayClientSessionDependencies['crypto'];
  readonly seed: ShareLinkSeed;
  readonly origin: string;
  readonly method: MemberCarrierMethod;
  readonly keys: MintedMemberKeys;
  readonly key: PrivateKeyHandle;
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
  readonly deadlineMs?: number;
}

/**
 * One `join-options` attempt over one carrier: what joining with this code needs, asked without spending it.
 * Rejects with `RelayJoinRefusedError` when the publisher refused inside the channel and `RelaySessionError` otherwise
 * (an older publisher closes with `4400` on the record it does not know).
 */
export const joinOptionsInSession = async ({
  crypto,
  seed,
  origin,
  method,
  keys,
  key,
  dial = browserRelayDial,
  heartbeat,
  deadlineMs = HEARTBEAT_GRACE_SECONDS * 1_000,
}: JoinOptionsAttemptOptions): Promise<JoinOptionsAnswer> => {
  const url = connectionSocketUrl(method, seed.daemonId, 'client');
  if (url === null) {
    throw new RelaySessionError('this publisher fingerprint cannot address a session', RELAY_CLOSE_CODES.protocolError);
  }
  const socket = dial(url);
  const session = new RelayClientSession({
    crypto,
    daemonId: seed.daemonId,
    mode: { kind: 'join-options', code: seed.code, memberKey: keys.publicKey, origin, key },
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
    socket.close(1000, 'this join-options attempt is over');
    if (
      session.credentialSent() &&
      reason instanceof RelaySessionError &&
      reason.code === RELAY_CLOSE_CODES.protocolError
    ) {
      throw new JoinOptionsUnknownError(reason);
    }
    throw reason;
  }
  socket.close(1000, 'this join-options attempt is complete');
  // Only `join-open` or `join-challenge` answers a `join-options`: the session refuses any other shape.
  return outcome as JoinOptionsAnswer;
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
  /** One of the person's passkeys signing the publisher's challenge; absent on a first join. */
  readonly passkey?: MemberJoinProof;
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
        ...(options.passkey === undefined ? {} : { passkey: options.passkey }),
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

export interface JoinOptionsWalkOptions {
  readonly crypto: JoinPublisherOptions['crypto'];
  readonly seed: ShareLinkSeed;
  readonly origin: string;
  readonly keys: MintedMemberKeys;
  readonly hostedRelayUrl: string | undefined;
  readonly dial?: RelayDial;
  readonly heartbeat?: RelayHeartbeatSchedule;
  readonly directTimeoutMs?: number;
  readonly relayTimeoutMs?: number;
  readonly servedFromLoopback?: boolean;
}

/** What asking every carrier what a join needs came to. `older` is a publisher that does not know the question. */
export type JoinOptionsResult =
  | { readonly kind: 'answer'; readonly answer: JoinOptionsAnswer; readonly carrier: MemberCarrierMethod }
  | { readonly kind: 'refused' }
  | { readonly kind: 'older' }
  | { readonly kind: 'unreachable' };

/**
 * Asks the carriers, in the join's order, what joining with this code needs. Each ask is its own session and spends
 * nothing. Only a TRANSPORT failure advances the walk; a sealed refusal is final, and a publisher that closes with
 * `4400` on the record (it does not know `join-options`) ends it as `older`, so the app joins as it always did.
 */
export const askJoinOptions = async (options: JoinOptionsWalkOptions): Promise<JoinOptionsResult> => {
  const key = options.crypto.deviceKeyHandle(options.keys.signingKey);
  const candidates = joinCandidates(options.seed, options.hostedRelayUrl, options.servedFromLoopback);
  for (const method of candidates) {
    try {
      const answer = await joinOptionsInSession({
        crypto: options.crypto,
        seed: options.seed,
        origin: options.origin,
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
      return { kind: 'answer', answer, carrier: method };
    } catch (reason) {
      if (reason instanceof RelayJoinRefusedError) return { kind: 'refused' };
      if (reason instanceof JoinOptionsUnknownError) return { kind: 'older' };
    }
  }
  return { kind: 'unreachable' };
};
