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

import {
  WEBRTC_SELF_TEST_CHANNEL,
  WEBRTC_SELF_TEST_TIMEOUT_MS,
  type WebRtcEngineReport,
  type WebRtcEnginePort,
} from '../../lib/webrtc/index.ts';

/** The slice of a data channel the self-test touches. */
export interface EngineDataChannel {
  onOpen(callback: () => void): void;
  onMessage(callback: (message: string | ArrayBuffer | Buffer) => void): void;
  sendMessage(message: string): boolean;
  close(): void;
}

/** The slice of a peer connection the self-test touches. */
export interface EnginePeerConnection {
  onLocalDescription(callback: (sdp: string, type: string) => void): void;
  onLocalCandidate(callback: (candidate: string, mid: string) => void): void;
  onDataChannel(callback: (channel: EngineDataChannel) => void): void;
  setRemoteDescription(sdp: string, type: never): void;
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

export class NodeDataChannelEngine implements WebRtcEnginePort {
  private readonly load: NodeDataChannelLoader;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: NodeDataChannelEngineOptions = {}) {
    this.load = options.load ?? loadNodeDataChannel;
    this.timeoutMs = options.timeoutMs ?? WEBRTC_SELF_TEST_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
  }

  async selfTest(): Promise<WebRtcEngineReport> {
    let module: NodeDataChannelModule;
    try {
      module = await this.load();
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
