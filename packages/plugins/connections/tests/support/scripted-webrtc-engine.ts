import type {
  EngineDataChannel,
  EnginePeerConnection,
  NodeDataChannelModule,
} from '../../daemon/adapters/webrtc/index.ts';

/** A peer whose gathering a case scripts: what it announces, and what description it ends with. */
export function scriptedModule(script: {
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
  return { module: { PeerConnection: Peer, getLibraryVersion: () => '9.9.9', cleanup: () => undefined }, peers };
}
export type ScriptedPeer = EnginePeerConnection & {
  gathering: ((state: string) => void) | undefined;
  candidate: ((candidate: string, mid: string) => void) | undefined;
  stateListener: ((state: string) => void) | undefined;
  channelListener: ((channel: EngineDataChannel) => void) | undefined;
  closed: number;
};
