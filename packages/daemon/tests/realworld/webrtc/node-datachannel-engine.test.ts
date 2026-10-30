// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type EngineDataChannel,
  type EnginePeerConnection,
  NodeDataChannelEngine,
  type NodeDataChannelModule,
} from '../../../src/adapters/webrtc/index.ts';

describe('the node-datachannel WebRTC engine', () => {
  it('should prove the real native engine by echoing between two loopback peers', async () => {
    // Arrange
    const subject = new NodeDataChannelEngine();

    // Act
    const actual = await subject.selfTest();

    // Assert
    should(actual.kind).equal('ready');
    if (actual.kind !== 'ready') return;
    should(actual.selfTestMs).be.aboveOrEqual(0).and.below(5_000);
  });
});

describe('the node-datachannel engine answering an offer', () => {
  it('should answer a short grace after the first public address, without waiting for complete', async () => {
    // Arrange — a host candidate starts nothing; the first srflx starts the grace, a second one does not restart it.
    class Peer implements EnginePeerConnection {
      gathering: ((state: string) => void) | undefined;
      candidate: ((candidate: string, mid: string) => void) | undefined;
      onLocalDescription(): void {}
      onLocalCandidate(callback: (candidate: string, mid: string) => void): void {
        this.candidate = callback;
      }
      onGatheringStateChange(callback: (state: string) => void): void {
        this.gathering = callback;
      }
      onStateChange(): void {}
      onDataChannel(): void {}
      setRemoteDescription(): void {
        queueMicrotask(() => {
          this.gathering?.('in-progress');
          this.candidate?.('a=candidate:1 1 UDP 1 192.0.2.1 5000 typ host', '0');
          this.candidate?.('a=candidate:2 1 UDP 1 198.51.100.7 6000 typ srflx raddr 0.0.0.0 rport 0', '0');
          this.candidate?.('a=candidate:3 1 UDP 1 198.51.100.8 6001 typ srflx', '0');
        });
      }
      localDescription(): { readonly sdp: string; readonly type: string } {
        return { sdp: 'scripted answer', type: 'answer' };
      }
      addRemoteCandidate(): void {}
      createDataChannel(): EngineDataChannel {
        throw new Error('not used');
      }
      close(): void {}
    }
    const module: NodeDataChannelModule = {
      PeerConnection: Peer,
      getLibraryVersion: () => '9.9.9',
      cleanup: () => undefined,
    };
    const subject = new NodeDataChannelEngine({ load: async () => module, gatherCapMs: 60_000, reflexiveGraceMs: 5 });

    // Act
    const started = performance.now();
    const actual = await subject.answer('offer', []);

    // Assert
    should(actual.sdp).equal('scripted answer');
    should(performance.now() - started).be.below(5_000);
  });
});
