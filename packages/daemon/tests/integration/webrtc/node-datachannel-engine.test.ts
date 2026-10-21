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
import { WEBRTC_SELF_TEST_CHANNEL } from '../../../src/lib/webrtc/index.ts';

/** A data channel that records what it was sent and lets a case decide what comes back. */
class FakeChannel implements EngineDataChannel {
  opened: (() => void) | undefined;
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
