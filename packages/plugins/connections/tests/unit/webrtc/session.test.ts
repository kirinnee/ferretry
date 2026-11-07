import { expect, it } from 'bun:test';
import type {
  CarrierKey,
  CarrierPeer,
  SealedFrame,
  SessionEnd,
  SessionLayer,
  SocketDownstream,
} from '@ferretry/kernel/contract';
import { encodeFrame, FRAME_KINDS } from '../../../worker/src/lib/index.ts';
import { sealedWebRtcSessions } from '../../../daemon/lib/webrtc/session.ts';

function harness() {
  const queue: (SealedFrame | SessionEnd)[] = [];
  const sent: (string | Uint8Array)[] = [];
  const received: Uint8Array[] = [];
  const arrivals: { key: CarrierKey; peer?: CarrierPeer }[] = [];
  const timers: (() => void)[] = [];
  const ends: { code: number; reason: string }[] = [];
  let buffer = 0,
    pulls = 0,
    released = 0,
    closed = 0;
  let ready = () => {};
  let permit = true;
  const layer: SessionLayer = {
    open: (key, peer) => {
      arrivals.push({ key, peer });
      return {
        inbound: bytes => received.push(bytes),
        closed: () => {
          closed++;
        },
        outbound: {
          next: () => {
            pulls++;
            return permit ? queue.shift() : { code: 4403, reason: 'what it was about to send changed before it left' };
          },
          onReady: fn => {
            ready = fn;
            return () => {
              ready = () => {};
            };
          },
        },
      };
    },
    connection: () => {
      throw new Error('the fixture carries no connection');
    },
    signer: undefined as never,
  };
  const downstream: SocketDownstream = {
    send: frame => {
      sent.push(frame);
      return typeof frame === 'string' ? frame.length : frame.length;
    },
    close: (code, reason) => ends.push({ code, reason }),
    bufferedBytes: () => buffer,
  };
  const session = sealedWebRtcSessions(
    layer,
    {
      after: (_delay, fn) => {
        timers.push(fn);
        return {
          cancel: () => {
            const index = timers.indexOf(fn);
            if (index >= 0) timers.splice(index, 1);
          },
        };
      },
    },
    length => new Uint8Array(length).fill(7),
  )({ kind: 'carried', carrier: 'webrtc', address: 'webrtc-peer:minted-by-daemon' }, downstream, () => {
    released++;
  })!;
  return {
    session,
    queue,
    /** What crossed the channel after the carrier's own `ready`. */
    get sent() {
      return sent.slice(1);
    },
    all: sent,
    received,
    arrivals,
    ends,
    timers,
    ready: () => ready(),
    buffer: (value: number) => {
      buffer = value;
    },
    deny: () => {
      permit = false;
    },
    pulls: () => pulls,
    released: () => released,
    closed: () => closed,
  };
}
it('R682 WebRTC hands sealed bytes to the kernel session and derives no authority from DTLS', async () => {
  const h = harness();
  await h.session.open();
  const bytes = encodeFrame({
    kind: FRAME_KINDS.handshake,
    sessionId: h.session.sessionId,
    sequence: 0,
    payload: Uint8Array.of(10, 20, 30),
  });
  h.session.fromClient(bytes);
  expect(h.arrivals).toEqual([{ key: 'webrtc' as CarrierKey, peer: { address: 'webrtc-peer:minted-by-daemon' } }]);
  expect(h.received).toEqual([bytes]);
});
it('R683 every channel on a peer uses the server-minted peer identity', async () => {
  const h = harness();
  expect(h.arrivals[0]?.peer?.address).toBe('webrtc-peer:minted-by-daemon');
  h.session.close();
  expect(h.closed()).toBe(1);
  expect(h.released()).toBe(1);
});
it('I75 a permit revoked while a frame waits behind channel backpressure prevents its write', async () => {
  const h = harness();
  h.buffer(100_000);
  h.queue.push({ sequence: 1, bytes: Uint8Array.of(9) });
  await h.session.open();
  expect(h.pulls()).toBe(0);
  expect(h.sent).toEqual([]);
  h.deny();
  h.buffer(0);
  h.timers.shift()!();
  expect(h.sent).toEqual([]);
  expect(h.ends[0]?.code).toBe(4403);
  expect(h.closed()).toBe(1);
});
it('R680 the channel reports the kernel end code and rejects unexpected text', async () => {
  const h = harness();
  await h.session.open();
  h.session.fromClient('unexpected-control');
  expect(h.ends[0]?.code).toBe(4400);
  expect(h.closed()).toBe(1);
});
it('R669 each outbound frame is pulled synchronously immediately before its channel write', async () => {
  const h = harness();
  await h.session.open();
  const bytes = Uint8Array.of(1, 2, 3);
  h.queue.push({ sequence: 1, bytes });
  h.ready();
  expect(h.sent).toEqual([bytes]);
  h.session.close();
  h.queue.push({ sequence: 2, bytes });
  h.ready();
  expect(h.sent).toEqual([bytes]);
});
it('R692 a refused kernel device proof becomes the same closed 4403 on WebRTC', async () => {
  const h = harness();
  await h.session.open();
  h.queue.push({ code: 4403, reason: 'credential refused' });
  h.ready();
  expect(h.ends).toEqual([{ code: 4403, reason: 'credential refused' }]);
  expect(h.released()).toBe(1);
});
