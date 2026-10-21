/**
 * libdatachannel, through `node-datachannel`, as this daemon's WebRTC engine.
 *
 * WHY THIS ENGINE (measured, `docs/relay-protocol.md` §16 "The engine"): it is the libdatachannel C++
 * stack behind N-API, which Bun loads, and a compiled `fyd` embeds per target
 * (`scripts/release/compile-executable.ts`). The pure-TypeScript alternative, werift, echoed 7.5 MB/s
 * to this one's 141 MB/s, took 250 ms to open a loopback channel to this one's 12 ms, and threw an
 * uncaught `ECONNREFUSED` from Bun's `node:dgram` when its peers closed — a daemon cannot carry a
 * library whose teardown can take the process down.
 *
 * THE LIBRARY IS LOADED ON FIRST USE, NEVER AT IMPORT. A native addon that fails to load throws from
 * its module body, and an import that throws at the top of the composition root is a daemon that
 * does not start — on a machine where the only thing missing was a peer-to-peer carrier the relay
 * already stands in for. Loading here turns that into the `unavailable` sentence instead.
 */

import { WEBRTC_GATHER_CAP_MS, WEBRTC_GATHER_REFLEXIVE_GRACE_MS } from '@ferretry/protocol';
import {
  WEBRTC_SELF_TEST_CHANNEL,
  WEBRTC_SELF_TEST_TIMEOUT_MS,
  type WebRtcAnswer,
  type WebRtcChannelPort,
  type WebRtcEnginePort,
  type WebRtcEngineReport,
  WebRtcOfferRefused,
  type WebRtcPeerEngine,
  type WebRtcPeerPort,
} from '../../lib/webrtc/index.ts';

/** The slice of a data channel this adapter touches. */
export interface EngineDataChannel {
  getLabel(): string;
  onOpen(callback: () => void): void;
  onMessage(callback: (message: string | ArrayBuffer | Buffer) => void): void;
  onClosed(callback: () => void): void;
  sendMessage(message: string): boolean;
  sendMessageBinary(message: Uint8Array): boolean;
  bufferedAmount(): number;
  close(): void;
}

/** The slice of a peer connection this adapter touches. */
export interface EnginePeerConnection {
  onLocalDescription(callback: (sdp: string, type: string) => void): void;
  onLocalCandidate(callback: (candidate: string, mid: string) => void): void;
  onGatheringStateChange(callback: (state: string) => void): void;
  onStateChange(callback: (state: string) => void): void;
  onDataChannel(callback: (channel: EngineDataChannel) => void): void;
  setRemoteDescription(sdp: string, type: never): void;
  localDescription(): { readonly sdp: string; readonly type: string } | null;
  addRemoteCandidate(candidate: string, mid: string): void;
  createDataChannel(label: string): EngineDataChannel;
  close(): void;
}

/** The slice of `node-datachannel` this adapter needs — injected, so a suite can stand in a failing one. */
export interface NodeDataChannelModule {
  readonly PeerConnection: new (
    peerName: string,
    config: { readonly iceServers: string[]; readonly bindAddress?: string },
  ) => EnginePeerConnection;
  getLibraryVersion(): string;
}

export type NodeDataChannelLoader = () => Promise<NodeDataChannelModule>;

export interface NodeDataChannelEngineOptions {
  readonly load?: NodeDataChannelLoader;
  readonly timeoutMs?: number;
  /** §16's gathering bounds; a suite shortens them, production never does. */
  readonly gatherCapMs?: number;
  readonly reflexiveGraceMs?: number;
  /** Milliseconds on a monotonic clock — `performance.now()` unless a suite needs another. */
  readonly now?: () => number;
}

/**
 * The real module, by a literal specifier so a compiled build bundles it (and embeds its addon).
 *
 * Exported with the library's own types, for the one other reader that needs the whole surface: the
 * engine benchmark (`packages/pwa/harness/webrtc-engine-bench.ts`), which cannot resolve the package
 * from the PWA.
 */
export const loadNodeDataChannel = async () => await import('node-datachannel');

/** The first line of whatever a failure threw — an addon's load error carries a whole stack. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? '';
}

/** Calls `listener` at most once, however many times the returned function is called. */
function once(listener: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    listener();
  };
}

/** One received message as bytes or text, never a Node `Buffer` the session would have to know about. */
function frameOf(message: string | ArrayBuffer | Buffer): string | Uint8Array {
  if (typeof message === 'string') return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

/** A data channel as the carrier drives it. Every call into the library is guarded: a channel the
 *  native side already tore down throws, and a throw here would take a session's whole send path down. */
function channelPort(channel: EngineDataChannel): WebRtcChannelPort {
  const attempt = (action: () => boolean): boolean => {
    try {
      return action();
    } catch {
      return false;
    }
  };
  return {
    label: channel.getLabel(),
    send: frame => attempt(() => channel.sendMessageBinary(frame)),
    sendText: text => attempt(() => channel.sendMessage(text)),
    bufferedBytes: () => {
      try {
        return channel.bufferedAmount();
      } catch {
        return 0;
      }
    },
    close: () => void attempt(() => (channel.close(), true)),
    onMessage: listener => channel.onMessage(message => listener(frameOf(message))),
    onClosed: listener => channel.onClosed(once(listener)),
  };
}

/** A peer connection as the carrier drives it. `failed` and `closed` are its end; `disconnected` is
 *  not — ICE may recover it, and the session's own keepalive decides when a silent path is dead. */
function peerPort(peer: EnginePeerConnection): WebRtcPeerPort {
  return {
    onChannel: listener => peer.onDataChannel(channel => listener(channelPort(channel))),
    onClosed: listener => {
      const ended = once(listener);
      peer.onStateChange(state => {
        if (state === 'failed' || state === 'closed') ended();
      });
    },
    close: () => {
      try {
        peer.close();
      } catch {
        // Already gone on the native side; there is nothing left to release.
      }
    },
  };
}

export class NodeDataChannelEngine implements WebRtcEnginePort, WebRtcPeerEngine {
  private readonly load: NodeDataChannelLoader;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly gatherCapMs: number;
  private readonly reflexiveGraceMs: number;
  #loaded: Promise<NodeDataChannelModule> | undefined;

  constructor(options: NodeDataChannelEngineOptions = {}) {
    this.load = options.load ?? loadNodeDataChannel;
    this.timeoutMs = options.timeoutMs ?? WEBRTC_SELF_TEST_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
    this.gatherCapMs = options.gatherCapMs ?? WEBRTC_GATHER_CAP_MS;
    this.reflexiveGraceMs = options.reflexiveGraceMs ?? WEBRTC_GATHER_REFLEXIVE_GRACE_MS;
  }

  /** The library, loaded once. A failed load is not cached, so the next ask tries again. */
  #module(): Promise<NodeDataChannelModule> {
    this.#loaded ??= this.load().catch(error => {
      this.#loaded = undefined;
      throw error;
    });
    return this.#loaded;
  }

  /**
   * Answer one offer, non-trickle, within §16's gathering bounds.
   *
   * libdatachannel answers by itself once the remote offer is set (auto-negotiation), and gathers in the
   * background; this waits for the FIRST of gathering `complete`, a short grace after the first
   * server-reflexive candidate, or the cap, and then reads the description as it stands — so the answer
   * carries the host candidates and every public address found by then.
   */
  async answer(offerSdp: string, iceServers: readonly string[]): Promise<WebRtcAnswer> {
    const module = await this.#module();
    const peer = new module.PeerConnection('fy-webrtc-peer', { iceServers: [...iceServers] });
    const gathered = new Promise<void>(resolve => {
      const cap = setTimeout(resolve, this.gatherCapMs);
      let grace: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        clearTimeout(cap);
        clearTimeout(grace);
        resolve();
      };
      peer.onGatheringStateChange(state => {
        if (state === 'complete') done();
      });
      peer.onLocalCandidate(candidate => {
        if (grace === undefined && / typ srflx( |$)/u.test(candidate)) grace = setTimeout(done, this.reflexiveGraceMs);
      });
    });
    try {
      peer.setRemoteDescription(offerSdp, 'offer' as never);
    } catch (error) {
      peerPort(peer).close();
      throw new WebRtcOfferRefused(firstLine(error));
    }
    await gathered;
    const local = peer.localDescription();
    if (local === null || local.type !== 'answer') {
      peerPort(peer).close();
      throw new WebRtcOfferRefused('the engine produced no answer for that offer');
    }
    return { sdp: local.sdp, peer: peerPort(peer) };
  }

  async selfTest(): Promise<WebRtcEngineReport> {
    let module: NodeDataChannelModule;
    try {
      module = await this.#module();
    } catch (error) {
      return {
        kind: 'unavailable',
        reason: `the WebRTC engine could not be loaded on ${process.platform}-${process.arch} (${firstLine(error)})`,
      };
    }
    const started = this.now();
    const echoed = await this.#echoBetweenLoopbackPeers(module);
    if (echoed !== true) return { kind: 'unavailable', reason: echoed };
    return {
      kind: 'ready',
      library: `libdatachannel ${module.getLibraryVersion()}`,
      selfTestMs: this.now() - started,
    };
  }

  /**
   * Two peers, one channel, one echo — or the sentence saying which part did not happen in time.
   *
   * Bound to 127.0.0.1 with no ICE server, so the test gathers loopback candidates only: it sends
   * nothing to the network, asks no STUN server anything, and works on a machine with no route out.
   */
  #echoBetweenLoopbackPeers(module: NodeDataChannelModule): Promise<true | string> {
    const config = { iceServers: [], bindAddress: '127.0.0.1' };
    let offerer: EnginePeerConnection | undefined;
    let answerer: EnginePeerConnection | undefined;
    const closeAll = (): void => {
      for (const peer of [offerer, answerer]) {
        try {
          peer?.close();
        } catch {
          // A peer that cannot close has nothing left to report; the verdict is already decided.
        }
      }
    };
    return new Promise<true | string>(resolve => {
      let settled = false;
      const settle = (verdict: true | string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        closeAll();
        resolve(verdict);
      };
      const timer = setTimeout(
        () => settle(`two local WebRTC peers did not connect and echo within ${this.timeoutMs} ms`),
        this.timeoutMs,
      );
      try {
        // Each peer is recorded the moment it exists, so one that is followed by a refused second is
        // still closed rather than left holding a socket for the life of the process.
        const local = new module.PeerConnection('fy-self-test-offer', config);
        offerer = local;
        const remote = new module.PeerConnection('fy-self-test-answer', config);
        answerer = remote;
        local.onLocalDescription((sdp, type) => remote.setRemoteDescription(sdp, type as never));
        remote.onLocalDescription((sdp, type) => local.setRemoteDescription(sdp, type as never));
        local.onLocalCandidate((candidate, mid) => remote.addRemoteCandidate(candidate, mid));
        remote.onLocalCandidate((candidate, mid) => local.addRemoteCandidate(candidate, mid));
        remote.onDataChannel(channel => channel.onMessage(message => channel.sendMessage(String(message))));
        const channel = local.createDataChannel(WEBRTC_SELF_TEST_CHANNEL);
        channel.onOpen(() => channel.sendMessage(WEBRTC_SELF_TEST_CHANNEL));
        channel.onMessage(message =>
          settle(String(message) === WEBRTC_SELF_TEST_CHANNEL ? true : 'the WebRTC self-test echoed the wrong message'),
        );
      } catch (error) {
        settle(`the WebRTC engine loaded but could not open a peer (${firstLine(error)})`);
      }
    });
  }
}
