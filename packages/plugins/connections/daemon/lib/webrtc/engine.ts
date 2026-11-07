/**
 * THE WEBRTC ENGINE, AS THE DAEMON REPORTS IT: is there one on this machine, and does it work?
 *
 * WebRTC is the peer-to-peer carrier (`docs/relay-protocol.md` §16): a browser and this daemon find a
 * direct UDP path through their NATs and run the SAME end-to-end session over a data channel that a
 * WebSocket carries everywhere else. Bun has no WebRTC of its own, so the daemon carries a native one
 * — libdatachannel, through `node-datachannel` — and a native library is the one dependency that can
 * be present on the build machine and missing, or unloadable, on the machine that runs the binary.
 *
 * SO THE ENGINE IS PROVED, NOT ASSUMED. A report is the outcome of a SELF-TEST: two peers inside this
 * process, bound to loopback with no ICE server, open a data channel and echo one message. That is
 * the whole stack a remote phone would use — the addon loaded, ICE, DTLS, SCTP and a channel — minus
 * the network, and it never leaves the machine. Loading the library proves only that a file was
 * found; a channel that echoes proves the carrier could work.
 *
 * THE PROOF IS `fyd --check`'s, AND NOT THE BOOT'S. A self-test starts the engine, and a started engine
 * keeps its threads (see {@link WebRtcPeerEngine}); a serving daemon that proved it at boot paid a
 * library load on its startup path and 35 threads for its whole life to learn something only an offer
 * needs. So the serving daemon starts the engine on the first offer, and an engine that will not start
 * then is the same `webrtc_unavailable` answer the boot used to give.
 *
 * AN ENGINE THAT IS UNAVAILABLE IS AN ANSWER, NOT A FAILURE. Every carrier above WebRTC falls back to
 * the relay when WebRTC cannot be had, so a daemon without one starts perfectly and is reachable
 * exactly as it was before WebRTC existed. The report therefore never throws and never refuses a
 * boot: it says which, and why, in a sentence a person can act on.
 */

/** How long the self-test's two loopback peers may take to connect and echo before the engine is called unusable. */
export const WEBRTC_SELF_TEST_TIMEOUT_MS = 5_000;

/** The label of the self-test's data channel — inert, and never one a client would open. */
export const WEBRTC_SELF_TEST_CHANNEL = 'fy-self-test';

export type WebRtcEngineReport =
  | {
      readonly kind: 'ready';
      /** The native library and its version, as the library reports itself. */
      readonly library: string;
      /** How long two loopback peers took from creation to an echoed message, in milliseconds. */
      readonly selfTestMs: number;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** The engine, seen from the daemon's domain: it can only be asked whether it works. */
export interface WebRtcEnginePort {
  selfTest(): Promise<WebRtcEngineReport>;
}

/**
 * The sentence `fyd --check` prints after `webrtc`, for either answer.
 *
 * It names what the absence COSTS, because "unavailable" alone reads like a broken daemon: nothing a
 * device could do before is lost, and the relay still carries every session.
 */
export function describeWebRtcEngine(report: WebRtcEngineReport): string {
  if (report.kind === 'ready') {
    return `engine ready — ${report.library}; two local peers connected and echoed in ${Math.round(report.selfTestMs)} ms`;
  }
  return `engine unavailable — ${report.reason}; devices reach this daemon directly or through the relay instead`;
}

/** What the boot trail says after `webrtc` for a carrier that is switched on: nothing was started. */
export const WEBRTC_ENGINE_ON_DEMAND =
  'engine starts on the first peer-to-peer offer and stops once no peer needs it; `fyd --check` proves it on this machine';

/**
 * One data channel, as the carrier sees it: frames in, frames out, and an end.
 *
 * Text is its own call because a session's heartbeat (`fy-ping`/`fy-pong`, §8) is the one text message
 * the protocol defines, and a channel that flattened it into bytes would hand the session a frame it
 * must refuse.
 */
export interface WebRtcChannelPort {
  readonly label: string;
  /** False when the channel is gone and nothing was sent. */
  send(frame: Uint8Array): boolean;
  sendText(text: string): boolean;
  /** Bytes queued on the channel and not yet handed to the network — the session's backpressure reading. */
  bufferedBytes(): number;
  close(): void;
  onMessage(listener: (frame: string | Uint8Array) => void): void;
  /** Called once, whoever closed it. */
  onClosed(listener: () => void): void;
}

/** One peer connection the daemon answered: the channels a browser opens on it, and its end. */
export interface WebRtcPeerPort {
  onChannel(listener: (channel: WebRtcChannelPort) => void): void;
  /** Called once, when the connection failed or closed. */
  onClosed(listener: () => void): void;
  close(): void;
}

export interface WebRtcAnswer {
  readonly sdp: string;
  readonly peer: WebRtcPeerPort;
}

/** The engine could not use an offer: it did not parse, or it described nothing this side can answer. */
export class WebRtcOfferRefused extends Error {}

/**
 * The engine could not be had when an offer asked for it: the library would not load, or it stopped in a
 * state no further peer could be built on. The carrier answers it as `webrtc_unavailable`, with this
 * sentence, exactly as it once answered a failed boot self-test.
 */
export class WebRtcEngineUnavailable extends Error {}

/**
 * The engine, as the carrier drives it.
 *
 * IT IS STARTED BY THE FIRST OFFER AND STOPPED WHEN NOTHING USES IT. A native WebRTC stack is not free to
 * hold: libdatachannel starts one worker thread per core and two SCTP threads for its first peer and keeps
 * them for the life of the process, which on a 32-core host was 35 idle threads in a daemon no phone had
 * dialled. So nothing starts it at boot — the boot asks it nothing at all — and the carrier hands it back
 * through {@link release} once no peer has needed it for a while, so a daemon between phones holds none.
 */
export interface WebRtcPeerEngine {
  /**
   * Answer one offer, non-trickle: the answer carries every candidate gathered within §16's bounds.
   * Starts the engine when it is not started. Throws {@link WebRtcOfferRefused} for an offer the engine
   * cannot use, and {@link WebRtcEngineUnavailable} when there is no engine to answer with.
   */
  answer(offerSdp: string, iceServers: readonly string[]): Promise<WebRtcAnswer>;
  /**
   * No peer needs the engine now: stop what it runs while idle, until the next {@link answer} starts it
   * again. Does nothing while any peer it made is still open, so a late call can never cut one off.
   */
  release(): void;
}
