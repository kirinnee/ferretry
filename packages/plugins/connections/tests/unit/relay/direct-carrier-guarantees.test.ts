/**
 * The direct carrier's admission and heartbeat rows (relay-protocol §4 and §8), asserted on the code the Connections
 * plugin owns: the direct socket route (`runtime/mounts/direct-carrier.ts`), the direct session, and the relay link's
 * heartbeat. Every title starts with its row id so the guarantee check finds it in this suite.
 */
import { describe, expect, test } from 'bun:test';
import type { ApiRequest, Arrival, CarrierKey, SessionLayer, SocketDownstream } from '@ferretry/kernel/contract';
import { HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE, SESSION_CLOSE_CODES } from '@ferretry/kernel/wire';
import { FakeSessions } from '../../support/sessions.ts';
import {
  DIRECT_UPGRADE_WINDOW_MS,
  DIRECT_UPGRADES_PER_PEER,
  DirectSession,
  EVICTED_REASON,
  MAX_DIRECT_SESSIONS,
  MAX_DIRECT_UNPROVEN_PER_PEER,
  MAX_DIRECT_UNPROVEN_SESSIONS,
} from '../../../daemon/lib/relay/direct-carrier.ts';
import { RELAY_KEEPALIVE_MS } from '../../../daemon/lib/relay/carrier.ts';
import { RELAY_LIMITS } from '../../../daemon/lib/relay/control.ts';
import { RelayLink } from '../../../daemon/lib/relay/link.ts';
import { directCarrierSocketRoute } from '../../../daemon/lib/runtime/mounts/direct-carrier.ts';

const DAEMON_ID = 'fy_daemon_' + 'a'.repeat(43);

interface Closed {
  code: number;
  reason: string;
}

/** One browser socket on the direct route. */
class Socket {
  readonly sent: (string | Uint8Array)[] = [];
  closed: Closed | undefined;
  readonly downstream: SocketDownstream = {
    send: bytes => {
      this.sent.push(bytes);
      return 0;
    },
    close: (code, reason) => {
      this.closed ??= { code, reason };
    },
    bufferedBytes: () => 0,
  };
}

function harness() {
  const layer = new FakeSessions();
  let now = 1_000;
  let nextId = 0;
  let opened = 0;
  const proofs: (() => void)[] = [];
  const timers: { ms: number; fn: () => void; live: boolean }[] = [];
  const deps = {
    identity: { daemonId: DAEMON_ID },
    clock: { now: () => now },
    scheduler: {
      after: (ms: number, fn: () => void) => {
        const timer = { ms, fn, live: true };
        timers.push(timer);
        return {
          cancel: () => {
            timer.live = false;
          },
        };
      },
    },
    randomBytes: (length: number) => new Uint8Array(length).fill(++nextId % 250),
    sessions: (): SessionLayer => layer,
    // The Kernel's key agreement and signature happen when a session is OPENED: count how often that is reached.
    openSession: (
      sessions: SessionLayer,
      key: Parameters<FakeSessions['open']>[0],
      peer: Parameters<FakeSessions['open']>[1],
      proved: () => void,
    ) => {
      opened += 1;
      proofs.push(proved);
      return sessions.open(key, peer);
    },
  };
  const route = directCarrierSocketRoute(deps);
  const call = (peer: string, arrival: Arrival = { kind: 'carried', carrier: 'direct' as CarrierKey }) => {
    const request: ApiRequest = {
      method: 'GET',
      path: `/v1/rendezvous/${DAEMON_ID}/client`,
      query: new Map(),
      headers: new Map(),
      clientAddress: peer,
      arrival,
      text: async () => '',
    };
    return { request, params: new Map([['daemonId', DAEMON_ID]]) } as never;
  };
  /** Admission only: the upgrade is accepted but no socket has attached yet. */
  const admit = (peer: string, arrival?: Arrival) => route.accept(call(peer, arrival));
  /** A whole socket: admitted, attached and opened. */
  const arrive = async (peer: string, arrival?: Arrival) => {
    const attach = await admit(peer, arrival);
    const socket = new Socket();
    const handler = await attach(socket.downstream);
    await handler.open();
    return { socket, handler, proof: () => proofs[proofs.length - 1]!() };
  };
  return {
    layer,
    route,
    admit,
    arrive,
    proofs,
    timers,
    opened: () => opened,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('direct carrier admission', () => {
  test('R36 an upgrade is admitted before any public-key work is done for it', async () => {
    const h = harness();
    // Admitted: the route answers the upgrade, and the Kernel session (its key agreement and signature) is not opened.
    const attach = await h.admit('198.51.100.1');
    expect(h.opened()).toBe(0);
    expect(h.layer.links).toHaveLength(0);

    // Refused: three bounds run first, and a refused upgrade never reaches the Kernel either.
    await h.admit('198.51.100.1');
    await expect(h.admit('198.51.100.1')).rejects.toMatchObject({ status: 429 });
    expect(h.opened()).toBe(0);

    // The expensive step starts only when the admitted socket opens.
    const handler = await attach(new Socket().downstream);
    await handler.open();
    expect(h.opened()).toBe(1);
    h.route.stop();
  });

  test('R37 at most 30 admitted upgrades a minute per address; a refused one does not count', async () => {
    const h = harness();
    // Two unproven sockets from one address are the cap; a third is 429 and that refusal costs the address nothing.
    const first = await h.arrive('198.51.100.7');
    const second = await h.arrive('198.51.100.7');
    for (let index = 0; index < 5; index += 1)
      await expect(h.admit('198.51.100.7')).rejects.toMatchObject({ status: 429 });
    first.handler.close();
    second.handler.close();

    // 2 admitted so far: 28 more fit in the minute, because the five refusals above were never spent.
    for (let index = 0; index < DIRECT_UPGRADES_PER_PEER - 2; index += 1)
      (await h.arrive('198.51.100.7')).handler.close();
    await expect(h.admit('198.51.100.7')).rejects.toMatchObject({ status: 429 });
    // Another address is its own count, and the window ending gives the address its budget back.
    await expect(h.admit('198.51.100.8')).resolves.toBeInstanceOf(Function);
    h.advance(DIRECT_UPGRADE_WINDOW_MS);
    await expect(h.admit('198.51.100.7')).resolves.toBeInstanceOf(Function);
    h.route.stop();
  });

  test('R37 at most 2 unproven sockets per remote address, else 429; host loopback is exempt from that cap', async () => {
    const h = harness();
    expect(MAX_DIRECT_UNPROVEN_PER_PEER).toBe(2);
    await h.admit('198.51.100.20');
    await h.admit('198.51.100.20');
    await expect(h.admit('198.51.100.20')).rejects.toMatchObject({ status: 429 });

    // The host's own tabs share one loopback address: proven by the carrier, not by the address.
    const host: Arrival = { kind: 'local', privileged: true } as Arrival;
    for (let index = 0; index < MAX_DIRECT_UNPROVEN_PER_PEER + 3; index += 1)
      await expect(h.admit('127.0.0.1', host)).resolves.toBeInstanceOf(Function);
    h.route.stop();
  });

  test('R38 at most 16 unproven sockets: the oldest unproven one is closed 4429, the newcomer is not refused', async () => {
    const h = harness();
    const sockets = [];
    for (let index = 1; index <= MAX_DIRECT_UNPROVEN_SESSIONS; index += 1)
      sockets.push(await h.arrive(`198.51.100.${index}`));
    expect(sockets.every(entry => entry.socket.closed === undefined)).toBe(true);

    const newcomer = await h.arrive('198.51.100.100');
    expect(sockets[0]!.socket.closed).toEqual({ code: SESSION_CLOSE_CODES.rendezvousBusy, reason: EVICTED_REASON });
    expect(sockets[0]!.socket.closed?.code).toBe(4429);
    expect(sockets.slice(1).every(entry => entry.socket.closed === undefined)).toBe(true);
    expect(newcomer.socket.closed).toBeUndefined();
    h.route.stop();
  });

  test('R38 at most 64 open sockets: with all 64 proven the next upgrade is 429', async () => {
    const h = harness();
    for (let index = 1; index <= MAX_DIRECT_SESSIONS; index += 1) {
      const entry = await h.arrive(`198.51.${Math.floor(index / 200)}.${index % 200}`);
      entry.proof();
    }
    await expect(h.admit('203.0.113.1')).rejects.toMatchObject({ status: 429 });
    h.route.stop();
  });

  test('R39 the slot is reserved at admission, not attach: concurrent upgrades cannot all pass', async () => {
    const h = harness();
    // No socket attaches while every upgrade is admitted: the reservation alone must hold the count.
    const attaches = await Promise.all(
      Array.from({ length: MAX_DIRECT_UNPROVEN_SESSIONS + 1 }, (_, index) => h.admit(`198.51.100.${index + 1}`)),
    );
    const sockets = attaches.map(() => new Socket());
    for (const [index, attach] of attaches.entries()) await (await attach(sockets[index]!.downstream)).open();
    const evicted = sockets.filter(socket => socket.closed !== undefined);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.closed).toEqual({ code: 4429, reason: EVICTED_REASON });

    // The same holds per address: two admitted-but-unattached upgrades fill that address, the third is refused.
    await h.admit('203.0.113.1');
    await h.admit('203.0.113.1');
    await expect(h.admit('203.0.113.1')).rejects.toMatchObject({ status: 429 });
    h.route.stop();
  });

  test('R39 an unattached reservation is released after 10 s', async () => {
    const h = harness();
    await h.admit('198.51.100.30');
    await h.admit('198.51.100.30');
    await expect(h.admit('198.51.100.30')).rejects.toMatchObject({ status: 429 });

    const deadlines = h.timers.filter(timer => timer.live);
    expect(deadlines).toHaveLength(2);
    expect(deadlines.every(timer => timer.ms === 10_000)).toBe(true);
    for (const timer of deadlines) timer.fn();
    await expect(h.admit('198.51.100.30')).resolves.toBeInstanceOf(Function);
    h.route.stop();
  });
});

describe('direct carrier heartbeat', () => {
  test('R86 a direct socket answers text fy-ping with fy-pong; any other text is a protocol error', async () => {
    const h = harness();
    const { socket, handler } = await h.arrive('198.51.100.40');
    const texts = (): string[] => socket.sent.filter((entry): entry is string => typeof entry === 'string');

    handler.fromClient(HEARTBEAT_REQUEST);
    expect(texts()).toEqual([HEARTBEAT_RESPONSE]);
    handler.fromClient(HEARTBEAT_RESPONSE);
    expect(socket.closed).toBeUndefined();
    expect(texts()).toEqual([HEARTBEAT_RESPONSE]);

    handler.fromClient('hello');
    expect(socket.closed?.code).toBe(SESSION_CLOSE_CODES.protocolError);
    expect(socket.closed?.code).toBe(4400);
    h.route.stop();
  });

  test('R86 the relay link answers fy-ping, sends its own, and refuses any other text', () => {
    const sentText: string[] = [];
    const closes: number[] = [];
    const link = new RelayLink({
      layer: new FakeSessions(),
      relayHost: 'relay.example',
      identity: {
        daemonId: DAEMON_ID,
        sign: async () => ({ daemonId: DAEMON_ID, publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) }),
      },
      socket: {
        send: () => undefined,
        sendText: text => void sentText.push(text),
        close: code => void closes.push(code),
      },
      scheduler: { after: () => ({ cancel: () => undefined }) },
    });

    link.heartbeat();
    expect(sentText).toEqual([HEARTBEAT_REQUEST]);
    link.receiveText(HEARTBEAT_REQUEST);
    expect(sentText).toEqual([HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE]);
    link.receiveText(HEARTBEAT_RESPONSE);
    expect(closes).toEqual([]);

    link.receiveText('not a heartbeat');
    expect(closes).toEqual([SESSION_CLOSE_CODES.protocolError]);
  });

  test('R86 this side pings inside the heartbeatSeconds it publishes', () => {
    expect(RELAY_LIMITS.heartbeatSeconds).toBe(30);
    expect(RELAY_KEEPALIVE_MS).toBeLessThanOrEqual(RELAY_LIMITS.heartbeatSeconds * 1_000);
    expect(HEARTBEAT_REQUEST).toBe('fy-ping');
    expect(HEARTBEAT_RESPONSE).toBe('fy-pong');
    // A DirectSession is the daemon's end of a direct socket: the browser pings it, it answers.
    expect(DirectSession.prototype.fromClient).toBeInstanceOf(Function);
  });
});
