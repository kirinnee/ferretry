import { describe, expect, test } from 'bun:test';
import { DaemonClient } from '../../../src/client/daemon-client.ts';
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
import { CORE, inventoryOf, surface } from '../client/fixtures.ts';

/**
 * The generated client over a REAL sealed session: real handshake, real seal, real device proof. A scripted daemon
 * answers each request record, so the test proves the shell's whole path — guard, transport, session — end to end.
 */

const device = await testDevice('fy_dev_transport');
const board = surface('board', { routes: ['GET /v1/board'] });
const compiled = [...CORE, board];

type Answer = (record: { method: string; path: string }) => { status: number; body: unknown };

async function scriptedDaemon(
  answer: Answer,
  options: { readonly spoof?: boolean; readonly closes?: readonly number[] } = {},
) {
  const identity = await newDaemonIdentity();
  const seen: string[] = [];
  let dials = 0;
  let requests = 0;
  const dial = (events: CarrierSocketEvents) => {
    dials += 1;
    const daemon = new ScriptedDaemon(identity, testSessionId(dials));
    let queue = Promise.resolve();
    const deliver = async (frame: Uint8Array) => events.onBinary(frame);
    // The rendezvous (or the daemon on a direct carrier) says the session is ready.
    queueMicrotask(() => void deliver(readyFrame(testSessionId(dials))));
    let keyed = false;
    return {
      send(bytes: Uint8Array) {
        const copy = Uint8Array.from(bytes);
        queue = queue.then(async () => {
          const decoded = decodeFrame(copy);
          if (!decoded.ok) return;
          if (decoded.frame.kind === FRAME_KINDS.handshake && !keyed) {
            keyed = true;
            await deliver(options.spoof === true ? await daemon.spoof(copy) : await daemon.answer(copy));
            return;
          }
          if (decoded.frame.kind !== FRAME_KINDS.data) return;
          const record = (await daemon.receive(copy)) as Record<string, unknown>;
          if (record.t === 'auth') {
            seen.push(`auth ${String(record.deviceId)} proved=${await daemon.proves(record, device.publicKey)}`);
            await deliver(
              await daemon.record({ t: 'authenticated', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }),
            );
            return;
          }
          if (record.t === 'req') {
            const request = { method: String(record.method), path: String(record.path) };
            seen.push(`${request.method} ${request.path}`);
            const code = options.closes?.[requests++];
            if (code !== undefined) {
              events.onClose(code, 'the session ended');
              return;
            }
            const { status, body } = answer(request);
            await deliver(
              await daemon.record({ t: 'res', id: record.id, status, headers: {}, body: JSON.stringify(body) }),
            );
          }
        });
      },
      sendText() {},
      close() {},
    };
  };
  return { identity, dial, seen, dials: () => dials };
}

describe('the generated client over a sealed session', () => {
  test('bootstraps, proves the device and carries a guarded call', async () => {
    const daemon = await scriptedDaemon(({ path }) => {
      if (path === '/v1/plugins') return { status: 200, body: inventoryOf(compiled) };
      if (path === '/v1/health') return { status: 200, body: { protocol: 1, version: '5.0.0' } };
      if (path === '/v1/board') return { status: 200, body: { cards: ['F1'] } };
      return { status: 404, body: { error: 'none', code: 'not_found' } };
    });
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: daemon.identity.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    const client = new DaemonClient({ transport, surfaces: compiled });
    await client.start();
    expect(await client.forPackage('board').call('GET /v1/board')).toEqual({ cards: ['F1'] });
    await settle();
    expect(daemon.seen).toEqual([
      'auth fy_dev_transport proved=true',
      'GET /v1/plugins',
      'GET /v1/health',
      'GET /v1/board',
    ]);
    // One request session carried every call; the second session is the event stream (opened after the bootstrap).
    expect(daemon.dials()).toBe(2);
  });

  test('a session to a daemon that is not the pinned one never sends a request', async () => {
    // A carrier that introduced another daemon: its hello is validly signed, by the WRONG key.
    const daemon = await scriptedDaemon(() => ({ status: 200, body: {} }), { spoof: true });
    const other = await newDaemonIdentity();
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: other.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    await expect(transport.request({ method: 'GET', path: '/v1/plugins' })).rejects.toThrow();
    await settle();
    expect(daemon.seen).toEqual([]);
  });
});

describe('R244 the app session lease retry', () => {
  const transportFor = async (closes: readonly number[]) => {
    const daemon = await scriptedDaemon(() => ({ status: 200, body: { read: true } }), { closes });
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: daemon.identity.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    return { daemon, transport };
  };

  test('R244 retries a read once silently on a fresh proved session after 4441', async () => {
    for (const method of ['GET', 'HEAD']) {
      const { daemon, transport } = await transportFor([4441]);
      let reconnected = 0;
      transport.onReconnect(() => {
        reconnected += 1;
      });
      expect(await transport.request({ method, path: '/v1/health' })).toEqual({
        status: 200,
        headers: {},
        body: { read: true },
      });
      expect(daemon.dials()).toBe(2);
      expect(daemon.seen).toEqual([
        'auth fy_dev_transport proved=true',
        `${method} /v1/health`,
        'auth fy_dev_transport proved=true',
        `${method} /v1/health`,
      ]);
      expect(reconnected).toBe(1);
      transport.close();
    }
  });

  test('R244 a read whose second session also lapses fails without a third attempt', async () => {
    const { daemon, transport } = await transportFor([4441, 4441]);
    await expect(transport.request({ method: 'GET', path: '/v1/health' })).rejects.toMatchObject({ code: 4441 });
    expect(daemon.dials()).toBe(2);
    expect(daemon.seen.filter(item => item.startsWith('GET'))).toHaveLength(2);
    transport.close();
  });

  test('R244 never replays a write after 4441 or any request after 4403', async () => {
    for (const [method, code] of [
      ['POST', 4441],
      ['PUT', 4441],
      ['PATCH', 4441],
      ['DELETE', 4441],
      ['GET', 4403],
      ['HEAD', 4403],
      ['GET', 1006],
    ] as const) {
      const { daemon, transport } = await transportFor([code]);
      await expect(transport.request({ method, path: '/v1/health' })).rejects.toMatchObject({ code });
      expect(daemon.dials()).toBe(1);
      expect(daemon.seen).toEqual(['auth fy_dev_transport proved=true', `${method} /v1/health`]);
      transport.close();
    }
  });
});

describe('what a device’s sessions to one daemon do', () => {
  const transportFor = async (closes: readonly number[]) => {
    const daemon = await scriptedDaemon(() => ({ status: 200, body: { read: true } }), { closes });
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: daemon.identity.daemonId,
      device: device.claim,
      dial: daemon.dial,
    });
    return { daemon, transport };
  };

  /**
   * REAL FAILURE (reported, product untouched): today's `shared-reads.ts` never reached `packages/app` — no file under
   * `src/` shares an identical in-flight read, so two identical reads send two records. `.failing` keeps it out of the
   * guarantee check's passing set; when the sharing lands this starts passing and bun says to drop `.failing`.
   */
  test.failing('R519 (open) identical in-flight reads are sent once and the answer is shared, never cached', async () => {
    const { daemon, transport } = await transportFor([]);
    const [first, second] = await Promise.all([
      transport.request({ method: 'GET', path: '/v1/health' }),
      transport.request({ method: 'GET', path: '/v1/health' }),
    ]);
    expect(first).toEqual(second);
    expect(daemon.seen.filter(item => item === 'GET /v1/health')).toHaveLength(1);
    // Nothing is cached: a read after the answer is sent afresh.
    await transport.request({ method: 'GET', path: '/v1/health' });
    expect(daemon.seen.filter(item => item === 'GET /v1/health')).toHaveLength(2);
    transport.close();
  });

  /** REAL FAILURE (reported): the transport holds ONE request session, so a body in parts waits behind every read. */
  test.failing('R532 (open) a body large enough to need parts goes on a second request session', async () => {
    const { daemon, transport } = await transportFor([]);
    await transport.request({ method: 'GET', path: '/v1/health' });
    expect(daemon.dials()).toBe(1);
    const upload = transport.request({ method: 'POST', path: '/v1/upload', body: 'x'.repeat(300_000) });
    upload.catch(() => undefined);
    await settle();
    expect(daemon.dials()).toBe(2);
    transport.close();
  });

  test('R568 closing the transport ends the request session it owns', async () => {
    const { daemon, transport } = await transportFor([]);
    await transport.request({ method: 'GET', path: '/v1/health' });
    transport.close();
    await settle();
    // The next request opens a session of its own: the closed one is gone.
    await transport.request({ method: 'GET', path: '/v1/health' });
    expect(daemon.dials()).toBe(2);
    transport.close();
  });
});
