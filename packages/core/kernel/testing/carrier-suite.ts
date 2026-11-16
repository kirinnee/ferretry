import { describe, expect, test } from 'bun:test';
import type { CarrierKey } from '../contract/ids.ts';
import type {
  Carrier,
  CarrierLink,
  CarrierPeer as SessionPeer,
  IdentitySigner,
  SealedFrame,
  SealedOutbound,
  SessionEnd,
  SessionLayer,
} from '../contract/session.ts';
import { createIdentitySigner } from '../host/session/signer.ts';
import { encodeFrame, FRAME_KINDS, type SessionId, sessionIdFromBytes } from '../host/session/wire/frames.ts';
import { type TestIdentity, testIdentity } from './identity.ts';

/** The far end of a carrier's own transport, driven by the suite (a WebSocket client, a relay peer, a data channel). */
export interface CarrierPeer {
  send(bytes: Uint8Array): void;
  /** Every byte message the carrier delivered to this peer, in order. */
  received(): readonly Uint8Array[];
  close(): void;
  closed(): boolean;
}

/** What one carrier implementation hands the suite. */
export interface CarrierHarness {
  readonly carrier: Carrier;
  readonly key: CarrierKey;
  /** Opens one peer through the carrier's transport, after `start` resolved. */
  connect(): Promise<CarrierPeer>;
  /** Waits for the transport's pending I/O (a few event-loop turns for in-memory transports). */
  flush(): Promise<void>;
  dispose?(): Promise<void>;
}

/** A recording session layer: each link's inbound bytes, its outbound queue the suite fills, and its close reason. */
export class RecordingSessionLayer implements SessionLayer {
  readonly links: RecordingLink[] = [];
  readonly carriers: CarrierKey[] = [];
  /** What the carrier said about each link's peer, in open order. */
  readonly peers: (SessionPeer | undefined)[] = [];
  /** A real signer over a throwaway identity ({@link testIdentity}), so a carrier's claim can be verified. */
  readonly signer: IdentitySigner;
  readonly identity: Promise<TestIdentity>;

  constructor() {
    this.identity = testIdentity();
    const identity = this.identity;
    const signer = identity.then(created => createIdentitySigner(created.key));
    this.signer = {
      sign: async request => await (await signer).sign(request),
      signTunnel: async request => await (await signer).signTunnel(request),
      signCatalog: async request => await (await signer).signCatalog(request),
      signLinkStoreRequest: async request => await (await signer).signLinkStoreRequest(request),
      signSecretOffer: async request => await (await signer).signSecretOffer(request),
    };
  }

  /** Every connection a carrier asked for, with the links opened on it. */
  readonly connections: { readonly carrier: CarrierKey; readonly links: RecordingLink[] }[] = [];

  connection(carrier: CarrierKey): { open(peer?: SessionPeer): CarrierLink } {
    const record = { carrier, links: [] as RecordingLink[] };
    this.connections.push(record);
    return {
      open: peer => {
        const link = this.open(carrier, peer) as RecordingLink;
        record.links.push(link);
        return link;
      },
    };
  }

  open(carrier: CarrierKey, peer?: SessionPeer): CarrierLink {
    this.carriers.push(carrier);
    this.peers.push(peer);
    const link = new RecordingLink();
    this.links.push(link);
    return link;
  }

  /** As the kernel does when a mode accepted the holder of link `index`: calls the peer's `proved`. */
  prove(index: number): void {
    this.peers[index]?.proved?.();
  }
}

export class RecordingLink implements CarrierLink {
  readonly inbounds: Uint8Array[] = [];
  closedWith: string | undefined;
  /** What `next()` will answer, in order: a frame, `undefined` (nothing may leave now) or a {@link SessionEnd} (the session is over). */
  readonly queue: (SealedFrame | SessionEnd | undefined)[] = [];
  nextCalls = 0;
  private readonly listeners = new Set<() => void>();
  readonly outbound: SealedOutbound = {
    next: () => {
      this.nextCalls++;
      return this.queue.length === 0 ? undefined : this.queue.shift();
    },
    onReady: listener => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  inbound(bytes: Uint8Array): void {
    this.inbounds.push(bytes);
  }
  closed(reason: string): void {
    this.closedWith = reason;
  }
  /** Queues and signals ready, as the session layer does when a sealed frame may leave. */
  offer(...items: (SealedFrame | SessionEnd | undefined)[]): void {
    this.queue.push(...items);
    for (const listener of this.listeners) listener();
  }
}

const ENDED: SessionEnd = Object.freeze({ code: 4400, reason: 'the session ended' });
/** The session id every suite frame carries: sixteen fixed bytes, so a carrier that routes by it sees one session. */
export const SUITE_SESSION_ID: SessionId = (() => {
  const id = sessionIdFromBytes(Uint8Array.from({ length: 16 }, (_, index) => index + 1));
  if (id === null) throw new Error('suite session id');
  return id;
})();

/**
 * A VALID wire frame (the 28-byte envelope a real direct or relay carrier checks) carrying `payload` as a data
 * record, built with the real encoder: what the suite sends and offers, so a real carrier can run it unchanged.
 */
export function suiteFrame(sequence: number, payload: string, sessionId: SessionId = SUITE_SESSION_ID): Uint8Array {
  return encodeFrame({ kind: FRAME_KINDS.data, sessionId, sequence, payload: new TextEncoder().encode(payload) });
}

/** How the suite builds the frames it sends and offers; a carrier with its own envelope supplies its encoder. */
export interface CarrierSuiteOptions {
  readonly frame?: (sequence: number, payload: string) => Uint8Array;
}

/**
 * The carrier conformance suite (§3.9, §4.8, §7.3): a carrier moves only sealed bytes, opens one link per peer under
 * its own key, takes outbound frames ONLY from `next()` at write time (so the session layer's per-frame permit is the
 * last word), writes nothing when `next()` answers nothing, ends the peer on a `SessionEnd`, and closes every link when
 * stopped or when the peer goes. Every carrier plugin runs this against its own harness.
 */
export function carrierConformance(
  name: string,
  make: (layer: RecordingSessionLayer) => Promise<CarrierHarness>,
  options: CarrierSuiteOptions = {},
): void {
  const bytesOf = options.frame ?? ((sequence: number, payload: string) => suiteFrame(sequence, payload));
  const frame = (sequence: number, payload: string): SealedFrame => ({ sequence, bytes: bytesOf(sequence, payload) });
  describe(`carrier conformance: ${name}`, () => {
    const started = async (): Promise<{
      layer: RecordingSessionLayer;
      harness: CarrierHarness;
      abort: AbortController;
    }> => {
      const layer = new RecordingSessionLayer();
      const harness = await make(layer);
      const abort = new AbortController();
      await harness.carrier.start(layer, abort.signal);
      return { layer, harness, abort };
    };
    const done = async (h: { harness: CarrierHarness; abort: AbortController }): Promise<void> => {
      h.abort.abort();
      await h.harness.flush();
      await h.harness.dispose?.();
    };

    test('reports ready after start and a sentence for its state', async () => {
      const h = await started();
      const status = h.harness.carrier.status();
      expect(status.state).toBe('ready');
      expect(status.sentence.length).toBeGreaterThan(0);
      await done(h);
    });

    test('opens exactly one link per peer, under its own key', async () => {
      const h = await started();
      await h.harness.connect();
      await h.harness.connect();
      await h.harness.flush();
      expect(h.layer.links.length).toBe(2);
      expect(h.layer.carriers).toEqual([h.harness.key, h.harness.key]);
      await done(h);
    });

    test('hands inbound bytes to the session layer unchanged and in order', async () => {
      const h = await started();
      const peer = await h.harness.connect();
      const one = bytesOf(1, 'one');
      const two = bytesOf(2, 'two');
      peer.send(one);
      peer.send(two);
      await h.harness.flush();
      expect(h.layer.links[0]?.inbounds ?? []).toEqual([one, two]);
      await done(h);
    });

    test('writes exactly the frames next() answers, in order, asking next() at write time', async () => {
      const h = await started();
      const peer = await h.harness.connect();
      await h.harness.flush();
      const link = h.layer.links[0] as RecordingLink;
      const a = frame(1, 'a');
      const b = frame(2, 'b');
      link.offer(a, b);
      await h.harness.flush();
      expect(peer.received()).toEqual([a.bytes, b.bytes]);
      expect(link.nextCalls).toBeGreaterThanOrEqual(2);
      await done(h);
    });

    test('writes nothing when next() answers nothing (the permit said no)', async () => {
      const h = await started();
      const peer = await h.harness.connect();
      await h.harness.flush();
      const link = h.layer.links[0] as RecordingLink;
      link.offer(undefined);
      await h.harness.flush();
      expect(peer.received()).toEqual([]);
      expect(peer.closed()).toBe(false);
      await done(h);
    });

    test('ends the peer when next() answers a SessionEnd', async () => {
      const h = await started();
      const peer = await h.harness.connect();
      await h.harness.flush();
      (h.layer.links[0] as RecordingLink).offer(ENDED);
      await h.harness.flush();
      expect(peer.closed()).toBe(true);
      await done(h);
    });

    test('tells the session layer when the peer goes', async () => {
      const h = await started();
      const peer = await h.harness.connect();
      await h.harness.flush();
      peer.close();
      await h.harness.flush();
      expect(h.layer.links[0]?.closedWith).toBeDefined();
      await done(h);
    });

    test('closes every link and stops being ready when stopped', async () => {
      const h = await started();
      await h.harness.connect();
      await h.harness.flush();
      h.abort.abort();
      await h.harness.flush();
      expect(h.layer.links.every(link => link.closedWith !== undefined)).toBe(true);
      expect(h.harness.carrier.status().state).not.toBe('ready');
      await h.harness.dispose?.();
    });
  });
}
