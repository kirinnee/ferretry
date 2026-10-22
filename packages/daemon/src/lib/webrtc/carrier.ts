/**
 * THE WEBRTC CARRIER: the same session, over a data channel a browser opened peer-to-peer.
 *
 * `docs/relay-protocol.md` §16 is the contract. A paired device signals an offer inside a session it
 * already holds; this module answers it through the engine and then treats every data channel the
 * browser opens on that peer exactly as the direct carrier treats a socket: one channel, one
 * {@link DirectSession}, the same handshake, proof, lease and records. What it adds is only what a data
 * channel lacks — a close code — and what peer connections cost — bounds.
 *
 * A WEBRTC ARRIVAL IS NEVER LOOPBACK. The arrival every session here gets is fixed: not loopback, not
 * privileged, and keyed for rate limits by its peer connection. A candidate address is something the
 * browser chose to send, so nothing about where its UDP came from can make a caller local — a browser
 * on this very host that connected peer-to-peer is a remote, governed caller (`docs/grants.md`).
 *
 * THE BOUNDS, AND WHO EACH ONE PROTECTS:
 *
 * - one peer per running copy of the app (device + `appSession`): a phone that changed networks offers
 *   again, and its new peer replaces the one stranded on the old path instead of holding a second slot;
 * - {@link MAX_WEBRTC_PEERS_PER_DEVICE} per device, the oldest replaced: one device's tabs cannot take
 *   every slot from the others;
 * - {@link MAX_WEBRTC_PEERS} in all, then `webrtc_busy`: answering an offer allocates sockets, and a
 *   daemon holds a bounded number of them;
 * - {@link MAX_WEBRTC_CHANNELS_PER_PEER} channels on a peer — a tab holds three sessions;
 * - {@link WEBRTC_PEER_IDLE_MS} with no open channel closes a peer, which also bounds one that never
 *   connected at all.
 *
 * THE ENGINE RUNS ONLY WHILE A PEER NEEDS IT. Nothing here starts it until an offer arrives, and once the
 * last peer has ended and no offer is being answered for {@link WEBRTC_ENGINE_LINGER_MS}, the carrier hands
 * it back ({@link WebRtcPeerEngine.release}) — so a daemon no phone is using holds no WebRTC threads, and a
 * phone that reloads or changes networks offers again inside the linger without paying a start.
 */

import { WEBRTC_SESSION_CHANNEL_LABEL, type WebRtcRefusalCode } from '@ferretry/protocol';
import {
  decodeControlMessage,
  decodeFrame,
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  type SessionId,
} from '@ferretry/relay';
import type { SessionDevice } from '../api/http.ts';
import type { SocketDownstream, SocketFrame, SocketHandler } from '../api/socket.ts';
import type { RelayLinkScheduler, RelayLinkTimer } from '../relay/link.ts';
import type { SessionArrival } from '../relay/tunnel.ts';
import {
  type WebRtcChannelPort,
  WebRtcEngineUnavailable,
  WebRtcOfferRefused,
  type WebRtcPeerEngine,
  type WebRtcPeerPort,
} from './engine.ts';

/** How many peer connections this daemon holds at once. */
export const MAX_WEBRTC_PEERS = 8;
/** How many of those one device may hold; a further offer replaces its oldest. */
export const MAX_WEBRTC_PEERS_PER_DEVICE = 4;
/** How many session channels one peer connection may carry. */
export const MAX_WEBRTC_CHANNELS_PER_PEER = 8;
/** How long a peer connection may hold no open channel before it is closed. */
export const WEBRTC_PEER_IDLE_MS = 60_000;
/**
 * How long the engine stays started after its last peer ended: long enough for a reload or a network
 * change to offer again. A start costs tens of milliseconds, so this saves only that, and nothing longer is
 * worth a daemon holding a thread per core.
 */
export const WEBRTC_ENGINE_LINGER_MS = 30_000;

/**
 * The rate-limit identity of every session on one peer connection.
 *
 * Minted by this daemon, never by the browser, so it cannot be chosen or rotated by the caller —
 * the property `relayRateLimitIdentity` gives a relayed session — and prefixed so it is never mistaken
 * for, or collides with, a peer address.
 */
export function webrtcRateLimitIdentity(peerId: string): string {
  return `webrtc-peer:${peerId}`;
}

/** Where every WebRTC session arrived: remote, unprivileged, keyed by its peer connection. */
export function webrtcArrival(peerId: string): SessionArrival {
  return { loopback: false, privilegedLoopback: false, clientAddress: webrtcRateLimitIdentity(peerId) };
}

/** A session this carrier can run on a channel: a socket handler that knows its own session id. */
export type WebRtcSession = SocketHandler & { readonly sessionId: SessionId };

/**
 * Opens one session for one channel, or answers `undefined` when this daemon cannot run sessions at
 * all (it has no identity to sign a handshake with). `release` is called once, when the session ends.
 */
export type WebRtcSessionFactory = (
  arrival: SessionArrival,
  downstream: SocketDownstream,
  release: () => void,
) => WebRtcSession | undefined;

/** Whether this daemon offers the carrier at all, decided once at boot. */
export type WebRtcAvailability =
  | { readonly kind: 'ready' }
  | { readonly kind: 'refused'; readonly code: 'webrtc_disabled' | 'webrtc_unavailable'; readonly reason: string };

export type WebRtcOfferOutcome =
  | { readonly kind: 'answered'; readonly sdp: string }
  | {
      readonly kind: 'refused';
      readonly status: 400 | 429 | 503;
      readonly code: WebRtcRefusalCode;
      readonly reason: string;
    };

export interface WebRtcCarrierDependencies {
  readonly availability: WebRtcAvailability;
  readonly engine: WebRtcPeerEngine;
  readonly iceServers: readonly string[];
  readonly sessions: WebRtcSessionFactory;
  readonly scheduler: RelayLinkScheduler;
  /** A fresh, unguessable identifier for one peer connection. */
  readonly peerId: () => string;
}

interface PeerState {
  readonly id: string;
  readonly deviceId: string;
  readonly appSession: string;
  readonly peer: WebRtcPeerPort;
  readonly sessions: Set<WebRtcSession>;
  idle: RelayLinkTimer | undefined;
  closed: boolean;
}

/** Whether a frame the session sent is its own `closed` — after which the channel must not send another. */
function isClosedControl(frame: Uint8Array): boolean {
  if (frame[2] !== FRAME_KINDS.control) return false;
  const decoded = decodeFrame(frame);
  return decoded.ok && decodeControlMessage(decoded.frame.payload)?.t === 'closed';
}

export class WebRtcCarrier {
  /** Insertion order is age order: the first entry for a device is its oldest peer. */
  readonly #peers = new Map<string, PeerState>();
  /** Offers being answered: they hold a slot before the engine is asked, so a burst cannot overshoot. */
  #pending = 0;
  /** The engine's hand-back, armed while no peer and no offer needs it. */
  #linger: RelayLinkTimer | undefined;
  /** The daemon is stopping: nothing is armed again. */
  #stopped = false;

  constructor(private readonly deps: WebRtcCarrierDependencies) {}

  /** How many peer connections are held now — what `/healthz`-style reports and tests read. */
  get peers(): number {
    return this.#peers.size;
  }

  /** Answer one offer from one running copy of the app, or say why not. */
  async offer(offerSdp: string, device: SessionDevice): Promise<WebRtcOfferOutcome> {
    const availability = this.deps.availability;
    if (availability.kind === 'refused') {
      return { kind: 'refused', status: 503, code: availability.code, reason: availability.reason };
    }
    // The same copy of the app offering again means its old path is gone (a network change, a reload):
    // the new peer replaces it rather than standing beside it.
    for (const state of [...this.#peers.values()]) {
      if (state.deviceId === device.deviceId && state.appSession === device.appSession) this.#close(state);
    }
    const mine = [...this.#peers.values()].filter(state => state.deviceId === device.deviceId);
    if (mine.length >= MAX_WEBRTC_PEERS_PER_DEVICE) {
      const oldest = mine[0];
      if (oldest !== undefined) this.#close(oldest);
    }
    if (this.#peers.size + this.#pending >= MAX_WEBRTC_PEERS) {
      return {
        kind: 'refused',
        status: 429,
        code: 'webrtc_busy',
        reason: 'this daemon is holding as many peer-to-peer connections as it carries',
      };
    }
    this.#pending += 1;
    this.#settleEngine();
    let answer: Awaited<ReturnType<WebRtcPeerEngine['answer']>> | undefined;
    try {
      answer = await this.deps.engine.answer(offerSdp, this.deps.iceServers);
    } catch (error) {
      if (error instanceof WebRtcEngineUnavailable) {
        return { kind: 'refused', status: 503, code: 'webrtc_unavailable', reason: error.message };
      }
      if (!(error instanceof WebRtcOfferRefused)) throw error;
      return {
        kind: 'refused',
        status: 400,
        code: 'webrtc_offer_invalid',
        reason: 'this daemon could not use that offer',
      };
    } finally {
      this.#pending -= 1;
      // An answered offer is about to hold a peer, so only one that came to nothing can leave the engine idle.
      if (answer === undefined) this.#settleEngine();
    }
    const state: PeerState = {
      id: this.deps.peerId(),
      deviceId: device.deviceId,
      appSession: device.appSession,
      peer: answer.peer,
      sessions: new Set(),
      idle: undefined,
      closed: false,
    };
    this.#peers.set(state.id, state);
    answer.peer.onChannel(channel => this.#attach(state, channel));
    answer.peer.onClosed(() => this.#close(state));
    this.#armIdle(state);
    return { kind: 'answered', sdp: answer.sdp };
  }

  /**
   * Close every peer: the daemon is stopping.
   *
   * The engine is NOT released here. Its threads go with the process, and a release is the one call into
   * the library that waits — on its own threads joining, bounded only by the library — so a stopping
   * daemon has nothing to gain from it and a stop that can wait on native code to lose.
   */
  close(): void {
    this.#stopped = true;
    this.#linger?.cancel();
    this.#linger = undefined;
    for (const state of [...this.#peers.values()]) this.#close(state);
  }

  /** Hand the engine back once nothing has needed it for the linger, or keep it while something does. */
  #settleEngine(): void {
    if (this.#peers.size > 0 || this.#pending > 0 || this.#stopped) {
      this.#linger?.cancel();
      this.#linger = undefined;
      return;
    }
    this.#linger ??= this.deps.scheduler.after(WEBRTC_ENGINE_LINGER_MS, () => {
      this.#linger = undefined;
      this.deps.engine.release();
    });
  }

  #armIdle(state: PeerState): void {
    state.idle?.cancel();
    state.idle = this.deps.scheduler.after(WEBRTC_PEER_IDLE_MS, () => {
      if (state.sessions.size === 0) this.#close(state);
    });
  }

  #close(state: PeerState): void {
    if (state.closed) return;
    state.closed = true;
    state.idle?.cancel();
    this.#peers.delete(state.id);
    for (const session of [...state.sessions]) session.close();
    state.peer.close();
    this.#settleEngine();
  }

  /** One channel the browser opened: a session, or closed at once when it cannot be one. */
  #attach(state: PeerState, channel: WebRtcChannelPort): void {
    if (state.closed || channel.label !== WEBRTC_SESSION_CHANNEL_LABEL) {
      channel.close();
      return;
    }
    if (state.sessions.size >= MAX_WEBRTC_CHANNELS_PER_PEER) {
      channel.close();
      return;
    }
    let session: WebRtcSession | undefined;
    let closedSent = false;
    let gone = false;
    const downstream: SocketDownstream = {
      send: frame => {
        if (gone) return -1;
        if (typeof frame === 'string') return channel.sendText(frame) ? frame.length : -1;
        if (isClosedControl(frame)) closedSent = true;
        return channel.send(frame) ? frame.byteLength : -1;
      },
      // A data channel closes with no code, so the code a WebSocket close would carry crosses as the
      // session's own `closed` first (§16, "On the channel") — unless the session already sent one.
      close: (code, reason) => {
        if (gone) return;
        gone = true;
        if (!closedSent && session !== undefined && code >= 4000 && code <= 4999) {
          channel.send(
            encodeFrame({
              kind: FRAME_KINDS.control,
              sessionId: session.sessionId,
              sequence: 0,
              payload: encodeControlMessage({ t: 'closed', code, reason }),
            }),
          );
        }
        channel.close();
      },
      bufferedBytes: () => channel.bufferedBytes(),
    };
    const release = (): void => {
      if (session === undefined || !state.sessions.delete(session)) return;
      if (state.sessions.size === 0 && !state.closed) this.#armIdle(state);
    };
    session = this.deps.sessions(webrtcArrival(state.id), downstream, release);
    if (session === undefined) {
      channel.close();
      return;
    }
    const opened = session;
    state.sessions.add(opened);
    state.idle?.cancel();
    // Frames that arrive before the session has opened wait for it: a handler is told `open` before any
    // client frame, exactly as a socket route's is.
    let backlog: SocketFrame[] | undefined = [];
    channel.onMessage(frame => {
      if (backlog !== undefined) backlog.push(frame);
      else opened.fromClient(frame);
    });
    channel.onClosed(() => {
      gone = true;
      opened.close();
      release();
    });
    void opened.open().then(
      () => {
        const waiting = backlog ?? [];
        backlog = undefined;
        for (const frame of waiting) opened.fromClient(frame);
      },
      () => downstream.close(4500, 'the daemon could not open this session'),
    );
  }
}
