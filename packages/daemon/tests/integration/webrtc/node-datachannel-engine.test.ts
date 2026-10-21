/**
 * The WebRTC engine's self-test, against the REAL libdatachannel wherever the property is the engine.
 *
 * The ready case runs the actual native addon this daemon ships: two peers on loopback, a data
 * channel, an echo. That is the claim `fyd --check` makes on every machine, so it is proved with the
 * library rather than a picture of it. The failure cases substitute the module, because the point of
 * each is what the adapter SAYS when the library is missing, broken, or silent — states a working
 * install cannot be put into on demand.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  type EngineDataChannel,
  type EnginePeerConnection,
  NodeDataChannelEngine,
  type NodeDataChannelModule,
} from '../../../src/adapters/webrtc/index.ts';
import { WEBRTC_SELF_TEST_CHANNEL, WebRtcOfferRefused } from '../../../src/lib/webrtc/index.ts';

/** A data channel that records what it was sent and lets a case decide what comes back. */
class FakeChannel implements EngineDataChannel {
  opened: (() => void) | undefined;
  getLabel(): string {
    return WEBRTC_SELF_TEST_CHANNEL;
  }
  onClosed(): void {}
  sendMessageBinary(): boolean {
    return true;
  }
  bufferedAmount(): number {
    return 0;
  }
  received: ((message: string | ArrayBuffer | Buffer) => void) | undefined;
  readonly sent: string[] = [];

  onOpen(callback: () => void): void {
    this.opened = callback;
  }

  onMessage(callback: (message: string | ArrayBuffer | Buffer) => void): void {
    this.received = callback;
  }

  sendMessage(message: string): boolean {
    this.sent.push(message);
    return true;
  }

  close(): void {}
}

/** A module whose offering peer opens one channel and hands it to `script`; nothing else happens. */
function fakeModule(
  script: (channel: FakeChannel) => void,
  options: { readonly closeThrows?: boolean } = {},
): { readonly module: NodeDataChannelModule; readonly closed: string[] } {
  const closed: string[] = [];
  class FakePeer implements EnginePeerConnection {
    constructor(private readonly name: string) {}
    onLocalDescription(): void {}
    onLocalCandidate(): void {}
    onGatheringStateChange(): void {}
    onStateChange(): void {}
    localDescription(): null {
      return null;
    }
    onDataChannel(): void {}
    setRemoteDescription(): void {}
    addRemoteCandidate(): void {}
    createDataChannel(): EngineDataChannel {
      const channel = new FakeChannel();
      queueMicrotask(() => script(channel));
      return channel;
    }
    close(): void {
      closed.push(this.name);
      if (options.closeThrows === true) throw new Error('already closed');
    }
  }
  return { module: { PeerConnection: FakePeer, getLibraryVersion: () => '9.9.9' }, closed };
}

describe('the node-datachannel WebRTC engine', () => {
  it('should prove the real native engine by echoing between two loopback peers', async () => {
    // Arrange
    const subject = new NodeDataChannelEngine();

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual.kind).equal('ready');
    if (actual.kind !== 'ready') return;
    should(actual.library).match(/^libdatachannel \d+\.\d+\.\d+/u);
    should(actual.selfTestMs).be.aboveOrEqual(0).and.below(5_000);
  });

  it('should time the self-test on the injected clock, from the peers to the echo', async () => {
    // Arrange
    const ticks = [100, 142];
    const { module, closed } = fakeModule(channel => {
      channel.opened?.();
      channel.received?.(channel.sent[0] ?? '');
    });
    const subject = new NodeDataChannelEngine({ load: async () => module, now: () => ticks.shift() ?? 0 });

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual).deepEqual({ kind: 'ready', library: 'libdatachannel 9.9.9', selfTestMs: 42 });
    should(closed).deepEqual(['fy-self-test-offer', 'fy-self-test-answer']);
  });

  it('should report an engine that cannot be loaded as unavailable, naming the platform and the first line', async () => {
    // Arrange
    const subject = new NodeDataChannelEngine({
      load: async () => {
        throw new Error('Cannot load native addon\n    at loadBinding (node-datachannel.mjs:64)');
      },
    });

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual).deepEqual({
      kind: 'unavailable',
      reason: `the WebRTC engine could not be loaded on ${process.platform}-${process.arch} (Cannot load native addon)`,
    });
  });

  it('should report a load failure that threw something other than an Error', async () => {
    // Arrange
    const subject = new NodeDataChannelEngine({
      load: () => Promise.reject('dlopen failed'),
    });

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual).deepEqual({
      kind: 'unavailable',
      reason: `the WebRTC engine could not be loaded on ${process.platform}-${process.arch} (dlopen failed)`,
    });
  });

  it('should report peers that never connect within the deadline, and still close them', async () => {
    // Arrange
    const { module, closed } = fakeModule(() => undefined);
    const subject = new NodeDataChannelEngine({ load: async () => module, timeoutMs: 20 });

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual).deepEqual({
      kind: 'unavailable',
      reason: 'two local WebRTC peers did not connect and echo within 20 ms',
    });
    should(closed).deepEqual(['fy-self-test-offer', 'fy-self-test-answer']);
  });

  it('should report an echo that came back different, and ignore anything after the verdict', async () => {
    // Arrange
    const { module } = fakeModule(channel => {
      channel.received?.('not the probe');
      channel.received?.(WEBRTC_SELF_TEST_CHANNEL);
    });
    const subject = new NodeDataChannelEngine({ load: async () => module });

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual).deepEqual({ kind: 'unavailable', reason: 'the WebRTC self-test echoed the wrong message' });
  });

  it('should report a peer the engine refused to create, and survive a peer that will not close', async () => {
    // Arrange
    const { module: base } = fakeModule(() => undefined, { closeThrows: true });
    let created = 0;
    const module: NodeDataChannelModule = {
      getLibraryVersion: base.getLibraryVersion,
      PeerConnection: class extends base.PeerConnection {
        constructor(name: string, config: { readonly iceServers: string[]; readonly bindAddress?: string }) {
          super(name, config);
          created += 1;
          if (created === 2) throw new Error('no free port');
        }
      },
    };
    const subject = new NodeDataChannelEngine({ load: async () => module });

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual).deepEqual({
      kind: 'unavailable',
      reason: 'the WebRTC engine loaded but could not open a peer (no free port)',
    });
  });
});

/** A peer whose gathering a case scripts: what it announces, and what description it ends with. */
function scriptedModule(script: {
  readonly onRemote?: (peer: ScriptedPeer) => void;
  readonly description?: { readonly sdp: string; readonly type: string } | null;
  readonly refuseRemote?: boolean;
}): { readonly module: NodeDataChannelModule; readonly peers: ScriptedPeer[] } {
  const peers: ScriptedPeer[] = [];
  class Peer implements EnginePeerConnection {
    gathering: ((state: string) => void) | undefined;
    candidate: ((candidate: string, mid: string) => void) | undefined;
    stateListener: ((state: string) => void) | undefined;
    channelListener: ((channel: EngineDataChannel) => void) | undefined;
    closed = 0;
    constructor() {
      peers.push(this);
    }
    onLocalDescription(): void {}
    onLocalCandidate(callback: (candidate: string, mid: string) => void): void {
      this.candidate = callback;
    }
    onGatheringStateChange(callback: (state: string) => void): void {
      this.gathering = callback;
    }
    onStateChange(callback: (state: string) => void): void {
      this.stateListener = callback;
    }
    onDataChannel(callback: (channel: EngineDataChannel) => void): void {
      this.channelListener = callback;
    }
    setRemoteDescription(): void {
      if (script.refuseRemote === true) throw new Error('Invalid SDP\n  at native');
      script.onRemote?.(this);
    }
    localDescription(): { readonly sdp: string; readonly type: string } | null {
      return script.description === undefined ? { sdp: 'scripted answer', type: 'answer' } : script.description;
    }
    addRemoteCandidate(): void {}
    createDataChannel(): EngineDataChannel {
      throw new Error('not used');
    }
    close(): void {
      this.closed += 1;
      throw new Error('already closed');
    }
  }
  return { module: { PeerConnection: Peer, getLibraryVersion: () => '9.9.9' }, peers };
}
type ScriptedPeer = EnginePeerConnection & {
  gathering: ((state: string) => void) | undefined;
  candidate: ((candidate: string, mid: string) => void) | undefined;
  stateListener: ((state: string) => void) | undefined;
  channelListener: ((channel: EngineDataChannel) => void) | undefined;
  closed: number;
};

describe('the node-datachannel engine answering an offer', () => {
  it('should refuse an offer the real engine cannot parse, as a refusal rather than a fault', async () => {
    // Arrange
    const subject = new NodeDataChannelEngine();

    // Act + Assert
    await should(subject.answer('this is not an SDP', [])).be.rejectedWith(WebRtcOfferRefused);
  });

  it('should answer as soon as gathering completes, and only with an answer', async () => {
    // Arrange
    const { module } = scriptedModule({ onRemote: peer => queueMicrotask(() => peer.gathering?.('complete')) });
    const subject = new NodeDataChannelEngine({ load: async () => module, gatherCapMs: 60_000 });

    // Act
    const actual = await subject.answer('offer', ['stun:stun.example.test']);

    // Assert
    should(actual.sdp).equal('scripted answer');
  });

  it('should answer a short grace after the first public address, without waiting for complete', async () => {
    // Arrange — a host candidate starts nothing; the first srflx starts the grace, a second one does not restart it.
    const { module } = scriptedModule({
      onRemote: peer =>
        queueMicrotask(() => {
          peer.gathering?.('in-progress');
          peer.candidate?.('a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host', '0');
          peer.candidate?.('a=candidate:2 1 UDP 1 198.51.100.7 6000 typ srflx raddr 0.0.0.0 rport 0', '0');
          peer.candidate?.('a=candidate:3 1 UDP 1 198.51.100.8 6001 typ srflx', '0');
        }),
    });
    const subject = new NodeDataChannelEngine({ load: async () => module, gatherCapMs: 60_000, reflexiveGraceMs: 5 });

    // Act
    const started = performance.now();
    const actual = await subject.answer('offer', []);

    // Assert
    should(actual.sdp).equal('scripted answer');
    should(performance.now() - started).be.below(5_000);
  });

  it('should answer with what it has at the cap when gathering never settles', async () => {
    // Arrange
    const { module } = scriptedModule({});
    const subject = new NodeDataChannelEngine({ load: async () => module, gatherCapMs: 10 });

    // Act
    const actual = await subject.answer('offer', []);

    // Assert
    should(actual.sdp).equal('scripted answer');
  });

  it.each([
    ['no description at all', null],
    ['a description that is not an answer', { sdp: 'x', type: 'offer' }],
  ])('should refuse an offer that left the engine with %s, and close the peer', async (_name, description) => {
    // Arrange
    const { module, peers } = scriptedModule({ description, onRemote: peer => peer.gathering?.('complete') });
    const subject = new NodeDataChannelEngine({ load: async () => module });

    // Act + Assert
    await should(subject.answer('offer', [])).be.rejectedWith('the engine produced no answer for that offer');
    should(peers[0]?.closed).equal(1);
  });

  it('should refuse an offer the engine threw on, naming its first line, and close the peer', async () => {
    // Arrange
    const { module, peers } = scriptedModule({ refuseRemote: true });
    const subject = new NodeDataChannelEngine({ load: async () => module });

    // Act + Assert
    await should(subject.answer('offer', [])).be.rejectedWith('Invalid SDP');
    should(peers[0]?.closed).equal(1);
  });

  it('should load the library once, and try again after a load that failed', async () => {
    // Arrange
    const { module } = scriptedModule({ onRemote: peer => peer.gathering?.('complete') });
    let loads = 0;
    const subject = new NodeDataChannelEngine({
      load: async () => {
        loads += 1;
        if (loads === 1) throw new Error('first load fails');
        return module;
      },
    });

    // Act
    await should(subject.answer('offer', [])).be.rejectedWith('first load fails');
    await subject.answer('offer', []);
    await subject.answer('offer', []);

    // Assert
    should(loads).equal(2);
  });

  it('should hand the carrier guarded channels and a peer that ends once, on failure or close only', async () => {
    // Arrange
    const { module, peers } = scriptedModule({ onRemote: peer => peer.gathering?.('complete') });
    const subject = new NodeDataChannelEngine({ load: async () => module });
    const { peer } = await subject.answer('offer', []);
    const native = peers[0] as ScriptedPeer;
    const ends: string[] = [];
    peer.onClosed(() => ends.push('ended'));
    const received: Array<string | Uint8Array> = [];
    let closedChannel = 0;
    const listeners: { message?: (message: string | ArrayBuffer | Buffer) => void; closed?: () => void } = {};
    const broken: EngineDataChannel = {
      getLabel: () => 'fy-session',
      onOpen: () => undefined,
      onMessage: callback => {
        listeners.message = callback;
      },
      onClosed: callback => {
        listeners.closed = callback;
      },
      sendMessage: () => {
        throw new Error('channel is closed');
      },
      sendMessageBinary: () => {
        throw new Error('channel is closed');
      },
      bufferedAmount: () => {
        throw new Error('channel is closed');
      },
      close: () => {
        throw new Error('channel is closed');
      },
    };
    const working: EngineDataChannel = {
      ...broken,
      sendMessage: () => true,
      sendMessageBinary: () => true,
      bufferedAmount: () => 2048,
      close: () => undefined,
    };
    const ports: Parameters<Parameters<typeof peer.onChannel>[0]>[0][] = [];
    peer.onChannel(port => {
      ports.push(port);
      port.onMessage(frame => received.push(frame));
      port.onClosed(() => (closedChannel += 1));
    });

    // Act
    native.channelListener?.(broken);
    native.channelListener?.(working);
    const [brokenPort, workingPort] = ports;
    const outcomes = [
      brokenPort?.send(new Uint8Array(2)),
      brokenPort?.sendText('fy-ping'),
      brokenPort?.bufferedBytes(),
      workingPort?.send(new Uint8Array(2)),
      workingPort?.sendText('fy-ping'),
      workingPort?.bufferedBytes(),
    ];
    brokenPort?.close();
    listeners.message?.('fy-pong');
    listeners.message?.(new Uint8Array([1, 2]).buffer);
    listeners.message?.(Buffer.from([3, 4, 5]));
    listeners.closed?.();
    listeners.closed?.();
    native.stateListener?.('connecting');
    native.stateListener?.('disconnected');
    native.stateListener?.('failed');
    native.stateListener?.('closed');
    peer.close();

    // Assert
    should(brokenPort?.label).equal('fy-session');
    should(outcomes).deepEqual([false, false, 0, true, true, 2048]);
    should(received).deepEqual(['fy-pong', new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]);
    should(closedChannel).equal(1);
    should(ends).deepEqual(['ended']);
    should(native.closed).equal(1);
  });
});
