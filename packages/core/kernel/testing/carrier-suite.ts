import { describe, expect, test } from 'bun:test';
import type { CarrierKey } from '../contract/ids.ts';
import type {
  Carrier,
  CarrierLink,
  SealedFrame,
  SealedOutbound,
  SessionEnd,
  SessionLayer,
} from '../contract/session.ts';

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

  open(carrier: CarrierKey): CarrierLink {
    this.carriers.push(carrier);
    const link = new RecordingLink();
    this.links.push(link);
    return link;
  }
}

export class RecordingLink implements CarrierLink {
  readonly inbounds: Uint8Array[] = [];
  closedWith: string | undefined;
  /** What `next()` will answer, in order: a frame, `undefined` (nothing may leave now) or `'ended'`. */
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
const frame = (sequence: number, text: string): SealedFrame => ({ sequence, bytes: new TextEncoder().encode(text) });
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The carrier conformance suite (§3.9, §4.8, §7.3): a carrier moves only sealed bytes, opens one link per peer under
 * its own key, takes outbound frames ONLY from `next()` at write time (so the session layer's per-frame permit is the
 * last word), writes nothing when `next()` answers nothing, ends the peer on `'ended'`, and closes every link when
 * stopped or when the peer goes. Every carrier plugin runs this against its own harness.
 */
export function carrierConformance(
  name: string,
  make: (layer: RecordingSessionLayer) => Promise<CarrierHarness>,
): void {
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
      peer.send(new TextEncoder().encode('one'));
      peer.send(new TextEncoder().encode('two'));
      await h.harness.flush();
      expect((h.layer.links[0]?.inbounds ?? []).map(decode)).toEqual(['one', 'two']);
      await done(h);
    });

    test('writes exactly the frames next() answers, in order, asking next() at write time', async () => {
      const h = await started();
      const peer = await h.harness.connect();
      await h.harness.flush();
      const link = h.layer.links[0] as RecordingLink;
      link.offer(frame(1, 'a'), frame(2, 'b'));
      await h.harness.flush();
      expect(peer.received().map(decode)).toEqual(['a', 'b']);
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

    test("ends the peer when next() answers 'ended'", async () => {
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
