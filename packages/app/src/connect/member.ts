import { isLoopbackHost } from '../release/loopback.ts';
import {
  type RelayClientSession,
  type RelayClientSocket,
  RelaySessionError,
  type RelayTunnelAnswer,
  type RelayTunnelClientMessage,
} from '../session/session-client.ts';
import { HEARTBEAT_GRACE_SECONDS, RELAY_CLOSE_CODES } from '../session/wire/constants.ts';
import { DaemonIdSchema } from '../session/wire/owner-payloads.ts';

/**
 * HOW A BROWSER REACHES A PUBLISHER IT IS NOT PAIRED WITH, AS A CATALOG MEMBER (Connections only; NOT IMPLEMENTED YET).
 *
 * A share link and a member session name a publisher this browser holds no pairing for, so the shell's per-daemon
 * client cannot carry them. Catalogs' app half runs the member records (`join`, `join-options`, the `/v1/shared/*`
 * requests) over a `RelayClientSession`. With no provider the half fails closed: every publisher is unreachable and
 * nothing is sent, so a share code is never spent.
 *
 * WHAT IS FIXED HERE, AND WHAT CONNECTIONS PROVIDES. Connections provides ONLY addressing and transport
 * ({@link MemberCarriers}): the discovered rendezvous address, a socket for an address, and the heartbeat that keeps a
 * session alive. Everything that decides what is SAFE is fixed in `@ferretry/app` and cannot be swapped:
 *  - the WALK ORDER ({@link memberWalk}, a pure function of the publisher, the page and the rendezvous);
 *  - the DEADLINES (set by the caller from {@link DIRECT_MEMBER_DEADLINE_MS} / {@link RELAY_MEMBER_DEADLINE_MS});
 *  - the TUNNEL RECORD and its answer ({@link memberTunnelRequest}, {@link memberTunnelResponse});
 *  - the device key handle (`WebCryptoRelayCrypto.deviceKeyHandle`) and the session, which the caller builds over the
 *    seed's own fingerprint, so the pin cannot move into a carrier;
 *  - the persisted publisher address, which is always the seed's or the subscription's own, never a step's address.
 * Only a TRANSPORT failure advances the walk; a sealed refusal is final (carrying the same code to a second carrier
 * spends another guess to be told the same thing).
 */

/** How long the publisher's own address may take before the walk moves on (today's `DIRECT_JOIN_TIMEOUT_MS`). */
export const DIRECT_MEMBER_DEADLINE_MS = 4_000;
/** How long a rendezvous may take to accept a session: the heartbeat grace. */
export const RELAY_MEMBER_DEADLINE_MS = HEARTBEAT_GRACE_SECONDS * 1_000;

/** What a publisher is, as a share link or a subscription names it. */
export interface MemberPublisher {
  readonly daemonId: string;
  readonly daemonUrl: string;
  /** The carriers it published (only on a member session; a join has none yet). */
  readonly carriers?: readonly { readonly kind: 'direct' | 'relay' | 'tunnel'; readonly url: string }[];
}

export type MemberPurpose = 'join' | 'member';

/** One carrier of the walk, with the deadline the CALLER holds it to. */
export interface MemberStep {
  readonly kind: 'direct' | 'relay';
  /** The publisher's own address, a published one, or the rendezvous. */
  readonly address: string;
  readonly deadlineMs: number;
}

const stepOf = (kind: MemberStep['kind'], address: string): MemberStep => ({
  kind,
  address,
  deadlineMs: kind === 'direct' ? DIRECT_MEMBER_DEADLINE_MS : RELAY_MEMBER_DEADLINE_MS,
});

/** Whether the app itself was opened on loopback (a local build): read from the page, never from an address. */
const pageOnLoopback = (): boolean =>
  typeof location !== 'undefined' && typeof location.hostname === 'string' && isLoopbackHost(location.hostname);

const loopbackAddress = (address: string): boolean => {
  try {
    return isLoopbackHost(new URL(address).hostname);
  } catch {
    return false;
  }
};

/** A published address held to the protocol's rule: https (http only on loopback) for a daemon, wss/https (ws/http on loopback) for a rendezvous; no query or fragment on a rendezvous. */
const dialable = (kind: MemberStep['kind'], address: string): boolean => {
  try {
    const url = new URL(address);
    const secure = kind === 'direct' ? url.protocol === 'https:' : url.protocol === 'wss:' || url.protocol === 'https:';
    const plain = kind === 'direct' ? url.protocol === 'http:' : url.protocol === 'ws:' || url.protocol === 'http:';
    if (!secure && !(plain && isLoopbackHost(url.hostname))) return false;
    return kind === 'direct' || (url.search === '' && url.hash === '');
  } catch {
    return false;
  }
};

/**
 * The carriers a join or a member session walks, in order. PURE and not pluggable (today's `joinCandidates`,
 * `memberCandidates` and `inWalkOrder`):
 *  - a JOIN: the publisher's own address first, then the one rendezvous this build discovered;
 *  - a MEMBER session: the publisher's own address, then each relay it published (a tunnel is not a member carrier; a
 *    published address is held to the protocol's own rule), then the discovered rendezvous if none of those is it;
 *  - a publisher fingerprint that is not a daemon id gets NO step, not even the direct one;
 *  - a LOOPBACK publisher address names the reader's own computer: beside any rendezvous it is not dialled at all,
 *    unless the app itself was opened on loopback, where it goes last; alone, it is kept.
 */
export function memberWalk(
  publisher: MemberPublisher,
  purpose: MemberPurpose,
  options: { readonly rendezvousUrl?: string | undefined; readonly servedFromLoopback?: boolean } = {},
): readonly MemberStep[] {
  if (!DaemonIdSchema.safeParse(publisher.daemonId).success) return [];
  const servedFromLoopback = options.servedFromLoopback ?? pageOnLoopback();
  const rendezvous =
    options.rendezvousUrl !== undefined && dialable('relay', options.rendezvousUrl) ? options.rendezvousUrl : undefined;
  const relays: MemberStep[] = [];
  const addRelay = (address: string): void => {
    if (!relays.some(relay => relay.address === address)) relays.push(stepOf('relay', address));
  };
  if (purpose === 'member') {
    for (const carrier of publisher.carriers ?? []) {
      if (carrier.kind === 'tunnel' || !dialable(carrier.kind, carrier.url)) continue;
      if (carrier.kind === 'relay') addRelay(carrier.url);
    }
  }
  if (rendezvous !== undefined) addRelay(rendezvous);
  const others: MemberStep[] = [];
  if (purpose === 'member') {
    for (const carrier of publisher.carriers ?? []) {
      if (carrier.kind !== 'direct' || carrier.url === publisher.daemonUrl || !dialable('direct', carrier.url))
        continue;
      if (!others.some(step => step.address === carrier.url)) others.push(stepOf('direct', carrier.url));
    }
  }
  const direct = stepOf('direct', publisher.daemonUrl);
  const rest = [...others, ...relays];
  if (!loopbackAddress(publisher.daemonUrl) || relays.length === 0) return [direct, ...rest];
  return servedFromLoopback ? [...rest, direct] : rest;
}

/** A request body this tunnel can carry. §14 records are JSON, so the body is text. */
const bodyText = (body: RequestInit['body']): string | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  // A silently dropped body would be a request that means something else.
  throw new RelaySessionError('a relayed request body must be text', RELAY_CLOSE_CODES.protocolError);
};

/**
 * Turn a request built for the publisher's address into the §14 record (today's `relayTunnelRequest`).
 * `authorization` IS DROPPED, not carried: a relayed request that brings its own credential is refused by §14.
 */
export function memberTunnelRequest(
  url: string,
  init: RequestInit = {},
): Omit<Extract<RelayTunnelClientMessage, { t: 'req' }>, 't' | 'id'> {
  const target = new URL(url);
  const headers: Record<string, string> = {};
  for (const [name, value] of new Headers(init.headers)) {
    if (name === 'authorization') continue;
    headers[name] = value;
  }
  const query = [...target.searchParams].map(([name, value]) => [name, value] as const);
  const body = bodyText(init.body);
  return {
    method: (init.method ?? 'GET').toUpperCase(),
    path: target.pathname,
    ...(query.length === 0 ? {} : { query }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

/** Statuses the `Response` constructor refuses a body for, because they have none. */
const BODYLESS_STATUSES: readonly number[] = [204, 205, 304];

/** The tunnel's answer as a `Response` (today's `relayResponse`). */
export function memberTunnelResponse(answer: RelayTunnelAnswer): Response {
  const bodyless = BODYLESS_STATUSES.includes(answer.status);
  return new Response(bodyless ? null : answer.body, { status: answer.status, headers: answer.headers });
}

/** A socket a carrier opened: the sealed session rides it. */
export interface MemberSocket extends RelayClientSocket {
  onOpen: (() => void) | null;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

/** What Connections offers a member session: addressing and transport, and nothing that decides what is safe. */
export interface MemberCarriers {
  /** The one rendezvous this build discovered (the hosted relay), or `undefined`. */
  readonly rendezvousUrl: string | undefined;
  /** Opens a socket to `address` on `kind`, or throws when the carrier cannot address it. */
  dial(kind: MemberStep['kind'], address: string): MemberSocket;
  /** Runs the heartbeat and the deadline over `session` until `settled` resolves (today's `driveRelaySession`). */
  drive<T>(options: {
    readonly kind: MemberStep['kind'];
    readonly socket: MemberSocket;
    readonly session: RelayClientSession;
    readonly settled: Promise<T>;
    readonly keepAlive: boolean;
    /** Set by the caller from the walk; a carrier holds the session to it and may not lengthen it. */
    readonly deadlineMs: number;
  }): Promise<T>;
}

let offered: MemberCarriers | undefined;

/**
 * The shell sets this once the providers are built (`main.tsx`); `undefined` while none is offered. NOT exported from
 * the `@ferretry/app` barrel: only the shell's own composition may set it, so no app half can install carriers.
 */
export function setMemberCarriers(carriers: MemberCarriers | undefined): void {
  offered = carriers;
}

/** What Catalogs reads: the offered carriers, or `undefined` (fail closed). */
export function memberCarriers(): MemberCarriers | undefined {
  return offered;
}
