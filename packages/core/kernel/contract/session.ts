import type { Instant } from '@ferretry/std';
import type { CarrierKey, HolderId, SessionId } from './ids.ts';

/**
 * The session layer's protocol number (§9.6). Covers the sealed session, its records and its modes only;
 * a change to any plugin's wire is that plugin's contract hash, never this. `GET /v1/health` returns it.
 */
export const PROTOCOL = 1 as const;
export type Protocol = typeof PROTOCOL;

/**
 * Who a sealed session belongs to, stamped by the KERNEL after a session mode verified the holder's key over this
 * session's transcript (§4.13, §7.1). No header, body, route or plugin can construct one; it carries no key, token
 * or digest. Gate takes it as the credential of a device or member call.
 *
 * Lives in the kernel leaf (not Gate's contract, where §7.1 sketches it) because the kernel mints it and the kernel
 * imports no core contract; Gate re-exports it.
 */
export interface SessionPrincipal {
  readonly kind: 'device' | 'member';
  readonly holder: HolderId;
  readonly session: SessionId;
  /** The access lease (15 min from proof, renewed; R241). */
  readonly leaseUntil: Instant;
}

declare const localArrivalBrand: unique symbol;

/**
 * Arrived through the kernel's own listener (Unix socket or loopback port). Only the kernel constructs one, so no
 * carrier can mark a call local (§4.8): relayed loopback is remote. The brand symbol is not exported.
 */
export interface LocalArrival {
  readonly kind: 'local';
  /** Today's `privilegedLoopback`: arrived through the privileged local listener. */
  readonly privileged: boolean;
  readonly [localArrivalBrand]: true;
}

/** Arrived through a carrier (direct, relay, tunnel, webrtc): sealed, never local. */
export interface CarriedArrival {
  readonly kind: 'carried';
  readonly carrier: CarrierKey;
}

/** How a call arrived; today's `loopback` / `privilegedLoopback` / `carrier` folded into one value. */
export type Arrival = LocalArrival | CarriedArrival;

/** One sealed frame handed to a carrier. Opaque bytes; the carrier never opens them. */
export interface SealedFrame {
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

/**
 * The pull a carrier makes for the next outbound frame (§4.8, §7.3). The kernel re-asks the frame's permit inside
 * `next()`, synchronously, immediately before returning the bytes: a frame whose permit changed is dropped unsent,
 * its sequence number never spent, and the session ends.
 */
export interface SealedOutbound {
  next(): SealedFrame | 'ended' | undefined;
  /** Called by the kernel when a frame becomes available after `next()` answered `undefined`. */
  onReady(listener: () => void): () => void;
}

/** What a carrier hands the kernel for one remote peer: sealed bytes in, a pull for sealed bytes out. */
export interface CarrierLink {
  /** Delivers one inbound sealed record to the session layer. */
  inbound(bytes: Uint8Array): void;
  /** The pull for outbound sealed records. */
  readonly outbound: SealedOutbound;
  /** The peer went away. */
  closed(reason: string): void;
}

/** The kernel side a carrier talks to: open a link per peer. */
export interface SessionLayer {
  open(carrier: CarrierKey): CarrierLink;
}

/**
 * A carrier (the value of the kernel's `carriers` provide hook). Moves sealed bytes only; cannot mark a call local;
 * the last check is the kernel's. Every carrier passes the carrier conformance suite in `@ferretry/kernel/testing`.
 */
export interface Carrier {
  start(layer: SessionLayer, signal: AbortSignal): Promise<void>;
  /** What the owner sees about this carrier (no secret, no token). */
  status(): CarrierStatus;
}

export interface CarrierStatus {
  readonly state: 'off' | 'starting' | 'ready' | 'failed';
  readonly sentence: string;
}

/** A pre-auth proof presented on a session: opaque to the kernel, parsed by the mode. */
export interface ModeProof {
  readonly mode: string;
  readonly body: unknown;
}

/**
 * A session mode (the value of the kernel's `session.modes` provide hook, §4.13): `device`, `pair`, `member`.
 * `verify` checks the holder's non-extractable key over this session's transcript and returns the holder id, nothing
 * else; the kernel stamps the {@link SessionPrincipal}. The kernel keeps the pre-auth limits around every mode.
 */
export interface SessionMode {
  readonly principalKind: 'device' | 'member' | 'none';
  verify(proof: ModeProof, transcriptHash: Uint8Array): Promise<HolderId | 'refused'>;
  /** Redeems a one-time record (an invite); one redemption per code is the kernel's limit, not the mode's. */
  redeem?(proof: ModeProof, transcriptHash: Uint8Array): Promise<{ readonly holder: HolderId } | 'refused'>;
}
