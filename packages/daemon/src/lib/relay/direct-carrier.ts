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
import type { SocketDownstream, SocketFrame, SocketHandler } from '../api/socket.ts';
import type { DeviceConnectionTracker } from '../pairing/index.ts';
import {
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
  readonly scheduler: RelayLinkScheduler;
  readonly clock: RelayLinkClock;
  readonly connections: DeviceConnectionTracker;
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
    this.#link = new RelayLink({
      crypto: deps.crypto,
      identity: deps.identity,
      // No rendezvous host exists on a direct socket, and nothing here ever asks the link to sign a
      // claim: a client's control frame is refused before it reaches the link.
      relayHost: '',
      socket: {
        send: bytes => this.#fromLink(bytes),
        sendText: text => {
          if (!this.#ended) this.downstream.send(text);
        },
        close: (code, reason) => this.#end(code, reason),
      },
      dispatch: deps.dispatch,
      sockets: deps.sockets,
      devices: deps.devices,
      pairing: deps.pairing,
      scheduler: deps.scheduler,
      clock: deps.clock,
      // Seen on the way through: a device's proof is registered here first, which is the moment this
      // socket stops being an unproven one.
      connections: {
        track: (deviceId, end, appSession, recheck) => {
          onProved();
          return deps.connections.track(deviceId, end, appSession, recheck);
        },
      },
      ...(arrival === undefined ? {} : { arrival }),
    });
  }

  /** Announce the session to the client, then open it on the link — the order a rendezvous uses. */
  async open(): Promise<void> {
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
    // receive sequence advances inside the handler, so two decrypting at once would race it.
    this.#inbox = this.#inbox.then(async () => {
      if (!this.#ended) await this.#link.receiveBinary(bytes);
    });
  }

  close(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#link.close();
    this.release();
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
    this.downstream.send(bytes);
    const decoded = decodeFrame(bytes);
    if (!decoded.ok || decoded.frame.kind !== FRAME_KINDS.control) return;
    const message = decodeControlMessage(decoded.frame.payload);
    if (message?.t === 'closed') this.#end(message.code, message.reason);
  }

  #end(code: number, reason: string): void {
    if (this.#ended) return;
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
