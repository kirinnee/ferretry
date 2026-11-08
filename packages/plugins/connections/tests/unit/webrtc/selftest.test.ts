import { describe, it } from 'bun:test';
import should from 'should';
import type { SelftestEnvironment } from '@ferretry/kernel/manifest';
import type {
  EngineDataChannel,
  EnginePeerConnection,
  NodeDataChannelModule,
} from '../../../daemon/adapters/webrtc/node-datachannel-engine.ts';
import {
  switchedWebrtcSelftest,
  webrtcSelftestProbe,
  webrtcSwitchedOn,
} from '../../../daemon/adapters/webrtc/selftest.ts';
import manifest from '../../../manifest.ts';
import implementation from '../../../daemon/index.ts';

const environment: SelftestEnvironment = {
  tempDir: '/nowhere',
  signal: new AbortController().signal,
  clock: { nowMs: () => 0, after: () => () => {} },
};

/** A library whose first peer echoes at once: it is the probe's wording that is under test, not libdatachannel. */
function echoingModule(cleanups: string[]): NodeDataChannelModule {
  class Channel implements EngineDataChannel {
    opened: (() => void) | undefined;
    received: ((message: string | ArrayBuffer | Buffer) => void) | undefined;
    sent = '';
    getLabel = (): string => 'fy-self-test';
    onClosed(): void {}
    sendMessageBinary = (): boolean => true;
    bufferedAmount = (): number => 0;
    onOpen(callback: () => void): void {
      this.opened = callback;
    }
    onMessage(callback: (message: string | ArrayBuffer | Buffer) => void): void {
      this.received = callback;
    }
    sendMessage(message: string): boolean {
      this.sent = message;
      return true;
    }
    close(): void {}
  }
  class Peer implements EnginePeerConnection {
    onLocalDescription(): void {}
    onLocalCandidate(): void {}
    onGatheringStateChange(): void {}
    onStateChange(): void {}
    localDescription = (): null => null;
    onDataChannel(): void {}
    setRemoteDescription(): void {}
    addRemoteCandidate(): void {}
    createDataChannel(): EngineDataChannel {
      const channel = new Channel();
      queueMicrotask(() => {
        channel.opened?.();
        channel.received?.(channel.sent);
      });
      return channel;
    }
    close(): void {}
  }
  return { PeerConnection: Peer, getLibraryVersion: () => '9.9.9', cleanup: () => void cleanups.push('cleanup') };
}

describe('Connections declares the one webrtc engine selftest (R689)', () => {
  it('should declare exactly one selftest, labelled webrtc, and implement it', () => {
    // Assert
    should(manifest.selftest).deepEqual(['webrtc']);
    should(Object.keys(implementation.selftest ?? {})).deepEqual(['webrtc']);
    should(implementation.selftest?.webrtc?.label).equal('webrtc');
  });

  it('R689 should say engine ready and release the library when two peers echo', async () => {
    // Arrange
    const cleanups: string[] = [];
    const subject = webrtcSelftestProbe(async () => echoingModule(cleanups));

    // Act
    const actual = await subject.run(environment);

    // Assert
    should(actual).match(/^engine ready — libdatachannel 9\.9\.9; two local peers connected and echoed in \d+ ms$/u);
    should(cleanups).deepEqual(['cleanup']);
  });

  it('R689 should say the engine is unavailable, and why, when the library will not load', async () => {
    // Arrange
    const subject = webrtcSelftestProbe(async () => {
      throw new Error('no addon for this target');
    });

    // Act
    const actual = await subject.run(environment);

    // Assert
    should(actual).startWith('engine unavailable — the WebRTC engine could not be loaded on ');
    should(actual).containEql('no addon for this target');
  });
});

describe('webrtc selftest: switched by connections.yaml (kernel SelftestProbe.enabledBy, R689 parity)', () => {
  it('R689 should be switched by Connections’ OWN connections.yaml def, with today’s consequence', () => {
    // Arrange
    const enabledBy = implementation.selftest?.webrtc?.enabledBy;

    // Assert
    should(enabledBy?.def).equal(manifest.data.config[0]);
    should(enabledBy?.consequence).equal('devices reach this daemon directly or through the relay instead');
  });

  it('R689 should be on unless WebRTC says enabled: false', () => {
    should(webrtcSwitchedOn({})).equal(true);
    should(webrtcSwitchedOn({ webrtc: { enabled: true, iceServers: [] } })).equal(true);
    should(webrtcSwitchedOn({ webrtc: { enabled: false, iceServers: [] } })).equal(false);
  });

  it('R689 should keep the probe itself unchanged: the same label and run', () => {
    const probe = webrtcSelftestProbe();
    const switched = switchedWebrtcSelftest(manifest.data.config[0] as never, probe);
    should(switched.label).equal(probe.label);
    should(switched.run).equal(probe.run);
  });
});
