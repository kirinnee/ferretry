/**
 * THE DIRECT CARRIER: the same session, over one WebSocket to this daemon's own listener.
 *
 * `docs/relay-protocol.md` §1 and §3 always said a direct conversation and a relayed one are
 * byte-for-byte the same above the socket. Until device keys, "direct" was really plain HTTP with a
 * bearer header — on a LAN, usually over `http://`, in the clear. This module makes the document true:
 * a browser that can reach this daemon opens `/v1/rendezvous/<daemonId>/client` here, and the socket
 * runs the very {@link RelayLink} a rendezvous socket runs — same handshake against the pinned
 * fingerprint, same device proof, same lease, same records. So the LAN is encrypted end to end and a
 * device never presents anything a sniffer could replay (`docs/design/zero-trust.md` A3).
 *
 * ONE SOCKET IS ONE SESSION. There is no rendezvous to multiplex, so this module plays the
 * rendezvous's two session-level parts and nothing more: it mints the session identifier and tells the
 * client `ready`, exactly as a rendezvous would, and it turns the link's `closed` for that session into
 * the socket's close. It never sends a `challenge` and never accepts a `claim`, and a client that sends
 * ANY control frame is refused — on a direct socket nobody speaks for a rendezvous.
 *
 * LOCALITY IS THE LISTENER'S ANSWER. The upgrade request was classified by the transport exactly as an
 * HTTP request on the same listener is, and that classification becomes the link's
 * {@link SessionArrival}. A browser on the host is host-local here precisely when it would have been
 * over plain HTTP — never because of anything it sent inside the session.
 */

import {
  type DaemonIdentity,
  decodeControlMessage,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  RELAY_CLOSE_CODES,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  type RelayCrypto,
  SESSION_ID_BYTES,
  type SessionId,
  sessionIdFromBytes,
} from '@ferretry/relay';
import type { SocketDownstream, SocketEnded, SocketFrame, SocketHandler } from '../api/socket.ts';
import type { DeviceConnectionTracker } from '../pairing/index.ts';
import type { RelayMemberSessions } from './member-port.ts';
import {
  type AccessLeasePolicy,
  type RelayApiDispatch,
  type RelayDeviceDirectory,
  RelayLink,
  type RelayLinkClock,
  type RelayLinkScheduler,
  type RelayPairingRedeemer,
  type RelayStreamDispatch,
} from './link.ts';
import type { SessionArrival } from './tunnel.ts';

/**
 * How many direct sessions this daemon carries at once.
 *
 * Each one is a socket somebody who can reach the listener opened, and each holds a pre-credential
 * slot for up to ten seconds before it must prove a device. A browser tab holds three (requests, the
 * event feed, one terminal), so this is room for a household of tabs while still bounding what a
 * stranger on the network can make this daemon hold.
 */
export const MAX_DIRECT_SESSIONS = 64;

/**
 * How many of those may be sockets that have not proved a device yet.
 *
 * Counted apart so a stranger who can reach the listener cannot starve the devices that can prove
 * themselves: unproven sockets are the cheap ones to open, and each holds a slot for up to ten seconds.
 * Sixteen admits a household's burst of tabs reconnecting at once. When they are all taken, the OLDEST
 * is evicted rather than the newcomer refused, so a squatter must out-race honest arrivals — which prove
 * themselves in milliseconds — instead of merely arriving first.
 */
export const MAX_DIRECT_UNPROVEN_SESSIONS = 16;

/** How many upgrades one peer may make in one window, before any crypto runs for it. */
export const DIRECT_UPGRADES_PER_PEER = 30;

/**
 * How many unproven sockets one REMOTE peer may hold at once. Without it, two addresses could keep
 * every unproven slot full. A loopback peer is exempt: every tab on the host shares one address.
 */
export const MAX_DIRECT_UNPROVEN_PER_PEER = 2;

/** The close an evicted unproven socket gets. Constant, and about this daemon, never the peer. */
export const EVICTED_REASON = 'too many sessions are awaiting a credential';
export const DIRECT_UPGRADE_WINDOW_MS = 60_000;

export interface DirectCarrierDependencies {
  readonly crypto: RelayCrypto;
  readonly identity: DaemonIdentity;
  readonly dispatch: RelayApiDispatch;
  readonly sockets: RelayStreamDispatch;
  readonly devices: RelayDeviceDirectory;
  readonly pairing: RelayPairingRedeemer;
  /** The member side; absent means a daemon with none, which refuses every join and knows no key. */
  readonly members?: RelayMemberSessions;
  readonly scheduler: RelayLinkScheduler;
  readonly clock: RelayLinkClock;
  /** The lease and its cap; absent means the protocol's own (`DEFAULT_ACCESS_LEASE_POLICY`). */
  readonly lease?: AccessLeasePolicy;
  readonly connections: DeviceConnectionTracker;
  /**
   * Where a TUNNEL session's life is reported (`docs/relay-protocol.md` §15, "What the daemon logs").
   * Absent means nothing is logged. Only a session whose arrival carries the tunnel marker is reported:
   * a tab on the host opening and closing sessions all day is not news, and a phone behind Cloudflare
   * dropping one is what an owner asks about.
   */
  readonly sessionLog?: DirectSessionLog;
}

/** One session's life, once it is over. Counts and timings only: never a key, a device or an address. */
export interface DirectSessionEnd {
  /** Who ended it: the far end (or the network, `1006`), or this daemon. */
  readonly by: 'peer' | 'daemon';
  /** The close code, when one is known. A peer that vanished is `1006`; a shutdown has none. */
  readonly code: number | undefined;
  readonly reason: string;
  readonly durationMs: number;
  /** How long before the end the last client frame arrived — a ping counts. */
  readonly lastFrameAgeMs: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** Whether a device proved itself on it: an unproven session is a probe, a refusal or a scan. */
  readonly proved: boolean;
}

export interface DirectSessionLog {
  opened(): void;
  closed(end: DirectSessionEnd): void;
}

/** A frame as bytes, or `null` for one that is not binary — which only a heartbeat may be. */
function frameBytes(frame: SocketFrame): Uint8Array | null {
  if (typeof frame === 'string') return null;
  if (frame instanceof ArrayBuffer) return new Uint8Array(frame);
  return new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
}

/** One direct socket: one link carrying exactly one session. */
export class DirectSession implements SocketHandler {
  readonly #sessionId: SessionId;
  readonly #link: RelayLink;
  #inbox: Promise<void> = Promise.resolve();
  #ended = false;
  /** Where this session's life is reported — only for a tunnel arrival — and what is reported. */
  readonly #log: DirectSessionLog | undefined;
  readonly #clock: RelayLinkClock;
  readonly #openedAt: number;
  #lastFrameAt: number;
  #bytesIn = 0;
  #bytesOut = 0;
  #proved = false;
  /** Set when THIS daemon ended the socket, before the transport reports the close back. */
  #endedHere: { readonly code: number; readonly reason: string } | undefined;

  constructor(
    deps: DirectCarrierDependencies,
    arrival: SessionArrival | undefined,
    private readonly downstream: SocketDownstream,
    private readonly release: () => void,
    /** Called once, when this socket's session first proves a device. */
    onProved: () => void = () => undefined,
  ) {
    const sessionId = sessionIdFromBytes(deps.crypto.randomBytes(SESSION_ID_BYTES));
    if (sessionId === null) throw new Error('the session identifier generator produced an unusable identifier');
    this.#sessionId = sessionId;
    this.#log = arrival?.carrier === 'tunnel' ? deps.sessionLog : undefined;
    this.#clock = deps.clock;
    this.#openedAt = deps.clock.now();
    this.#lastFrameAt = this.#openedAt;
    const { members } = deps;
    this.#link = new RelayLink({
      crypto: deps.crypto,
      identity: deps.identity,
      // No rendezvous host exists on a direct socket, and nothing here ever asks the link to sign a
      // claim: a client's control frame is refused before it reaches the link.
      relayHost: '',
      socket: {
        send: bytes => this.#fromLink(bytes),
        sendText: text => {
          if (this.#ended) return;
          this.#bytesOut += text.length;
          this.downstream.send(text);
        },
        close: (code, reason) => this.#end(code, reason),
      },
      dispatch: deps.dispatch,
      sockets: deps.sockets,
      devices: deps.devices,
      pairing: deps.pairing,
      ...(members === undefined
        ? {}
        : {
            members: {
              join: (attempt, carrier) => members.join(attempt, carrier),
              key: keyId => members.key(keyId),
              dispatch: request => members.dispatch(request),
              // A member's key proven is the moment this socket stops being an unproven one, as a device's is.
              open: async (member, end) => {
                const release = await members.open(member, end);
                if (release !== undefined) {
                  this.#proved = true;
                  onProved();
                }
                return release;
              },
            },
          }),
      scheduler: deps.scheduler,
      clock: deps.clock,
      ...(deps.lease === undefined ? {} : { lease: deps.lease }),
      // Seen on the way through: a device's proof is registered here first, which is the moment this
      // socket stops being an unproven one.
      connections: {
        track: (deviceId, end, appSession, recheck, lapse) => {
          this.#proved = true;
          onProved();
          return deps.connections.track(deviceId, end, appSession, recheck, lapse);
        },
      },
      ...(arrival === undefined ? {} : { arrival }),
    });
  }

  /**
   * The identifier this socket's session was minted with — what a carrier with no close codes of its
   * own (a WebRTC data channel, `docs/relay-protocol.md` §16) addresses the session's `closed` to.
   */
  get sessionId(): SessionId {
    return this.#sessionId;
  }

  /** Announce the session to the client, then open it on the link — the order a rendezvous uses. */
  async open(): Promise<void> {
    this.#log?.opened();
    this.downstream.send(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: this.#sessionId,
        sequence: 0,
        payload: encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
      }),
    );
    await this.#link.receiveBinary(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: this.#sessionId,
        sequence: 0,
        payload: encodeControlMessage({ t: 'open' }),
      }),
    );
  }

  fromClient(frame: SocketFrame): void {
    if (this.#ended) return;
    this.#lastFrameAt = this.#clock.now();
    this.#bytesIn += typeof frame === 'string' ? frame.length : frame.byteLength;
    if (typeof frame === 'string') {
      this.#link.receiveText(frame);
      return;
    }
    const bytes = frameBytes(frame);
    const decoded = bytes === null ? undefined : decodeFrame(bytes);
    if (bytes === null || decoded === undefined || !decoded.ok) {
      this.#end(RELAY_CLOSE_CODES.protocolError, 'unparseable frame');
      return;
    }
    if (decoded.frame.kind === FRAME_KINDS.control) {
      this.#end(RELAY_CLOSE_CODES.protocolError, 'a client may not speak for the rendezvous on a direct socket');
      return;
    }
    // In order, one at a time, for the reason the relay carrier serialises its inbox: a record's
    // receive sequence advances inside the handler, so two decrypting at once would race it. Only the
    // HANDLING is serialised — an answer is written whenever its request finishes — and a failure
    // while writing one ends this socket as an internal fault rather than going unobserved.
    this.#inbox = this.#inbox.then(async () => {
      if (this.#ended) return;
      const receipt = await this.#link.accept(bytes);
      receipt.settled.catch(() => this.#end(RELAY_CLOSE_CODES.relayInternal, 'the daemon could not carry this frame'));
    });
  }

  close(ended?: SocketEnded): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#link.close();
    this.release();
    this.#report(ended);
  }

  /**
   * The one line a tunnel session's end earns. A close with no report from the transport and none from
   * this daemon is the daemon releasing the socket itself — a shutdown, or a peer gone before it attached.
   */
  #report(ended: SocketEnded | undefined): void {
    if (this.#log === undefined) return;
    const now = this.#clock.now();
    const here = this.#endedHere;
    this.#log.closed({
      by: here !== undefined || ended === undefined ? 'daemon' : 'peer',
      code: here?.code ?? ended?.code,
      reason: here?.reason ?? ended?.reason ?? 'the daemon released this socket',
      durationMs: now - this.#openedAt,
      lastFrameAgeMs: now - this.#lastFrameAt,
      bytesIn: this.#bytesIn,
      bytesOut: this.#bytesOut,
      proved: this.#proved,
    });
  }

  /** Ends this socket to make room: it had not proved a device, and an honest arrival needs the slot. */
  evict(): void {
    this.#end(RELAY_CLOSE_CODES.rendezvousBusy, EVICTED_REASON);
  }

  /**
   * One frame the link wants on the wire.
   *
   * Everything passes through unchanged except the link's `closed` for this session: on a rendezvous
   * that ends one session among many; here the session IS the socket, so the client is sent the
   * same `closed` it would get from a relay and then the socket closes with that code.
   */
  #fromLink(bytes: Uint8Array): void {
    if (this.#ended) return;
    this.#bytesOut += bytes.byteLength;
    this.downstream.send(bytes);
    const decoded = decodeFrame(bytes);
    if (!decoded.ok || decoded.frame.kind !== FRAME_KINDS.control) return;
    const message = decodeControlMessage(decoded.frame.payload);
    if (message?.t === 'closed') this.#end(message.code, message.reason);
  }

  #end(code: number, reason: string): void {
    if (this.#ended) return;
    this.#endedHere = { code, reason };
    this.close();
    // A close frame's reason is capped at 123 bytes; the full sentence already crossed in `closed`.
    this.downstream.close(code, truncateUtf8(reason, 123));
  }
}

/** The longest prefix of `text` whose UTF-8 encoding fits `limit` bytes, never splitting a character. */
function truncateUtf8(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) return text;
  let out = '';
  for (const character of text) {
    if (encoder.encode(out + character).byteLength > limit) break;
    out += character;
  }
  return out;
}
