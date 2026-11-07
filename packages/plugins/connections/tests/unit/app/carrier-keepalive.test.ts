/**
 * The browser's keepalive on a live carrier session (`app/carriers/carrier-socket.ts`): ported from today's
 * `relay-carrier-drops.test.ts` and `relay-carrier-reconnect.test.ts`. A scripted socket, a hand-moved clock and
 * hand-fired timers: "the timer fired a minute late" is a number this suite sets, never a wait.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { RELAY_CLOSE_CODES } from '@ferretry/app';
import type { CarrierSocketEvents } from '@ferretry/app';
import type { RelayCarrierSocket } from '../../../app/adapters/browser-relay-dial.ts';
import {
  HEARTBEAT_LATE_TOLERANCE_MS,
  KEEPALIVE_DEADLINE_MS,
  KEEPALIVE_INTERVAL_MS,
  LIVENESS_CHECK_DEADLINE_MS,
  walkingDial,
  type WalkObserver,
} from '../../../app/carriers/carrier-socket.ts';
import type { CarrierSessionEnd } from '../../../app/lib/carrier-drops.ts';

class Socket implements RelayCarrierSocket {
  onOpen: (() => void) | null = null;
  onText: ((text: string) => void) | null = null;
  onBinary: ((bytes: Uint8Array) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  readonly texts: string[] = [];
  closed: { code: number; reason: string } | null = null;
  send(): void {}
  sendText(text: string): void {
    this.texts.push(text);
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
}

/** Timers fired by hand, by delay; cancelled ones are never run (the socket cancels through its own flags). */
const timers = () => {
  const armed: { delay: number; run: () => void; ran: boolean }[] = [];
  return {
    after: (delay: number, run: () => void) => void armed.push({ delay, run, ran: false }),
    /** Fires the NEWEST armed, not-yet-fired timer with this delay. */
    fire: (delay: number): void => {
      const entry = [...armed].reverse().find(item => item.delay === delay && !item.ran);
      if (entry === undefined) throw new Error(`no armed ${String(delay)} ms timer`);
      entry.ran = true;
      entry.run();
    },
    pending: (delay: number): boolean => armed.some(item => item.delay === delay && !item.ran),
  };
};

async function openSession() {
  const clock = { at: 0 };
  const hand = timers();
  const socket = new Socket();
  const drops: CarrierSessionEnd[] = [];
  const closes: { code: number; reason: string }[] = [];
  const observer: WalkObserver = {
    untried: () => undefined,
    failed: () => undefined,
    committed: () => undefined,
    exhausted: () => ({ code: 4400, reason: 'exhausted' }),
    dropped: (_method, end) => void drops.push(end),
  };
  const events: CarrierSocketEvents = {
    onText: () => undefined,
    onBinary: () => undefined,
    onClose: (code, reason) => void closes.push({ code, reason }),
  };
  const dial = walkingDial(
    { after: hand.after, now: () => clock.at },
    async function* () {
      yield {
        kind: 'leg' as const,
        leg: { method: { kind: 'webrtc' as const }, open: () => socket, deadlineMs: 30_000 },
      };
    },
    observer,
  );
  dial(events);
  // The carrier's first frame binds this leg to the session and starts the keepalive.
  await new Promise(resolve => setTimeout(resolve, 0));
  socket.onText?.('fy-pong');
  return { socket, hand, clock, drops, closes };
}

describe('the browser keepalive', () => {
  test('R88 this side pings every 20 s and closes 4408 when nothing arrives within 10 s', async () => {
    const { socket, hand, closes } = await openSession();
    expect(KEEPALIVE_INTERVAL_MS).toBe(20_000);
    expect(KEEPALIVE_DEADLINE_MS).toBe(10_000);
    expect(hand.pending(KEEPALIVE_INTERVAL_MS)).toBe(true);

    hand.fire(KEEPALIVE_INTERVAL_MS);
    expect(socket.texts).toEqual(['fy-ping']);
    expect(hand.pending(KEEPALIVE_DEADLINE_MS)).toBe(true);
    // Nothing arrives; the deadline runs on time.
    hand.fire(KEEPALIVE_DEADLINE_MS);
    expect(socket.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    expect(socket.closed?.code).toBe(4408);
    expect(closes.map(end => end.code)).toEqual([4408]);
  });

  test('R88 any inbound message is a sign of life and disarms the deadline', async () => {
    const { socket, hand, closes } = await openSession();
    hand.fire(KEEPALIVE_INTERVAL_MS);
    socket.onText?.('fy-pong');
    hand.fire(KEEPALIVE_DEADLINE_MS);
    expect(socket.closed).toBeNull();
    expect(closes).toEqual([]);
  });

  /**
   * REAL FAILURE (reported, product untouched): `watchConnectionSignals` and `browserConnectionSignals` exist and are
   * unit-tested, but nothing in the shipped app half calls them and `WalkingSocket` has no liveness-check entry, so the
   * browser never runs the 4 s check on foreground, online or network change. `.failing` keeps this out of the guarantee
   * check's passing set until the wiring lands; when it does, this starts passing and bun will say to drop `.failing`.
   */
  test.failing('R88 (open) the shipped app half wires the foreground, online and network-change signals to a 4 s liveness check', () => {
    const sources = ['app/index.ts', 'app/carriers/router.ts', 'app/carriers/carrier-socket.ts'].map(file =>
      readFileSync(join(import.meta.dir, '../../..', file), 'utf8'),
    );
    expect(sources.some(source => source.includes('watchConnectionSignals'))).toBe(true);
  });

  test('R89 a deadline that fires more than 2 s late is forgiven once with a 4 s re-ping', async () => {
    const { socket, hand, clock, closes } = await openSession();
    hand.fire(KEEPALIVE_INTERVAL_MS);
    // The page was frozen: the 10 s deadline runs a minute after its time.
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    hand.fire(KEEPALIVE_DEADLINE_MS);

    expect(socket.closed).toBeNull();
    expect(closes).toEqual([]);
    expect(socket.texts).toEqual(['fy-ping', 'fy-ping']);
    expect(hand.pending(LIVENESS_CHECK_DEADLINE_MS)).toBe(true);
    expect(LIVENESS_CHECK_DEADLINE_MS).toBe(4_000);
    expect(HEARTBEAT_LATE_TOLERANCE_MS).toBe(2_000);
  });

  test('R89 if the carrier is silent again it closes 4408, however late that deadline fires', async () => {
    const { socket, hand, clock, closes } = await openSession();
    hand.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    hand.fire(KEEPALIVE_DEADLINE_MS);
    clock.at += LIVENESS_CHECK_DEADLINE_MS + 60_000;
    hand.fire(LIVENESS_CHECK_DEADLINE_MS);

    expect(socket.closed?.code).toBe(4408);
    expect(closes.map(end => end.code)).toEqual([4408]);
  });

  test('R89 a deadline within the 2 s tolerance is not forgiven', async () => {
    const { socket, hand, clock } = await openSession();
    hand.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + HEARTBEAT_LATE_TOLERANCE_MS;
    hand.fire(KEEPALIVE_DEADLINE_MS);
    expect(socket.closed?.code).toBe(4408);
  });

  test('R89 any sign of life re-arms the forgiveness', async () => {
    const { socket, hand, clock, closes } = await openSession();
    hand.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    hand.fire(KEEPALIVE_DEADLINE_MS);
    socket.onText?.('fy-pong');

    // The next ping's deadline is late as well: forgiven again, not closed.
    hand.fire(KEEPALIVE_INTERVAL_MS);
    clock.at += KEEPALIVE_DEADLINE_MS + 60_000;
    hand.fire(KEEPALIVE_DEADLINE_MS);
    expect(socket.closed).toBeNull();
    expect(closes).toEqual([]);
    expect(hand.pending(LIVENESS_CHECK_DEADLINE_MS)).toBe(true);
  });
});
