/**
 * HOW A BROWSER REACHES A PUBLISHER IT IS NOT PAIRED WITH (B15): Connections' `MemberCarriers`
 * (`app/carriers/member-carriers.ts`), the addressing and transport half of a catalog member's join and member session.
 * A scripted socket and hand-fired timers: the walk order, the deadlines and the sealed session are the shell's and
 * Catalogs'; what is held here is that the PUBLISHER'S daemon id reaches the socket's address, the one rendezvous is the
 * one this build discovered, and a driven session keeps today's heartbeat and acceptance deadline.
 */
import { describe, expect, test } from 'bun:test';
import { RELAY_CLOSE_CODES, type RelayClientSession } from '@ferretry/app';
import { memberCarriers } from '../../../app/carriers/member-carriers.ts';
import {
  KEEPALIVE_DEADLINE_MS,
  KEEPALIVE_INTERVAL_MS,
  RELAY_SESSION_DEADLINE_MS,
} from '../../../app/carriers/carrier-socket.ts';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';

const PUBLISHER = `fy_daemon_${'p'.repeat(43)}`;

class Raw implements BrowserSocket {
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed ??= { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
  }
}

const hand = () => {
  const armed: { delay: number; run: () => void; ran: boolean }[] = [];
  return {
    after: (delay: number, run: () => void) => void armed.push({ delay, run, ran: false }),
    fire: (delay: number): void => {
      const entry = [...armed].reverse().find(item => item.delay === delay && !item.ran);
      if (entry === undefined) throw new Error(`no armed ${String(delay)} ms timer`);
      entry.ran = true;
      entry.run();
    },
  };
};

function build(hosted: string | null = 'https://relay.example') {
  const opened: { url: string; socket: Raw }[] = [];
  const timers = hand();
  const clock = { at: 0 };
  const carriers = memberCarriers({
    openSocket: url => {
      const socket = new Raw();
      opened.push({ url, socket });
      return socket;
    },
    after: timers.after,
    now: () => clock.at,
    hostedRelay: () => Promise.resolve(hosted ?? undefined),
  });
  return { carriers, opened, timers, clock };
}

/** The session as the carrier sees it: what it was fed, and how it was told the carrier ended. */
function fakeSession() {
  const log = { texts: [] as string[], binaries: [] as Uint8Array[], heartbeats: 0, ended: [] as [number, string][] };
  const session = {
    heartbeat: () => {
      log.heartbeats += 1;
    },
    receiveText: (text: string) => void log.texts.push(text),
    receiveBinary: async (bytes: Uint8Array) => void log.binaries.push(bytes),
    carrierClosed: (code: number, reason: string) => void log.ended.push([code, reason]),
  };
  return { session: session as unknown as RelayClientSession, log };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('B15 the member carriers address the publisher by its daemon id', () => {
  test("a direct address dials the publisher's own session route, with ITS daemon id", () => {
    const { carriers, opened } = build();
    carriers.dial('direct', 'https://box.example.test', PUBLISHER);
    expect(opened.map(item => item.url)).toEqual([`wss://box.example.test/v1/rendezvous/${PUBLISHER}/client`]);
  });

  test('a loopback publisher is dialled over plain ws, a rendezvous over its own address', () => {
    const { carriers, opened } = build();
    carriers.dial('direct', 'http://127.0.0.1:7777', PUBLISHER);
    carriers.dial('relay', 'https://relay.example', PUBLISHER);
    expect(opened.map(item => item.url)).toEqual([
      `ws://127.0.0.1:7777/v1/rendezvous/${PUBLISHER}/client`,
      `wss://relay.example/v1/rendezvous/${PUBLISHER}/client`,
    ]);
  });

  test('a fingerprint that is not a daemon id opens nothing: the dial throws, so the walk moves on', () => {
    const { carriers, opened } = build();
    expect(() => carriers.dial('direct', 'https://box.example.test', 'not-a-daemon')).toThrow();
    expect(opened).toEqual([]);
  });

  test('the rendezvous is the one this build discovered, or none', async () => {
    expect(await build('https://relay.example').carriers.rendezvous()).toBe('https://relay.example');
    expect(await build(null).carriers.rendezvous()).toBeUndefined();
  });
});

describe("B15 a driven member session keeps today's deadline and heartbeat", () => {
  test("frames reach the session, and a close ends it with the carrier's own code", async () => {
    const { carriers, opened } = build();
    const socket = carriers.dial('direct', 'https://box.example.test', PUBLISHER);
    const { session, log } = fakeSession();
    const settled = deferred<string>();
    const driven = carriers.drive({
      kind: 'direct',
      socket,
      session,
      settled: settled.promise,
      keepAlive: true,
      deadlineMs: 4_000,
    });
    const raw = opened[0]!.socket;
    raw.onopen?.();
    raw.onmessage?.({ data: 'hello' });
    raw.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    raw.onclose?.({ code: 4401, reason: 'refused' });
    expect(log.texts).toEqual(['hello']);
    expect(log.binaries).toHaveLength(1);
    expect(log.ended).toEqual([[4401, 'refused']]);
    settled.reject(new Error('over'));
    await expect(driven).rejects.toThrow('over');
  });

  test('a carrier that never lets the session settle in its deadline is closed as a transport failure', async () => {
    const { carriers, opened, timers } = build();
    const socket = carriers.dial('relay', 'https://relay.example', PUBLISHER);
    const { session, log } = fakeSession();
    const settled = deferred<string>();
    void carriers.drive({
      kind: 'relay',
      socket,
      session,
      settled: settled.promise,
      keepAlive: true,
      deadlineMs: RELAY_SESSION_DEADLINE_MS,
    });
    timers.fire(RELAY_SESSION_DEADLINE_MS);
    expect(log.ended[0]?.[0]).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    expect(opened[0]!.socket.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
  });

  test('a session that settles in time keeps its socket, and is pinged on the keepalive interval', async () => {
    const { carriers, opened, timers } = build();
    const socket = carriers.dial('direct', 'https://box.example.test', PUBLISHER);
    const { session, log } = fakeSession();
    const settled = deferred<string>();
    const driven = carriers.drive({
      kind: 'direct',
      socket,
      session,
      settled: settled.promise,
      keepAlive: true,
      deadlineMs: 4_000,
    });
    const raw = opened[0]!.socket;
    raw.onopen?.();
    settled.resolve('ready');
    await driven;
    timers.fire(4_000); // the acceptance deadline was cancelled: it closes nothing
    expect(raw.closed).toBeNull();
    timers.fire(KEEPALIVE_INTERVAL_MS);
    expect(log.heartbeats).toBe(1);
  });

  test('a ping nobody answers ends the session as a heartbeat timeout; any inbound frame is life', async () => {
    const { carriers, opened, timers } = build();
    const socket = carriers.dial('direct', 'https://box.example.test', PUBLISHER);
    const { session, log } = fakeSession();
    const settled = deferred<string>();
    const driven = carriers.drive({
      kind: 'direct',
      socket,
      session,
      settled: settled.promise,
      keepAlive: true,
      deadlineMs: 4_000,
    });
    const raw = opened[0]!.socket;
    raw.onopen?.();
    settled.resolve('ready');
    await driven;
    timers.fire(KEEPALIVE_INTERVAL_MS);
    raw.onmessage?.({ data: 'fy-pong' }); // answered: the deadline is disarmed
    timers.fire(KEEPALIVE_DEADLINE_MS);
    expect(log.ended).toEqual([]);
    timers.fire(KEEPALIVE_INTERVAL_MS);
    timers.fire(KEEPALIVE_DEADLINE_MS); // not answered
    expect(log.ended[0]?.[0]).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
    expect(raw.closed?.code).toBe(RELAY_CLOSE_CODES.heartbeatTimeout);
  });

  test('a join (no keepalive) is never pinged', async () => {
    const { carriers, opened, timers } = build();
    const socket = carriers.dial('direct', 'https://box.example.test', PUBLISHER);
    const { session, log } = fakeSession();
    const settled = deferred<string>();
    const driven = carriers.drive({
      kind: 'direct',
      socket,
      session,
      settled: settled.promise,
      keepAlive: false,
      deadlineMs: 4_000,
    });
    opened[0]!.socket.onopen?.();
    settled.resolve('joined');
    expect(await driven).toBe('joined');
    expect(() => timers.fire(KEEPALIVE_INTERVAL_MS)).toThrow();
    expect(log.heartbeats).toBe(0);
  });
});

describe('B15 Connections contributes the member carriers to the shell', () => {
  test('its app half provides `member` beside `carriers` and `pairing`, so the shell offers a member transport', async () => {
    const half = (await import('../../../app/index.ts')).default;
    expect(typeof half.shell.member).toBe('function');
    expect(typeof half.shell.carriers).toBe('function');
    expect(typeof half.shell.pairing).toBe('function');
  });
});
