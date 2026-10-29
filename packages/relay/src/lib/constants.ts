/**
 * Every constant the wire format pins, in one place, because a reimplementation in another
 * language has to agree with all of them exactly.
 *
 * Domain-separation labels are spelled out in full rather than composed from a prefix: a label is
 * a cryptographic input, and a template that quietly changes when a version bumps produces two
 * peers that derive different keys and blame the network.
 */

/** Wire identifier carried in the rendezvous claim so a peer can refuse an unknown dialect. */
export const RELAY_PROTOCOL_ID = 'ferretry-relay/1' as const;

/**
 * The END-TO-END dialect: the handshake and every sealed tunnel record carry this, never the claim.
 *
 * It moved to `/2` when the client started proving a device key, and the rendezvous identifier above
 * deliberately did NOT: nothing a relay parses changed, so no deployed relay has to be replaced and
 * none can tell the two dialects apart. A peer speaking the other end-to-end dialect is refused at the
 * handshake with `4426` — there is no negotiation and nothing older to fall back to.
 */
export const SESSION_PROTOCOL_ID = 'ferretry-relay/2' as const;

/** The end-to-end dialect a pre-device-key peer speaks, recognised only to refuse it in words. */
export const PREVIOUS_SESSION_PROTOCOL_ID = 'ferretry-relay/1' as const;

/** First byte of every frame. Not ASCII, so a text frame accidentally sent here fails loudly. */
export const FRAME_MAGIC = 0xfe as const;

/** Second byte of every frame. A peer that does not know this version closes rather than guesses. */
export const FRAME_VERSION = 0x01 as const;

/** Fixed header length: magic, version, kind, reserved, session id, sequence. */
export const FRAME_HEADER_BYTES = 28 as const;

/** Length of the opaque session identifier a client mints for one end-to-end conversation. */
export const SESSION_ID_BYTES = 16 as const;

/** Length of every challenge, hello and handshake nonce. */
export const NONCE_BYTES = 32 as const;

/** X25519 public keys and shared secrets, and the AEAD key derived from them. */
export const X25519_PUBLIC_KEY_BYTES = 32 as const;
export const SHARED_SECRET_BYTES = 32 as const;
export const AEAD_KEY_BYTES = 32 as const;
export const AEAD_NONCE_BYTES = 12 as const;
export const AEAD_TAG_BYTES = 16 as const;

/** Ed25519 material: a 44-byte SPKI encoding of the public key and a 64-byte signature. */
export const ED25519_SPKI_BYTES = 44 as const;
export const ED25519_SIGNATURE_BYTES = 64 as const;

/**
 * Largest frame any carrier accepts, header included.
 *
 * It bounds a hostile peer's memory cost per frame, and together with the credit window it bounds
 * everything a rendezvous can be holding for one session at once.
 */
export const MAX_FRAME_BYTES = 65_536 as const;

/** Largest plaintext one data frame can carry, after the header and the AEAD tag are paid for. */
export const MAX_PLAINTEXT_BYTES = MAX_FRAME_BYTES - FRAME_HEADER_BYTES - AEAD_TAG_BYTES;

/**
 * Frames a sender may have outstanding before the receiver grants more.
 *
 * The rendezvous never queues: it forwards a frame or it closes the session. So the worst case it
 * can be holding in one direction is this window times {@link MAX_FRAME_BYTES} — two mebibytes —
 * and a producer that ignores the window is a protocol violation rather than unbounded memory.
 */
export const CREDIT_WINDOW_FRAMES = 32 as const;

/** Concurrent client sessions one rendezvous will carry. Beyond this it refuses rather than evicts. */
export const MAX_SESSIONS_PER_RENDEZVOUS = 8 as const;

/** How often each socket must be heard from, and how long the rendezvous waits before evicting it. */
export const HEARTBEAT_SECONDS = 30 as const;
export const HEARTBEAT_GRACE_SECONDS = 45 as const;

/**
 * The heartbeat, and the one exception to "everything on this wire is a binary frame".
 *
 * These two are text, matched byte for byte, because that is what Cloudflare's WebSocket
 * auto-responder can answer without waking the Durable Object. A heartbeat that woke the object
 * every thirty seconds would defeat hibernation, and an idle rendezvous would stop being free.
 */
export const HEARTBEAT_REQUEST = 'fy-ping' as const;
export const HEARTBEAT_RESPONSE = 'fy-pong' as const;

/** How long an unclaimed daemon socket may sit on a challenge before the rendezvous drops it. */
export const CLAIM_DEADLINE_SECONDS = 10 as const;

/**
 * Unproved daemon sockets one rendezvous will hold at once.
 *
 * A fingerprint is public, so anybody who saw a QR code can open the daemon route. They cannot
 * claim it, but they can occupy it, so the number of sockets waiting to prove themselves is capped
 * well below the number a single honest daemon needs — which is one, with a second only while a
 * reconnection overlaps an old socket.
 */
export const MAX_PENDING_DAEMON_SOCKETS = 4 as const;

/**
 * Socket arrivals one rendezvous accepts in {@link CONNECTION_RATE_WINDOW_SECONDS}, PER ROLE: clients
 * share one window and the daemon has its own, so retrying clients can never lock the daemon out.
 *
 * A relay only ever serves the fingerprints its deployer listed, so this is not abuse policing —
 * it is the bound that stops a known fingerprint, leaked or misconfigured, from turning into an
 * open-ended bill. Reconnection after a dropped network is a handful of attempts, not thirty.
 */
export const CONNECTION_RATE_LIMIT = 30 as const;
export const CONNECTION_RATE_WINDOW_SECONDS = 60 as const;

/**
 * Highest sequence number a direction may reach.
 *
 * The AEAD nonce is the sequence number, so reuse would be catastrophic. Rather than rekey, a
 * session that reaches this ends: at the maximum frame size it is 256 tebibytes of traffic, which
 * no interactive session approaches, and ending is the option with no failure mode.
 */
export const MAX_FRAME_SEQUENCE = 0xffff_ffff as const;

/**
 * The sequence number of the handshake frame in each direction.
 *
 * Handshake frames are cleartext but they belong to the end-to-end stream, so they consume a
 * sequence number like anything else. One counter per direction across both kinds is what lets a
 * receiver notice that the frame it lost was the handshake rather than a record.
 */
export const HANDSHAKE_FRAME_SEQUENCE = 0 as const;

/** Signed by the daemon to prove it may claim a rendezvous under its own fingerprint. */
export const CLAIM_SIGNATURE_LABEL = 'ferretry-relay-claim-v1' as const;

/** Hashed over the handshake transcript both peers reconstruct independently. */
export const HANDSHAKE_TRANSCRIPT_LABEL = 'ferretry-relay-handshake-v2' as const;

/** Signed by the daemon over the handshake transcript hash, binding its identity to the ephemerals. */
export const HANDSHAKE_SIGNATURE_LABEL = 'ferretry-relay-daemon-auth-v2' as const;

/** HKDF info strings for the two directional record keys. */
export const CLIENT_TO_DAEMON_KEY_LABEL = 'ferretry-relay-c2d-v2' as const;
export const DAEMON_TO_CLIENT_KEY_LABEL = 'ferretry-relay-d2c-v2' as const;

/**
 * Signed by the DEVICE key over a session's transcript hash, so the daemon learns which device holds
 * this channel. One label per act, so a proof made to open a session can never be presented as one
 * that registers a key or renews a lease.
 */
export const DEVICE_AUTH_LABEL = 'ferretry-device-auth-v2' as const;
export const DEVICE_PAIR_LABEL = 'ferretry-device-pair-v2' as const;
export const DEVICE_RENEW_LABEL = 'ferretry-device-renew-v2' as const;
/** Signed by the NEW key when a device replaces its key inside a session the old one opened. */
export const DEVICE_ROTATE_LABEL = 'ferretry-device-rotate-v2' as const;

/** Random bytes naming one running copy of the app; a step-up belongs to one of these. */
export const APP_SESSION_BYTES = 16 as const;

/**
 * What a daemon may ask a rendezvous for beyond `ferretry-relay/1`, and the query parameter it asks in.
 *
 * Every control message is a strict shape, so a peer that sends one the other side does not know gets
 * its socket closed. A feature is therefore never ASSUMED: the daemon names the ones it speaks in the
 * daemon route's query string, which an older rendezvous ignores; a rendezvous that speaks one echoes it
 * in `claimed`, which it only ever sends to a daemon that asked; and neither side uses a feature the
 * other did not name. Old daemon and new relay, or new daemon and old relay, both stay on plain `/1`.
 */
export const RELAY_FEATURES_PARAM = 'features' as const;

/**
 * `claim-probe`: the daemon asks the rendezvous's OWN code whether this socket still holds the claim.
 *
 * `fy-ping` cannot answer that. It is answered by Cloudflare's auto-responder, which consults neither
 * the stored rendezvous state nor the object's code, so a daemon whose claim the state no longer names
 * kept passing every heartbeat for sixteen minutes while every phone was told `4404`.
 *
 * `claim-handover`: a daemon whose socket dropped reclaims its OWN rendezvous at once.
 *
 * Without it a daemon that redials after a drop that never reached the rendezvous is refused `4409`
 * until the sweep evicts the dead socket — up to the heartbeat grace window. With it, `claimed` carries a
 * `handover` token, and a verified claim that names it in `replaces` supersedes the socket it was issued
 * to. The token travels only over the holder's own TLS socket, so a second copy of the key never holds it.
 */
export const RELAY_FEATURES = ['claim-probe', 'claim-handover'] as const;
export type RelayFeature = (typeof RELAY_FEATURES)[number];

/** Random bytes in a `claim-handover` token: unguessable, and only ever sent over the holder's own socket. */
export const HANDOVER_TOKEN_BYTES = 32 as const;

/**
 * WebSocket close codes.
 *
 * The 4000-4999 range is reserved for applications, so these never collide with a protocol-level
 * code. Each names one refusal; there is deliberately no generic "closed" that a caller could read
 * as success.
 */
export const RELAY_CLOSE_CODES = {
  /** The peer sent something this version cannot parse, or sent it in the wrong state. */
  protocolError: 4400,
  /** A rendezvous claim did not match the fingerprint in the path, or its signature failed. */
  claimRejected: 4401,
  /** A daemon socket held the route without proving itself before the claim deadline. */
  claimTimeout: 4402,
  /** The daemon refused the client's credentials inside the encrypted channel. */
  authRejected: 4403,
  /** No daemon holds this rendezvous, so there is nobody to talk to. */
  daemonAbsent: 4404,
  /** The socket stopped answering heartbeats within the grace window. */
  heartbeatTimeout: 4408,
  /**
   * This daemon socket is attached but the rendezvous no longer holds its claim. Claim again at once:
   * the socket is live, so the only thing wrong is the slot, and a fresh claim restores it.
   */
  claimLost: 4410,
  /** A second daemon claimed a rendezvous an authenticated daemon already holds. */
  rendezvousClaimed: 4409,
  /** A frame exceeded {@link MAX_FRAME_BYTES}. */
  frameTooLarge: 4413,
  /** A sequence number arrived out of order, so frames were dropped, duplicated or injected. */
  sequenceBroken: 4420,
  /** A record failed authentication: something on the path altered it or made it up. */
  frameForged: 4421,
  /** Version or protocol identifier this endpoint does not speak. */
  versionUnsupported: 4426,
  /** Too many sessions, too many unproved sockets, or too many arrivals in the rate window. */
  rendezvousBusy: 4429,
  /** A sender exceeded its credit window. */
  flowViolation: 4430,
  /** The operator disabled the hosted relay through its runtime kill switch. */
  hostedDisabled: 4431,
  /** A per-daemon or account-wide hosted connection ceiling was reached. */
  hostedCapacity: 4432,
  /** A per-daemon or account-wide hosted bandwidth ceiling was reached. */
  hostedBandwidth: 4433,
  /** The rendezvous itself failed. */
  relayInternal: 4500,
} as const;

export type RelayCloseCode = (typeof RELAY_CLOSE_CODES)[keyof typeof RELAY_CLOSE_CODES];
