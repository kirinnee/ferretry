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
  /**
   * The page-lifetime id the verified credential named (the same value as {@link HolderWatch.appSession}), stamped
   * ONLY by the session layer from the credential the mode verified. Read it here, never from a body, a header or
   * SDP (R684). Absent where no session credential named one.
   */
  readonly appSession?: string;
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
  /**
   * Called once by the kernel when a session mode accepted the holder's proof over this session's transcript
   * (a device's or a member's key): the moment the link stops being an unproven one. A direct carrier releases
   * its unproven slot here (today's direct mount: 16 unproven, 2 per remote peer, the oldest evicted). Never
   * called for a pairing or join session, nor for a refused proof.
   */
  readonly proved?: () => void;
}

/** A rendezvous challenge to answer (relay protocol §5, R46): the host the carrier dialled and its nonce. */
export interface RelayClaimRequest {
  /** The rendezvous host, exactly as the daemon's configured relay URL spells it (the carrier checks the match). */
  readonly host: string;
  /** The challenge nonce as it travelled: 32 bytes, unpadded base64url. */
  readonly nonce: string;
}

/** A signed claim, in its wire spelling. */
export interface SignedRelayClaim {
  readonly daemonId: string;
  /** The identity's Ed25519 SubjectPublicKeyInfo, base64url. */
  readonly publicKey: string;
  /** Ed25519 over the R46 transcript, base64url. */
  readonly signature: string;
}

/** A hosted-tunnel provisioning request to sign (relay protocol §15). */
export interface TunnelSignRequest {
  readonly action: 'provision' | 'release';
  /** The hosted service's host, as the daemon's discovered origin spells it. */
  readonly host: string;
  /** The service's challenge nonce: 32 bytes, unpadded base64url. */
  readonly nonce: string;
  /** The loopback port the tunnel forwards to (a provision); signed either way. */
  readonly originPort?: number;
}

/** A signed tunnel request, in its wire spelling. */
export interface SignedTunnelSignature {
  readonly daemonId: string;
  /** The identity's Ed25519 SubjectPublicKeyInfo, base64url. */
  readonly publicKey: string;
  /** The nonce signed, base64url. */
  readonly nonce: string;
  readonly signature: string;
}

/** A shared-catalog document to sign (docs/catalogs.md): its kind and its canonical (RFC 8785) JSON bytes. */
export interface CatalogSignRequest {
  readonly kind: 'manifest' | 'versions' | 'link';
  readonly canonical: Uint8Array;
}

/** A catalog signature, in its wire spelling (today's `spki` / `sig`). */
export interface SignedCatalogSignature {
  readonly daemonId: string;
  /** The identity's Ed25519 SubjectPublicKeyInfo, base64url. */
  readonly publicKey: string;
  /** Ed25519 over `label ‖ 0x00 ‖ SHA-256(canonical)`, base64url. */
  readonly signature: string;
}

/** A secret-import offer to sign (Vault): the fields the target publishes; the kernel adds its own id and key. */
export interface SecretOfferSignRequest {
  readonly v: number;
  readonly importId: string;
  /** The import's one-time X25519 public key, base64url. */
  readonly publicKey: string;
  readonly expiresAt: string;
}

/** What the kernel adds to an offer: the daemon id, the identity key (SPKI, base64url) and the signature. */
export interface SignedSecretOffer {
  readonly daemonId: string;
  readonly identityKey: string;
  readonly signature: string;
}

/**
 * The daemon identity as a carrier may use it: two signatures over transcripts the KERNEL builds, and nothing
 * else. There is no key export and no "sign these bytes": a carrier can only obtain a claim for a rendezvous
 * challenge or a tunnel request, each with its own label, so neither can be replayed as the other or as a
 * handshake signature. Refuses (throws `TypeError`) a malformed nonce, an empty host or a bad port.
 */
export interface IdentitySigner {
  /** R46: `ferretry-relay-claim-v1` ‖ LP(protocol) ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce). */
  sign(request: RelayClaimRequest): Promise<SignedRelayClaim>;
  /** `ferretry-tunnel-{provision,release}-v1` ‖ LP(protocol) ‖ LP(daemonId) ‖ LP(host) ‖ LP(nonce) ‖ LP(port|""). */
  signTunnel(request: TunnelSignRequest): Promise<SignedTunnelSignature>;
  /** `ferretry-catalog-{manifest,versions,link}-v1` ‖ 0x00 ‖ SHA-256(canonical): today's catalog signatures. */
  signCatalog(request: CatalogSignRequest): Promise<SignedCatalogSignature>;
  /** LP(`ferretry-secret-import-offer-v1`) ‖ LP(v) ‖ LP(importId) ‖ LP(daemonId) ‖ LP(identityKey) ‖ LP(publicKey) ‖ LP(expiresAt). */
  signSecretOffer(request: SecretOfferSignRequest): Promise<SignedSecretOffer>;
}

/**
 * One transport connection that carries several sessions (a relay rendezvous socket): the sessions opened on it share
 * ONE pre-credential bound (six awaiting a credential, today's per-link `MAX_PRE_CREDENTIAL_SESSIONS`), as today's
 * daemon kept one `RelayLink` per rendezvous connection.
 */
export interface CarrierConnection {
  open(peer?: CarrierPeer): CarrierLink;
}

/**
 * The kernel side a carrier talks to: open a link per sealed session. A carrier that multiplexes (the relay's
 * rendezvous socket) takes one {@link CarrierConnection} per socket and opens one link per session it announces on it.
 */
export interface SessionLayer {
  /**
   * One session on its own connection (a direct socket, a tunnel socket, a data channel): its pre-credential bound is
   * its own, so unproven peers on different sockets never crowd each other out (the carrier's own admission governs).
   */
  open(carrier: CarrierKey, peer?: CarrierPeer): CarrierLink;
  /** A connection that carries many sessions; the six-session pre-credential bound is per connection. */
  connection(carrier: CarrierKey): CarrierConnection;
  /** The daemon identity's claim and tunnel signer, shared by every carrier; the key never leaves the kernel. */
  readonly signer: IdentitySigner;
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
