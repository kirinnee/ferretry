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
 * How a session ended: the close code and the one public reason a carrier may put on the wire (a relay's
 * `closed` control, a direct socket's close frame). Never a description of a holder; `4440` always carries the
 * shared "the session concluded", because the real outcome already crossed inside the channel.
 */
export interface SessionEnd {
  readonly code: number;
  readonly reason: string;
}

/** Whether a pull answered the end of the session rather than a frame. */
export function isSessionEnd(value: SealedFrame | SessionEnd): value is SessionEnd {
  return 'code' in value;
}

/**
 * The pull a carrier makes for the next outbound frame (§4.8, §7.3). The kernel re-asks the frame's permit inside
 * `next()`, synchronously, immediately before returning the bytes: a frame whose permit changed is dropped unsent,
 * its sequence number never spent, and the session ends. After the end, `next()` answers the same
 * {@link SessionEnd} every time.
 */
export interface SealedOutbound {
  next(): SealedFrame | SessionEnd | undefined;
  /** Called by the kernel when a frame (or the end) becomes available after `next()` answered `undefined`. */
  onReady(listener: () => void): () => void;
}

/** What a carrier hands the kernel for one remote peer: sealed bytes in, a pull for sealed bytes out. */
export interface CarrierLink {
  /** Delivers one inbound frame (exactly one; a carrier splits nothing and joins nothing). */
  inbound(bytes: Uint8Array): void;
  /** The pull for outbound sealed records. */
  readonly outbound: SealedOutbound;
  /** The peer went away. Nothing more is pulled or delivered. */
  closed(reason: string): void;
}

/** What a carrier may say about the peer of one link. Never makes the call local. */
export interface CarrierPeer {
  /** The peer's own address on a direct socket: the rate-limit identity. Absent: the session id is (R264). */
  readonly address?: string;
}

/**
 * The kernel side a carrier talks to: open a link per sealed session. A carrier that multiplexes (the relay's
 * rendezvous socket) opens one link per session it announces and routes each session's frames to it.
 */
export interface SessionLayer {
  open(carrier: CarrierKey, peer?: CarrierPeer): CarrierLink;
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

/** A pre-auth credential presented on a session: opaque to the kernel beyond `mode`, parsed by the mode. */
export interface ModeProof {
  readonly mode: string;
  readonly body: unknown;
}

/**
 * Who a session credential names, and the public key (Ed25519 SubjectPublicKeyInfo, base64url) that must have
 * signed this session's transcript. The KERNEL checks the signature (the device proof is the kernel's, §4.8)
 * and stamps the {@link SessionPrincipal}; a mode only says whose key it is.
 */
export interface ModeHolder {
  readonly holder: HolderId;
  readonly key: string;
}

/** What the kernel hands a mode about one verified session, so the mode can end it. */
export interface HolderWatch {
  readonly session: SessionId;
  /** The page-lifetime id the credential named (a step-up belongs to one). */
  readonly appSession: string;
  /** The holder was revoked, unpaired or idle-expired: the session ends with the one refusal (`4403`). */
  revoked(): void;
  /** The holder's key was replaced elsewhere: the session ends as a lapsed lease (`4441`) and reopens. */
  lapsed(): void;
  /** The holder's grants changed: an open stream is asked again and ends `1008` if no longer allowed. */
  regranted(): void;
}

/** One redemption of a one-time record (a pairing code, a share code), as the kernel hands it to the mode. */
export interface ModeRedemption {
  readonly proof: ModeProof;
  /**
   * The kernel's check of the record's own key proof over this session's transcript. The mode runs it AFTER its
   * own per-peer admission, so a limited stranger cannot make the daemon verify a signature first; a false is
   * refused exactly like a wrong code.
   */
  readonly prove: () => Promise<boolean>;
  readonly carrier: CarrierKey;
  /** The rate-limit identity of this attempt's peer (never chosen by the peer). */
  readonly peer: string;
}

/** A redemption that succeeded: the sealed outcome's `t` and the fields beside it (the mode's own shape). */
export interface ModeRedeemed {
  readonly outcome: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * A session mode (the value of the kernel's `session.modes` provide hook, §4.13): `device`, `pair`, `member`.
 *
 * The kernel keeps every pre-auth limit around every mode (pre-credential sessions, the credential deadline,
 * one credential per session, one attempt per redemption session, frame sizes and rates), so a mode cannot
 * loosen them. A mode that is off, failed or throws is treated as an unknown kind: every attempt gets the same
 * refusal (R605) and the kernel's `endMode` closes every session it verified.
 */
export interface SessionMode {
  readonly principalKind: 'device' | 'member' | 'none';
  /** The holder a credential names and its key; `undefined` for unknown, revoked or expired, all one refusal. Asked again at every lease renewal. */
  holder?(proof: ModeProof): Promise<ModeHolder | undefined>;
  /** Track a verified session; the release stops it. `undefined` refuses the session (the key went away meanwhile). */
  watch?(holder: HolderId, watch: HolderWatch): (() => void) | undefined;
  /** A person used the session (a request marked `presence`): the holder's idle clock moves. A renewal never calls it. */
  seen?(holder: HolderId): void;
  /** When the holder's key is due for replacement, told to it in the record that accepts the session. */
  rotateBy?(holder: HolderId): Instant | undefined;
  /** Redeems a one-time record (an invite, a pairing code); one attempt per session is the kernel's limit, not the mode's. */
  redeem?(attempt: ModeRedemption): Promise<ModeRedeemed | 'refused'>;
}
