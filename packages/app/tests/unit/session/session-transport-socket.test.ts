import { describe, expect, test } from 'bun:test';
import type { CarrierSocketEvents } from '../../../src/session/session-transport.ts';
import { SessionTransport } from '../../../src/session/session-transport.ts';
import { decodeFrame, FRAME_KINDS, SESSION_PROTOCOL_ID } from '../../../src/session/wire/index.ts';
import {
  LEASE_ENDS,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  settle,
  testDevice,
  testSessionId,
} from '../../support/relay.ts';

/**
 * A page's stream socket over a REAL sealed session. The socket says it is open only once the daemon ACCEPTED the
 * stream, and it ends carrying the close code the daemon sent: a caller decides to reconnect on that code, so a
 * `1008` (a refusal) must not read as a drop.
 */

const device = await testDevice('fy_dev_socket');

async function streamDaemon() {
  const identity = await newDaemonIdentity();
  let daemon: ScriptedDaemon | undefined;
  let deliver: ((frame: Uint8Array) => Promise<void>) | undefined;
  let accept: (() => Promise<void>) | undefined;
  const dial = (events: CarrierSocketEvents) => {
    const scripted = new ScriptedDaemon(identity, testSessionId(1));
    daemon = scripted;
    deliver = async frame => events.onBinary(frame);
    queueMicrotask(() => void deliver?.(readyFrame(testSessionId(1))));
    let queue = Promise.resolve();
    let keyed = false;
    return {
      send(bytes: Uint8Array) {
        const copy = Uint8Array.from(bytes);
        queue = queue.then(async () => {
          const decoded = decodeFrame(copy);
          if (!decoded.ok) return;
          if (decoded.frame.kind === FRAME_KINDS.handshake && !keyed) {
            keyed = true;
            await deliver?.(await scripted.answer(copy));
            return;
          }
          if (decoded.frame.kind !== FRAME_KINDS.data) return;
          const record = (await scripted.receive(copy)) as Record<string, unknown>;
          if (record.t === 'stream') {
            accept = async () =>
              deliver?.(
                await scripted.record({
                  t: 'stream-opened',
                  protocol: SESSION_PROTOCOL_ID,
                  accessExpiresAt: LEASE_ENDS,
                }),
              );
          }
        });
      },
      sendText() {},
      close() {},
    };
  };
  return {
    identity,
    dial,
    accept: async () => {
      await settle();
      await accept?.();
      await settle();
    },
    close: async (code: number, reason: string) => {
      await deliver?.(
        await (daemon as ScriptedDaemon).record({ t: 'stream-close', protocol: SESSION_PROTOCOL_ID, code, reason }),
      );
      await settle();
    },
  };
}

describe('a stream socket over a sealed session', () => {
  test('it opens when the daemon accepts the stream, not when the carrier connects', async () => {
    const daemon = await streamDaemon();
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: daemon.identity.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    const seen: string[] = [];
    transport.socket('/v1/browsers/stream', {
      onOpen: () => seen.push('open'),
      onFrame: () => {},
      onClose: reason => seen.push(`close ${reason}`),
    });
    await settle();
    expect(seen).toEqual([]);
    await daemon.accept();
    expect(seen).toEqual(['open']);
  });

  test('it ends with the close code the daemon sent', async () => {
    const daemon = await streamDaemon();
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: daemon.identity.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    const closes: [string, number | undefined][] = [];
    transport.socket('/v1/browsers/stream', {
      onFrame: () => {},
      onClose: (reason, code) => closes.push([reason, code]),
    });
    await daemon.accept();
    await daemon.close(1008, 'invalid browser input');
    expect(closes).toEqual([['invalid browser input', 1008]]);
  });
});

describe('a stream the rendezvous refuses for its session ceiling', () => {
  /** A carrier that refuses the stream before a byte of the session is carried: the rendezvous's `4429`. */
  const refusing = (reason: string) => {
    const dials: number[] = [];
    const dial = (events: CarrierSocketEvents) => {
      dials.push(dials.length + 1);
      queueMicrotask(() => events.onClose(4429, reason));
      return { send() {}, sendText() {}, close() {} };
    };
    return { dial, dials };
  };

  /**
   * REAL FAILURE (reported, product untouched): `SessionTransport.socket` ends a refused stream with the error's
   * message only (`session-transport.ts`, the `ready()` rejection branch calls `end(message)`), so the close code the
   * session carried is dropped before the page's `onClose` sees it. `.failing` keeps it out of the guarantee check's
   * passing set; the session-level R567 test in `session-client.test.ts` proves the code survives up to that point.
   */
  test.failing('R567 (open) the stream socket hands the page the 4429 code with its reason, and does not dial again', async () => {
    const reason = 'this daemon is carrying as many sessions as it allows';
    const carrier = refusing(reason);
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: (await newDaemonIdentity()).daemonId,
      device: device.claim,
      dial: carrier.dial,
    });
    const closes: [string, number | undefined][] = [];
    transport.socket('/v1/browsers/stream', { onFrame: () => {}, onClose: (why, code) => closes.push([why, code]) });
    await settle();
    expect(closes).toHaveLength(1);
    expect(closes[0]?.[0]).toContain(reason);
    expect(closes[0]?.[1]).toBe(4429);
    expect(carrier.dials).toEqual([1]);
  });
});

describe('who owns a stream session', () => {
  /**
   * REAL FAILURE (reported): `SessionTransport.close()` ends only the request session; a stream session opened by
   * `socket()` / `events()` is never tracked by the transport, so a live socket presenting the device grant survives
   * it. (Connections' carrier router tracks every walked socket, but a stream on a plain direct dial has no owner.)
   */
  test.failing('R568 (open) closing the transport ends the stream sessions it opened, not only its request session', async () => {
    const daemon = await streamDaemon();
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: daemon.identity.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    const closes: string[] = [];
    transport.socket('/v1/browsers/stream', { onFrame: () => {}, onClose: reason => closes.push(reason) });
    await daemon.accept();
    expect(closes).toEqual([]);
    transport.close();
    await settle();
    expect(closes).toHaveLength(1);
  });
});
