import type { RelayClientSession, RelayClientSocket } from '../session/session-client.ts';
import type { PrivateKeyHandle } from '../session/wire/index.ts';

/**
 * HOW A BROWSER REACHES A PUBLISHER IT IS NOT PAIRED WITH, AS A CATALOG MEMBER (Connections only; NOT IMPLEMENTED YET).
 *
 * A share link and a member session name a publisher this browser holds no pairing for, so the shell's per-daemon
 * client cannot carry them. Catalogs' app half runs the member records (`join`, `join-options`, the `/v1/shared/*`
 * requests) over a `RelayClientSession`; WHICH carriers it crosses, in what order and how a session is kept alive is
 * Connections' (§4.8), offered here. With no provider the half fails closed: every publisher is unreachable and
 * nothing is sent, so a share code is never spent.
 *
 * THE WALK (today's `relay-join.ts` `joinCandidates` / `memberCandidates` / `inWalkOrder`, lines 98–135):
 *  - a JOIN: the publisher's own address first, then the one rendezvous this build discovered (the hosted relay);
 *  - a MEMBER session: the publisher's own address, then each relay it published (a tunnel is not a member carrier;
 *    a published address is held to the protocol's own rule), then the discovered rendezvous if none of those is it;
 *  - a publisher fingerprint that is not a daemon id gets NO leg, not even the direct one;
 *  - a LOOPBACK publisher address names the reader's own computer: beside any rendezvous it is not dialled at all,
 *    unless the app itself was opened on loopback, where it goes last; alone, it is kept.
 *  - the direct leg's deadline is {@link DIRECT_MEMBER_DEADLINE_MS}; a relay leg's is the heartbeat grace.
 * Only a TRANSPORT failure advances the walk; a sealed refusal is final (carrying the same code to a second carrier
 * spends another guess to be told the same thing).
 *
 * THE DRIVE (today's `relay-carrier.ts`: `driveRelaySession` l.508, `relayTunnelRequest` l.350, `relayResponse` l.389,
 * `browserHeartbeat` l.189, `browserRelayDial`): `dial` opens the leg's socket, the caller builds the
 * `RelayClientSession` over it, and `drive` runs the heartbeat and the deadline until `settled` resolves.
 */

/** How long the publisher's own address may take before the walk moves on (today's `DIRECT_JOIN_TIMEOUT_MS`). */
export const DIRECT_MEMBER_DEADLINE_MS = 4_000;

/** What a publisher is, as a share link or a subscription names it. */
export interface MemberPublisher {
  readonly daemonId: string;
  readonly daemonUrl: string;
  /** The carriers it published (only on a member session; a join has none yet). */
  readonly carriers?: readonly { readonly kind: 'direct' | 'relay' | 'tunnel'; readonly url: string }[];
}

export type MemberPurpose = 'join' | 'member';

/** A socket a leg opened: the sealed session rides it. */
export interface MemberSocket extends RelayClientSocket {
  onOpen: (() => void) | null;
  onText: ((text: string) => void) | null;
  onBinary: ((bytes: Uint8Array) => void) | null;
  onClose: ((code: number, reason: string) => void) | null;
}

/** One carrier of the walk. */
export interface MemberLeg {
  readonly kind: 'direct' | 'relay';
  /** The publisher's own address, or the rendezvous. */
  readonly address: string;
  readonly deadlineMs: number;
  /** Opens this leg's socket, or throws when the carrier cannot address the publisher. */
  dial(): MemberSocket;
  /** Runs the heartbeat and the deadline over `session` until `settled` resolves (today's `driveRelaySession`). */
  drive<T>(options: {
    readonly socket: MemberSocket;
    readonly session: RelayClientSession;
    readonly settled: Promise<T>;
    readonly keepAlive: boolean;
    readonly deadlineMs?: number;
  }): Promise<T>;
}

/** What Connections offers a member session. */
export interface MemberCarriers {
  /** The legs to walk, in order; empty when the publisher cannot be addressed. */
  legs(
    publisher: MemberPublisher,
    purpose: MemberPurpose,
    options?: { readonly servedFromLoopback?: boolean },
  ): readonly MemberLeg[];
  /** An HTTP-shaped request as the tunnel record a member session carries (`relayTunnelRequest`). */
  tunnelRequest(url: string, init: RequestInit): unknown;
  /** The tunnel's answer as a `Response` (`relayResponse`). */
  tunnelResponse(answer: unknown): Response;
  /** The device-key handle the session signs with. */
  readonly deviceKeyHandle: (key: CryptoKey) => PrivateKeyHandle;
}

let offered: MemberCarriers | undefined;

/** The shell sets this once the providers are built; `undefined` while none is offered. */
export function setMemberCarriers(carriers: MemberCarriers | undefined): void {
  offered = carriers;
}

/** What Catalogs reads: the offered carriers, or `undefined` (fail closed). */
export function memberCarriers(): MemberCarriers | undefined {
  return offered;
}
