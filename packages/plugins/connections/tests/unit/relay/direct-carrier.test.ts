import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CarrierKey, SessionLayer, SocketDownstream } from '@ferretry/kernel/contract';
import { DirectSession } from '../../../daemon/lib/relay/direct-carrier.ts';
import { directCarrierSocketRoute } from '../../../daemon/lib/runtime/mounts/direct-carrier.ts';
import { decodeFrame, encodeFrame, FRAME_KINDS, HEARTBEAT_REQUEST, sessionIdFromBytes } from '@ferretry/kernel/wire';
import { decodeControlMessage, encodeControlMessage, RELAY_LIMITS } from '../../../daemon/lib/relay/control.ts';
import { FakeSessions } from '../../support/sessions.ts';

function harness() {
  const layer = new FakeSessions();
  const sent: (string | Uint8Array)[] = [];
  const closes: { code: number; reason: string }[] = [];
  let released = 0;
  let nextId = 0;
  const proofs: (() => void)[] = [];
  const timers = new Set<() => void>();
  const deps = {
    identity: { daemonId: 'fy_daemon_' + 'a'.repeat(43) },
    clock: { now: () => 1_000 },
    scheduler: {
      after: (_ms: number, fn: () => void) => {
        timers.add(fn);
        return {
          cancel: () => {
            timers.delete(fn);
          },
        };
      },
    },
    randomBytes: (n: number) => new Uint8Array(n).fill(++nextId),
    sessions: () => layer,
    openSession: (
      s: SessionLayer,
      key: Parameters<typeof layer.open>[0],
      peer: Parameters<typeof layer.open>[1],
      proved: () => void,
    ) => {
      proofs.push(proved);
      return s.open(key, peer);
    },
  };
  const downstream: SocketDownstream = {
    send: bytes => {
      sent.push(bytes);
      return 0;
    },
    close: (code, reason) => {
      closes.push({ code, reason });
    },
    bufferedBytes: () => 0,
  };
  const make = () => new DirectSession(deps, 'direct' as CarrierKey, '198.51.100.2', downstream, () => released++);
  return { layer, sent, closes, proofs, timers, deps, downstream, make, released: () => released };
}
function call(daemonId: string, peer = '198.51.100.2', carrier = 'direct') {
  const request: ApiRequest = {
    method: 'GET',
    path: `/v1/rendezvous/${daemonId}/client`,
    query: new Map(),
    headers: new Map(),
    clientAddress: peer,
    arrival: { kind: 'carried', carrier: carrier as never },
    text: async () => '',
  };
  return { request, params: new Map([['daemonId', daemonId]]) };
}

describe('direct carrier', () => {
  test('R33 one socket mints one 16-byte session and announces ready with limits', async () => {
    const h = harness();
    const one = h.make(),
      two = h.make();
    await one.open();
    await two.open();
    expect(one.sessionId.bytes).toHaveLength(16);
    expect(two.sessionId.text).not.toBe(one.sessionId.text);
    const ready = decodeFrame(h.sent[0] as Uint8Array);
    expect(ready.ok).toBe(true);
    if (ready.ok)
      expect(decodeControlMessage(ready.frame.payload)).toEqual({
        t: 'ready',
        protocol: 'ferretry-relay/1',
        limits: RELAY_LIMITS,
      });
    expect(h.layer.links).toHaveLength(2);
    one.close();
    two.close();
  });
  test('R34 client control is refused with 4400 before it reaches the Kernel', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    s.fromClient(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: s.sessionId,
        sequence: 0,
        payload: encodeControlMessage({ t: 'probe' }),
      }),
    );
    expect(h.closes[0]?.code).toBe(4400);
    expect(h.layer.links[0]?.inbounds).toHaveLength(0);
  });
  test('R35 a Kernel session end uses its own close code and releases the socket', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    h.layer.links[0]!.offer({ code: 4441, reason: 'the access lease ended' });
    expect(h.closes).toEqual([{ code: 4441, reason: 'the access lease ended' }]);
    expect(h.released()).toBe(1);
  });
  test('R35 another daemon fingerprint gets 404 before any reservation', async () => {
    const h = harness(),
      r = directCarrierSocketRoute(h.deps);
    await expect(r.accept(call('other'))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(h.timers.size).toBe(0);
  });
  test('R625 direct loopback can only open a carried Kernel session', async () => {
    const h = harness(),
      r = directCarrierSocketRoute(h.deps);
    const attach = await r.accept(call(h.deps.identity.daemonId, '127.0.0.1'));
    const s = await attach(h.downstream);
    await s.open();
    expect(h.layer.carriers.map(String)).toEqual(['direct']);
    expect(h.layer.peers).toEqual([{ address: '127.0.0.1' }]);
    s.close();
  });
  test('R33 a frame naming a different session never reaches the Kernel', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    s.fromClient(
      encodeFrame({
        kind: FRAME_KINDS.handshake,
        sessionId: sessionIdFromBytes(new Uint8Array(16).fill(9))!,
        sequence: 0,
        payload: new Uint8Array([1]),
      }),
    );
    expect(h.closes[0]?.code).toBe(4400);
    expect(h.layer.links[0]?.inbounds).toHaveLength(0);
  });
  test('R87 heartbeat text is hop control and never a Kernel record', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    s.fromClient('fy-ping');
    s.fromClient('fy-pong');
    expect(h.sent.at(-1)).toBe('fy-pong');
    expect(h.layer.links[0]?.inbounds).toHaveLength(0);
    s.close();
  });
  test('R64 the direct ready publishes the limits so no endpoint guesses: 65536 bytes, 32 credit, 8 sessions, 30 s', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    const ready = decodeFrame(h.sent[0] as Uint8Array);
    if (!ready.ok) throw new Error(ready.reason);
    expect(decodeControlMessage(ready.frame.payload)).toMatchObject({
      t: 'ready',
      limits: { maxFrameBytes: 65_536, creditWindowFrames: 32, maxSessions: 8, heartbeatSeconds: 30 },
    });
    s.close();
  });
  test('R35 the Kernel final permit is pulled immediately before a socket write', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    const link = h.layer.links[0]!;
    const bytes = new Uint8Array([3, 4]);
    link.offer(undefined);
    expect(h.sent).toHaveLength(1);
    link.offer({ sequence: 1, bytes });
    expect(h.sent.at(-1)).toBe(bytes);
    s.close();
    link.offer({ sequence: 2, bytes });
    expect(h.sent).toHaveLength(2);
  });
  test('R33 a remote peer has at most two unproven reservations; verified proof releases the bound', async () => {
    const h = harness(),
      r = directCarrierSocketRoute(h.deps);
    const one = await r.accept(call(h.deps.identity.daemonId));
    await r.accept(call(h.deps.identity.daemonId));
    await expect(r.accept(call(h.deps.identity.daemonId))).rejects.toMatchObject({ status: 429 });
    const s = await one(h.downstream);
    await s.open();
    h.proofs[0]!();
    await expect(r.accept(call(h.deps.identity.daemonId))).resolves.toBeInstanceOf(Function);
    r.stop();
  });
  test('R33 an upgrade that never attaches returns its reservation at the deadline', async () => {
    const h = harness(),
      r = directCarrierSocketRoute(h.deps);
    await r.accept(call(h.deps.identity.daemonId));
    await r.accept(call(h.deps.identity.daemonId));
    for (const fn of [...h.timers]) fn();
    await expect(r.accept(call(h.deps.identity.daemonId))).resolves.toBeInstanceOf(Function);
    r.stop();
  });
  test('R33 a shutdown closes already-proved sessions and late upgrades', async () => {
    const h = harness(),
      r = directCarrierSocketRoute(h.deps);
    const attach = await r.accept(call(h.deps.identity.daemonId));
    const s = await attach(h.downstream);
    await s.open();
    h.proofs[0]!();
    r.stop();
    expect(h.layer.links[0]?.closedWith).toBeDefined();
  });
  test('G118 a session opens on the carrier its ARRIVAL names: a tunnel socket is a tunnel session, never a direct one', async () => {
    const h = harness(),
      r = directCarrierSocketRoute(h.deps);
    const viaTunnel = await (await r.accept(call(h.deps.identity.daemonId, '203.0.113.9', 'tunnel')))(h.downstream);
    await viaTunnel.open();
    const viaNetwork = await (await r.accept(call(h.deps.identity.daemonId, '198.51.100.9')))(h.downstream);
    await viaNetwork.open();
    expect(h.layer.carriers.map(String)).toEqual(['tunnel', 'direct']);
    viaTunnel.close();
    viaNetwork.close();
  });
  test('G118 only a tunnel session is logged: one open line and one close line with counts, no address or key', async () => {
    const h = harness();
    const lines: string[] = [];
    const ends: unknown[] = [];
    const deps = {
      ...h.deps,
      sessionLog: {
        opened: () => void lines.push('opened'),
        closed: (end: unknown) => {
          lines.push('closed');
          ends.push(end);
        },
      },
    };
    const r = directCarrierSocketRoute(deps);
    const viaNetwork = await (await r.accept(call(deps.identity.daemonId, '198.51.100.9')))(h.downstream);
    await viaNetwork.open();
    viaNetwork.close();
    expect(lines).toEqual([]);

    const viaTunnel = await (await r.accept(call(deps.identity.daemonId, '203.0.113.9', 'tunnel')))(h.downstream);
    await viaTunnel.open();
    viaTunnel.fromClient(HEARTBEAT_REQUEST);
    viaTunnel.close({ code: 1001, reason: 'a page left' });

    expect(lines).toEqual(['opened', 'closed']);
    expect(ends[0]).toMatchObject({ by: 'peer', code: 1001, reason: 'a page left', proved: false });
    expect((ends[0] as { bytesIn: number }).bytesIn).toBe(HEARTBEAT_REQUEST.length);
    expect((ends[0] as { bytesOut: number }).bytesOut).toBeGreaterThan(0);
    expect(JSON.stringify(ends[0])).not.toContain('203.0.113.9');
  });
});

describe('direct carrier: when a socket or a reason goes wrong', () => {
  test('a reason longer than a close frame may carry is cut on a character boundary', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    h.layer.links[0]!.offer({ code: 4441, reason: 'é'.repeat(100) });
    const reason = h.closes[0]?.reason ?? '';
    expect(new TextEncoder().encode(reason).byteLength).toBeLessThanOrEqual(123);
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toBe('é'.repeat(reason.length));
    expect(h.closes[0]?.code).toBe(4441);
  });

  test('a reason that fits is passed on as it is', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    h.layer.links[0]!.offer({ code: 4441, reason: 'short' });
    expect(h.closes).toEqual([{ code: 4441, reason: 'short' }]);
  });

  test('a socket that fails a write ends the session with the daemon-internal code, and releases it', async () => {
    const h = harness(),
      s = h.make();
    await s.open();
    h.downstream.send = () => {
      throw new Error('socket write failed');
    };
    h.layer.links[0]!.offer({ sequence: 1, bytes: new Uint8Array([1]) });
    expect(h.closes).toEqual([{ code: 4500, reason: 'the daemon could not carry this frame' }]);
    expect(h.released()).toBe(1);
  });
});
