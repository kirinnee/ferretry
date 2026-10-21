/**
 * THE BROWSER HALF OF THE WEBRTC CARRIER (`docs/relay-protocol.md` §16).
 *
 * One peer connection per daemon, and one data channel per session on it. The first dial negotiates:
 * it opens the first channel (an offer needs one to describe), gathers within §16's bounds, sends the
 * offer through a session that already reaches the daemon (the relay, usually), sets the answer, and
 * waits — at most {@link WEBRTC_CONNECT_DEADLINE_MS} from the offer leaving — for that channel to open.
 * Every later dial opens another channel on the same connection, which costs no signalling at all.
 *
 * WHAT A DIAL HANDS BACK is the same message socket every carrier hands the session
 * (`RelayCarrierSocket`), so the handshake, device proof and records run unchanged over it. The router
 * installs its handlers in the turn the dial resolves, and the daemon sends `ready` the moment a channel
 * opens, so messages that arrive before the socket is announced are held and delivered after `onOpen`.
 *
 * WHY A DIAL FAILS, AND WHAT IT SAYS. A refused or failed dial rejects with a sentence the carrier
 * walk shows verbatim beside the fallback it took — "WebRTC could not find a direct path in 8 s…" —
 * so the Connection status names the reason, never just the carrier it fell back to.
 *
 * A PATH THAT DIED IS RENEGOTIATED, NEVER RESTARTED. libdatachannel refuses an ICE restart (§16, "When
 * the network changes"), so a connection that failed, closed, or could not open a new channel in time
 * is dropped, and the next dial negotiates a fresh one over the network the device is on now.
 */

import {
  WEBRTC_CONNECT_DEADLINE_MS,
  WEBRTC_GATHER_CAP_MS,
  WEBRTC_GATHER_REFLEXIVE_GRACE_MS,
  WEBRTC_SESSION_CHANNEL_LABEL,
  WebRtcOfferAnswerSchema,
  WebRtcOfferRequestSchema,
} from '@ferretry/protocol';
import type { RelayCarrierSocket } from './relay-carrier.ts';

/** How long a channel on an already connected peer may take to open before the peer is presumed dead. */
export const WEBRTC_CHANNEL_OPEN_DEADLINE_MS = 4_000;

/** The code a channel that closed without its session's `closed` is reported with: it ended abnormally. */
const ABNORMAL_CLOSURE = 1006;

/** The slice of `RTCDataChannel` this module drives. */
export interface WebRtcDataChannelLike {
  readonly readyState: string;
  binaryType: string;
  send(data: ArrayBuffer | string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
}

/** The slice of `RTCPeerConnection` this module drives. */
export interface WebRtcPeerLike {
  readonly connectionState: string;
  readonly iceGatheringState: string;
  readonly localDescription: { readonly sdp: string } | null;
  createDataChannel(label: string, init: { readonly ordered: boolean }): WebRtcDataChannelLike;
  createOffer(): Promise<{ readonly type: string; readonly sdp?: string }>;
  setLocalDescription(description: { readonly type: string; readonly sdp?: string }): Promise<void>;
  setRemoteDescription(description: { readonly type: 'answer'; readonly sdp: string }): Promise<void>;
  getStats(): Promise<Iterable<[string, unknown]> | Map<string, unknown>>;
  close(): void;
  onicecandidate: ((event: { readonly candidate: { readonly type?: string | null } | null }) => void) | null;
  onicegatheringstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
}

export type WebRtcPeerFactory = (configuration: {
  readonly iceServers: readonly { readonly urls: string }[];
}) => WebRtcPeerLike;

/** What the daemon said to an offer: its answer, or the sentence a person is shown instead. */
export type WebRtcSignalOutcome =
  | { readonly kind: 'answered'; readonly sdp: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** Sends one offer through a session that already reaches the daemon (§16, "Signalling"). */
export type WebRtcSignaller = (offerSdp: string, signal: AbortSignal) => Promise<WebRtcSignalOutcome>;

export interface WebRtcTimers {
  setTimeout(action: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WebRtcCarrierDependencies {
  readonly createPeer: WebRtcPeerFactory;
  readonly signal: WebRtcSignaller;
  readonly iceServers: readonly string[];
  readonly timers: WebRtcTimers;
}

/** The sentence a dial that ran out of time rejects with. */
export const WEBRTC_NO_PATH_REASON = `WebRTC could not find a direct path in ${WEBRTC_CONNECT_DEADLINE_MS / 1_000} s — this network may block peer-to-peer connections`;

/** The sentence a dial the router abandoned rejects with. */
const WEBRTC_CANCELLED_REASON = 'the WebRTC attempt was cancelled';

/** Wraps one open data channel as the socket the session runs on. */
function channelSocket(channel: WebRtcDataChannelLike, timers: WebRtcTimers): RelayCarrierSocket {
  let ended = false;
  let announced = false;
  const held: unknown[] = [];
  const socket: RelayCarrierSocket = {
    onOpen: null,
    onText: null,
    onBinary: null,
    onClose: null,
    // Copied onto its own buffer, as the WebSocket adapter does: a view over a shared buffer is not a
    // frame `send` may take, and a frame handed in from anywhere carries no proof that it is not one.
    send: bytes => {
      if (!ended) channel.send(new Uint8Array(bytes).buffer);
    },
    sendText: text => {
      if (!ended) channel.send(text);
    },
    // A data channel carries no close code. The session ends its side with a sealed record or a
    // `closed` it already sent, so closing the channel is all that is left to do.
    close: () => {
      if (ended) return;
      ended = true;
      channel.close();
    },
  };
  const deliver = (data: unknown): void => {
    if (typeof data === 'string') socket.onText?.(data);
    else if (data instanceof ArrayBuffer) socket.onBinary?.(new Uint8Array(data));
    else {
      // Neither text nor bytes is no message this protocol defines; the channel is not one to keep
      // listening to.
      ended = true;
      channel.close();
      socket.onClose?.(ABNORMAL_CLOSURE, 'the peer-to-peer channel delivered a message of an unknown type');
    }
  };
  channel.binaryType = 'arraybuffer';
  channel.onmessage = event => {
    if (announced) deliver(event.data);
    else held.push(event.data);
  };
  channel.onclose = () => {
    if (ended) return;
    ended = true;
    socket.onClose?.(ABNORMAL_CLOSURE, 'the peer-to-peer channel closed');
  };
  // Announced only after the dial has resolved and the router has installed its handlers.
  timers.setTimeout(() => {
    announced = true;
    socket.onOpen?.();
    for (const data of held.splice(0)) if (!ended) deliver(data);
  }, 0);
  return socket;
}

interface Negotiated {
  readonly peer: WebRtcPeerLike;
  readonly first: WebRtcDataChannelLike;
}

/** The peer-to-peer path to ONE daemon: the connection it is on now, and the dials that use it. */
export class WebRtcCarrier {
  #peer: WebRtcPeerLike | undefined;
  #negotiating: Promise<Negotiated> | undefined;

  constructor(private readonly deps: WebRtcCarrierDependencies) {}

  /** One socket for one session, or a rejection carrying the sentence the walk shows. */
  async dial(signal: AbortSignal): Promise<RelayCarrierSocket> {
    // An attempt abandoned before it started negotiates nothing: an abort that already happened fires
    // no event, so nothing below would ever hear it.
    if (signal.aborted) throw new Error(WEBRTC_CANCELLED_REASON);
    const peer = this.#peer;
    if (peer !== undefined && peer.connectionState === 'connected') {
      const channel = peer.createDataChannel(WEBRTC_SESSION_CHANNEL_LABEL, { ordered: true });
      await this.#opened(channel, WEBRTC_CHANNEL_OPEN_DEADLINE_MS, signal, () => {
        // A connection that cannot open a channel in time is presumed dead (a changed network, often,
        // which its state has not caught up with): drop it so the next dial negotiates afresh.
        this.#drop(peer);
        return 'the peer-to-peer connection stopped answering';
      });
      return channelSocket(channel, this.deps.timers);
    }
    this.#negotiating ??= this.#negotiate(signal).finally(() => {
      this.#negotiating = undefined;
    });
    const negotiated = await this.#negotiating;
    if (this.#peer === negotiated.peer && !this.#claimed.has(negotiated.first)) {
      this.#claimed.add(negotiated.first);
      return channelSocket(negotiated.first, this.deps.timers);
    }
    // Another dial took the channel the negotiation opened; this one opens its own on the same peer.
    return await this.dial(signal);
  }

  /** The round trip of the path in use, in milliseconds, or `undefined` when there is none to measure. */
  async rttMs(): Promise<number | undefined> {
    const peer = this.#peer;
    if (peer === undefined) return undefined;
    let pairs: number | undefined;
    for (const [, report] of await peer.getStats()) {
      const pair = report as { type?: string; state?: string; nominated?: boolean; currentRoundTripTime?: number };
      if (
        pair.type === 'candidate-pair' &&
        pair.state === 'succeeded' &&
        typeof pair.currentRoundTripTime === 'number'
      ) {
        pairs = Math.round(pair.currentRoundTripTime * 1_000);
        if (pair.nominated === true) return pairs;
      }
    }
    return pairs;
  }

  /** Close the connection: the device was unpaired, or the person chose a carrier without WebRTC. */
  close(): void {
    const peer = this.#peer;
    if (peer !== undefined) this.#drop(peer);
  }

  readonly #claimed = new WeakSet<WebRtcDataChannelLike>();

  #drop(peer: WebRtcPeerLike): void {
    if (this.#peer === peer) this.#peer = undefined;
    peer.close();
  }

  async #negotiate(signal: AbortSignal): Promise<Negotiated> {
    const peer = this.deps.createPeer({ iceServers: this.deps.iceServers.map(urls => ({ urls })) });
    try {
      const first = peer.createDataChannel(WEBRTC_SESSION_CHANNEL_LABEL, { ordered: true });
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.#drop(peer);
      };
      const gathered = this.#gathered(peer);
      await peer.setLocalDescription(await peer.createOffer());
      await gathered;
      const offer = peer.localDescription;
      if (offer === null) throw new Error('this browser produced no WebRTC offer');
      const deadline = this.#opened(first, WEBRTC_CONNECT_DEADLINE_MS, signal, () => WEBRTC_NO_PATH_REASON);
      // Observed here so a refusal below cannot leave the deadline's rejection unhandled.
      deadline.catch(() => undefined);
      const answer = await this.deps.signal(offer.sdp, signal);
      if (answer.kind === 'refused') throw new Error(answer.reason);
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await deadline;
      this.#peer = peer;
      return { peer, first };
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  /** Resolves at §16's first gathering bound: complete, a grace after the first srflx, or the cap. */
  #gathered(peer: WebRtcPeerLike): Promise<void> {
    const { timers } = this.deps;
    return new Promise<void>(resolve => {
      let grace: unknown;
      const cap = timers.setTimeout(done, WEBRTC_GATHER_CAP_MS);
      function done(): void {
        timers.clearTimeout(cap);
        if (grace !== undefined) timers.clearTimeout(grace);
        resolve();
      }
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === 'complete') done();
      };
      peer.onicecandidate = event => {
        if (event.candidate === null) done();
        else if (grace === undefined && event.candidate.type === 'srflx')
          grace = timers.setTimeout(done, WEBRTC_GATHER_REFLEXIVE_GRACE_MS);
      };
    });
  }

  /** Resolves when the channel opens; rejects with `onTimeout`'s sentence at the deadline, or on abort. */
  #opened(
    channel: WebRtcDataChannelLike,
    deadlineMs: number,
    signal: AbortSignal,
    onTimeout: () => string,
  ): Promise<void> {
    const { timers } = this.deps;
    return new Promise<void>((resolve, reject) => {
      if (channel.readyState === 'open') {
        resolve();
        return;
      }
      const finish = (outcome: () => void): void => {
        timers.clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        channel.onopen = null;
        outcome();
      };
      const timer = timers.setTimeout(() => finish(() => reject(new Error(onTimeout()))), deadlineMs);
      const aborted = (): void => finish(() => reject(new Error(WEBRTC_CANCELLED_REASON)));
      signal.addEventListener('abort', aborted);
      channel.onopen = () => finish(resolve);
    });
  }
}

/** What a signaller needs: one request through a carrier that already reaches the daemon. */
export type WebRtcIntroducerRequest = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The offer, posted through an introducer, read as the daemon meant it.
 *
 * A `404` is a daemon older than this carrier — the one refusal whose remedy is on the machine, so it
 * says so. Every other refusal carries the daemon's own sentence (§16's machine codes come with one),
 * and an answer that does not parse is refused rather than handed to the browser's WebRTC stack.
 */
export function webrtcSignaller(request: WebRtcIntroducerRequest): WebRtcSignaller {
  return async (offerSdp, signal) => {
    const response = await request('/v1/webrtc/offer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(WebRtcOfferRequestSchema.parse({ sdp: offerSdp })),
      cache: 'no-store',
      signal,
    });
    if (response.status === 404) {
      return { kind: 'refused', reason: 'this machine does not offer WebRTC yet — updating Ferretry on it adds it' };
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) {
      const parsed = WebRtcOfferAnswerSchema.safeParse(body);
      return parsed.success
        ? { kind: 'answered', sdp: parsed.data.sdp }
        : { kind: 'refused', reason: 'the machine answered the WebRTC offer with something that is not an answer' };
    }
    const said = (body as { error?: unknown } | undefined)?.error;
    return {
      kind: 'refused',
      reason: typeof said === 'string' && said.trim() !== '' ? said : `the machine refused WebRTC (${response.status})`,
    };
  };
}

/** The part of one WebRTC attempt the dialer reads — the router's `WebRtcDialContext`, structurally. */
export interface WebRtcAttempt {
  readonly daemon: { readonly daemonId: string };
  readonly request: WebRtcIntroducerRequest;
  readonly signal: AbortSignal;
}

/**
 * The composition root's WebRTC dialer: one {@link WebRtcCarrier} per daemon, reused by every session.
 *
 * An attempt the router abandons — the pairing was replaced or removed, or the person chose a carrier
 * without WebRTC — closes that daemon's connection, so nothing keeps a peer-to-peer path open to a
 * machine this browser no longer means to reach. `rttMs` is what the Connection status reads.
 */
export class WebRtcDialer {
  readonly #carriers = new Map<string, WebRtcCarrier>();

  constructor(private readonly deps: Omit<WebRtcCarrierDependencies, 'signal'>) {}

  readonly dial = async (attempt: WebRtcAttempt): Promise<RelayCarrierSocket> => {
    const daemonId = attempt.daemon.daemonId;
    let carrier = this.#carriers.get(daemonId);
    if (carrier === undefined) {
      carrier = new WebRtcCarrier({ ...this.deps, signal: webrtcSignaller(attempt.request) });
      this.#carriers.set(daemonId, carrier);
    }
    const held = carrier;
    if (!attempt.signal.aborted)
      attempt.signal.addEventListener('abort', () => this.#forget(daemonId, held), { once: true });
    return await held.dial(attempt.signal);
  };

  /** The round trip of this daemon's peer-to-peer path, or `undefined` when it has none. */
  async rttMs(daemonId: string): Promise<number | undefined> {
    return await this.#carriers.get(daemonId)?.rttMs();
  }

  /** Drop every connection: the network changed, and a path found on the old one is not worth trusting. */
  networkChanged(): void {
    for (const [daemonId, carrier] of [...this.#carriers]) this.#forget(daemonId, carrier);
  }

  #forget(daemonId: string, carrier: WebRtcCarrier): void {
    carrier.close();
    if (this.#carriers.get(daemonId) === carrier) this.#carriers.delete(daemonId);
  }
}
