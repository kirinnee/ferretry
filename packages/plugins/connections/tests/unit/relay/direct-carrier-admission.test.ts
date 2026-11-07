/**
 * The direct carrier's admission against the REAL Kernel session layer (no FakeSessions): each direct socket is its
 * own connection, so the layer's six-per-connection pre-credential bound never caps separate sockets, and the
 * direct mount's 16-unproven / evict-oldest rule (today's `runtime/mounts/direct-carrier.ts`) is what governs.
 */
import { describe, expect, test } from 'bun:test';
import type {
  ApiRequest,
  CarrierLink,
  SealedFrame,
  SessionEnd,
  SocketDownstream,
  SocketHandler,
} from '@ferretry/kernel/contract';
import { decodeFrame, FRAME_KINDS } from '@ferretry/kernel/wire';
import { type RealSessionLayer, realSessionLayer, settle } from '../../support/kernel-layer.ts';
import { openKernelSession } from '../../../daemon/index.ts';
import {
  type DirectSession,
  EVICTED_REASON,
  MAX_DIRECT_UNPROVEN_SESSIONS,
} from '../../../daemon/lib/relay/direct-carrier.ts';
import { directCarrierSocketRoute } from '../../../daemon/lib/runtime/mounts/direct-carrier.ts';

/** One browser socket on the direct route: what the daemon wrote to it, and how it closed. */
class Socket {
  readonly frames: Uint8Array[] = [];
  closed: { code: number; reason: string } | undefined;
  handler: SocketHandler | undefined;
  readonly downstream: SocketDownstream = {
    send: bytes => {
      if (typeof bytes !== 'string') this.frames.push(bytes);
      return 0;
    },
    close: (code, reason) => {
      this.closed ??= { code, reason };
    },
    bufferedBytes: () => 0,
  };
  /** The browser's view of this socket as a session link, so the Kernel's own test client can speak over it. */
  link(): CarrierLink {
    return {
      inbound: bytes => this.handler?.fromClient(bytes),
      closed: () => undefined,
      outbound: {
        next: (): SealedFrame | SessionEnd | undefined => {
          for (;;) {
            const bytes = this.frames.shift();
            if (bytes === undefined) return this.closed;
            const decoded = decodeFrame(bytes);
            // The carrier's own `ready`/`closed` control frames are not session records.
            if (decoded.ok && decoded.frame.kind === FRAME_KINDS.control) continue;
            return { sequence: decoded.ok ? decoded.frame.sequence : 0, bytes };
          }
        },
        onReady: () => () => undefined,
      },
    };
  }
}

function direct(fx: RealSessionLayer) {
  let timers = 0;
  const route = directCarrierSocketRoute({
    identity: { daemonId: fx.daemonId },
    clock: { now: () => Date.parse('2026-11-07T09:00:00.000Z') },
    scheduler: { after: () => ({ cancel: () => void timers++ }) },
    randomBytes: length => crypto.getRandomValues(new Uint8Array(length)),
    sessions: () => fx.layer,
    openSession: openKernelSession,
  });
  const arrive = async (peer: string): Promise<Socket> => {
    const request: ApiRequest = {
      method: 'GET',
      path: `/v1/rendezvous/${fx.daemonId}/client`,
      query: new Map(),
      headers: new Map(),
      clientAddress: peer,
      arrival: { kind: 'carried', carrier: 'direct' as never },
      text: async () => '',
    };
    const attach = await route.accept({ request, params: new Map([['daemonId', fx.daemonId]]) } as never);
    const socket = new Socket();
    socket.handler = await attach(socket.downstream);
    await socket.handler.open();
    return socket;
  };
  return { route, arrive };
}

describe('direct admission over the real session layer', () => {
  test('R33 the 17th unproven direct arrival evicts the oldest, and a verified proof releases a slot', async () => {
    const fx = await realSessionLayer();
    const { route, arrive } = direct(fx);
    const sockets: Socket[] = [];
    for (let index = 1; index <= MAX_DIRECT_UNPROVEN_SESSIONS + 1; index += 1)
      sockets.push(await arrive(`198.51.100.${index}`));
    await settle();

    // Eight, sixteen: no layer-wide six. Only the oldest squatter goes, as BUSY with today's reason.
    expect(sockets[0]!.closed).toEqual({ code: 4429, reason: EVICTED_REASON });
    expect(sockets.slice(1).every(socket => socket.closed === undefined)).toBe(true);
    expect(fx.layer.report().preCredential).toBe(MAX_DIRECT_UNPROVEN_SESSIONS);

    // The second socket proves a paired device through the Kernel: the proof, not a fake callback, frees its slot.
    await fx.proveDevice(sockets[1]!.link(), (sockets[1]!.handler as DirectSession).sessionId);
    expect(sockets[1]!.closed).toBeUndefined();
    expect(fx.layer.report().preCredential).toBe(MAX_DIRECT_UNPROVEN_SESSIONS - 1);

    // So the next arrival takes the freed slot and evicts nobody.
    const eighteenth = await arrive('198.51.100.200');
    await settle();
    expect(eighteenth.closed).toBeUndefined();
    expect(sockets[2]!.closed).toBeUndefined();
    expect(sockets[1]!.closed).toBeUndefined();

    // And with the unproven set full again, the next arrival evicts the oldest UNPROVEN socket, never the proved one.
    const nineteenth = await arrive('198.51.100.201');
    await settle();
    expect(nineteenth.closed).toBeUndefined();
    expect(sockets[1]!.closed).toBeUndefined();
    expect(sockets[2]!.closed).toEqual({ code: 4429, reason: EVICTED_REASON });
    route.stop();
  });
});
