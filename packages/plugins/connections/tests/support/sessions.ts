import type {
  CarrierKey,
  CarrierLink,
  CarrierPeer,
  SealedFrame,
  SessionEnd,
  SessionLayer,
} from '@ferretry/kernel/contract';
export class FakeLink implements CarrierLink {
  readonly inbounds: Uint8Array[] = [];
  readonly queue: (SealedFrame | SessionEnd | undefined)[] = [];
  readonly listeners = new Set<() => void>();
  closedWith: string | undefined;
  pulls = 0;
  readonly outbound = {
    next: () => {
      this.pulls++;
      return this.queue.shift();
    },
    onReady: (fn: () => void) => {
      this.listeners.add(fn);
      return () => {
        this.listeners.delete(fn);
      };
    },
  };
  inbound(bytes: Uint8Array): void {
    this.inbounds.push(bytes);
  }
  closed(reason: string): void {
    this.closedWith = reason;
  }
  offer(...frames: (SealedFrame | SessionEnd | undefined)[]): void {
    this.queue.push(...frames);
    for (const fn of this.listeners) fn();
  }
}
export class FakeSessions implements SessionLayer {
  readonly signer: SessionLayer['signer'] = {
    sign: async () => {
      throw new Error('not used by this fixture');
    },
    signTunnel: async () => {
      throw new Error('not used by this fixture');
    },
    signCatalog: async () => {
      throw new Error('not used by this fixture');
    },
    signLinkStoreRequest: async () => {
      throw new Error('not used by this fixture');
    },
    signSecretOffer: async () => {
      throw new Error('not used by this fixture');
    },
  };
  readonly links: FakeLink[] = [];
  readonly carriers: CarrierKey[] = [];
  readonly peers: (CarrierPeer | undefined)[] = [];
  open(carrier: CarrierKey, peer?: CarrierPeer): FakeLink {
    const link = new FakeLink();
    this.links.push(link);
    this.carriers.push(carrier);
    this.peers.push(peer);
    return link;
  }
  /** Every shared connection a carrier asked for (one per rendezvous socket), with the links opened on it. */
  readonly connections: { readonly carrier: CarrierKey; readonly links: FakeLink[] }[] = [];
  connection(carrier: CarrierKey): { open(peer?: CarrierPeer): FakeLink } {
    const record = { carrier, links: [] as FakeLink[] };
    this.connections.push(record);
    return {
      open: peer => {
        const link = this.open(carrier, peer);
        record.links.push(link);
        return link;
      },
    };
  }
}
