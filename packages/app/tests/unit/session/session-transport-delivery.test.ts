import { describe, expect, test } from 'bun:test';
import { PAIRING_CLEARED_REASON } from '../../../src/session/session-error.ts';
import { carrierFateOf } from '../../../src/client/transport.ts';
import type { CarrierSocketEvents } from '../../../src/session/session-transport.ts';
import { SessionTransport } from '../../../src/session/session-transport.ts';
import { decodeFrame, FRAME_KINDS, SESSION_PROTOCOL_ID } from '../../../src/session/wire/index.ts';
import {
  LEASE_ENDS,
  newDaemonIdentity,
  readyFrame,
  relayCrypto,
  ScriptedDaemon,
  testDevice,
  testSessionId,
} from '../../support/relay.ts';

/**
 * Where a request died tells whether it can be sent again (u2-11). A session that never opened carried nothing:
 * `unsent`. A request the daemon may have executed: `unknown`, and an id that was ever in doubt stays in doubt.
 */

const device = await testDevice('fy_dev_delivery');
const REQUEST_ID = 'x-fy-request-id';

/**
 * A daemon whose dials each follow a script: `answer` (a normal session), `dead` (the carrier closes before the
 * daemon is ever reached) or `dies` (the session opens, takes the request, then the carrier closes under it).
 * `fenced` is the router closing the session itself (code 1000, its fence sentence) as it takes the request.
 */
async function scripted(script: readonly ('answer' | 'dead' | 'dies' | 'fenced' | 'closed')[]) {
  const identity = await newDaemonIdentity();
  let dials = 0;
  const dial = (events: CarrierSocketEvents) => {
    const mode = script[Math.min(dials, script.length - 1)] ?? 'answer';
    dials += 1;
    const session = testSessionId(dials);
    if (mode === 'dead') {
      queueMicrotask(() => events.onClose(4404, 'no daemon on this route'));
      return { send() {}, sendText() {}, close() {} };
    }
    const daemon = new ScriptedDaemon(identity, session);
    let queue = Promise.resolve();
    const deliver = async (frame: Uint8Array) => events.onBinary(frame);
    queueMicrotask(() => void deliver(readyFrame(session)));
    let keyed = false;
    return {
      send(bytes: Uint8Array) {
        const copy = Uint8Array.from(bytes);
        queue = queue.then(async () => {
          const decoded = decodeFrame(copy);
          if (!decoded.ok) return;
          if (decoded.frame.kind === FRAME_KINDS.handshake && !keyed) {
            keyed = true;
            await deliver(await daemon.answer(copy));
            return;
          }
          if (decoded.frame.kind !== FRAME_KINDS.data) return;
          const record = (await daemon.receive(copy)) as Record<string, unknown>;
          if (record.t === 'auth') {
            await deliver(
              await daemon.record({ t: 'authenticated', protocol: SESSION_PROTOCOL_ID, accessExpiresAt: LEASE_ENDS }),
            );
            return;
          }
          if (record.t !== 'req') return;
          if (mode === 'closed') {
            events.onClose(1000, 'the carrier closed it');
            return;
          }
          if (mode === 'fenced') {
            events.onClose(1000, PAIRING_CLEARED_REASON, undefined, true);
            return;
          }
          if (mode === 'dies') {
            events.onClose(1006, 'the carrier dropped');
            return;
          }
          await deliver(await daemon.record({ t: 'res', id: record.id, status: 200, headers: {}, body: '{}' }));
        });
      },
      sendText() {},
      close() {},
    };
  };
  const transport = new SessionTransport({
    crypto: relayCrypto,
    daemonId: identity.daemonId,
    device: device.claim,
    dial,
  });
  return Object.assign(transport, { dials: () => dials });
}

const failureOf = (transport: SessionTransport, id: string | undefined): Promise<unknown> =>
  transport
    .request({
      method: 'POST',
      path: '/v1/send',
      body: { text: 'hi' },
      ...(id === undefined ? {} : { headers: { [REQUEST_ID]: id } }),
    })
    .then(
      () => {
        throw new Error('the request was answered');
      },
      (reason: unknown) => reason,
    );

describe('u2-11 what a failed request says about whether it left', () => {
  test('a session that never opened carried nothing: unsent', async () => {
    const transport = await scripted(['dead']);
    expect(carrierFateOf(await failureOf(transport, 'send-1'))).toBe('unsent');
    transport.close();
  });

  test('a session that died after the request was sent: unknown', async () => {
    const transport = await scripted(['dies']);
    expect(carrierFateOf(await failureOf(transport, 'send-2'))).toBe('unknown');
    transport.close();
  });

  test('a retry that never opened, after an attempt that was sent, stays unknown', async () => {
    const transport = await scripted(['dies', 'dead']);
    expect(carrierFateOf(await failureOf(transport, 'send-3'))).toBe('unknown');
    expect(carrierFateOf(await failureOf(transport, 'send-3'))).toBe('unknown');
    transport.close();
  });

  test('another request id is not in doubt because a different one was', async () => {
    const transport = await scripted(['dies', 'dead']);
    expect(carrierFateOf(await failureOf(transport, 'send-4'))).toBe('unknown');
    expect(carrierFateOf(await failureOf(transport, 'send-5'))).toBe('unsent');
    transport.close();
  });

  test('a request with no id is judged on its own attempt only', async () => {
    const transport = await scripted(['dies', 'dead']);
    expect(carrierFateOf(await failureOf(transport, undefined))).toBe('unknown');
    expect(carrierFateOf(await failureOf(transport, undefined))).toBe('unsent');
    transport.close();
  });
});

const attempt = (transport: SessionTransport, method: string): Promise<{ answered: boolean; failure?: unknown }> =>
  transport.request({ method, path: '/v1/thing', ...(method === 'GET' ? {} : { body: { x: 1 } }) }).then(
    () => ({ answered: true }),
    (failure: unknown) => ({ answered: false, failure }),
  );

describe('a request whose carrier died is sent again only when that is safe', () => {
  test('a read that died after it was sent is sent again once, on a fresh session', async () => {
    const transport = await scripted(['dies', 'answer']);
    expect((await attempt(transport, 'GET')).answered).toBe(true);
    expect(transport.dials()).toBe(2);
    transport.close();
  });

  test('a HEAD is a read too', async () => {
    const transport = await scripted(['dies', 'answer']);
    expect((await attempt(transport, 'HEAD')).answered).toBe(true);
    transport.close();
  });

  test('a press that died after it was sent is NEVER sent again: it is lost, and in doubt', async () => {
    const transport = await scripted(['dies', 'answer']);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const fresh = await scripted(['dies', 'answer']);
      const result = await attempt(fresh, method);
      expect(result.answered).toBe(false);
      expect(carrierFateOf(result.failure)).toBe('unknown');
      expect(fresh.dials()).toBe(1);
      fresh.close();
    }
    transport.close();
  });

  test('a read that dies a second time is lost: one resend, never two', async () => {
    const transport = await scripted(['dies', 'dies', 'answer']);
    const result = await attempt(transport, 'GET');
    expect(result.answered).toBe(false);
    expect(carrierFateOf(result.failure)).toBe('unknown');
    expect(transport.dials()).toBe(2);
    transport.close();
  });

  test('a session that never opens is not asked again at once: the walk already tried every carrier', async () => {
    for (const method of ['GET', 'POST']) {
      const transport = await scripted(['dead', 'answer']);
      const result = await attempt(transport, method);
      expect(result.answered).toBe(false);
      expect(carrierFateOf(result.failure)).toBe('unsent');
      expect(transport.dials()).toBe(1);
      transport.close();
    }
  });

  test('a read that was sent, then found its fresh session dead, stays in doubt', async () => {
    const transport = await scripted(['dies', 'dead']);
    const result = await attempt(transport, 'GET');
    expect(result.answered).toBe(false);
    expect(carrierFateOf(result.failure)).toBe('unknown');
    transport.close();
  });

  test('a caller that gave up is not answered with a resend', async () => {
    const transport = await scripted(['dies', 'answer']);
    const controller = new AbortController();
    controller.abort(new Error('gave up'));
    const result = await transport.request({ method: 'GET', path: '/v1/thing', signal: controller.signal }).then(
      () => 'answered',
      () => 'failed',
    );
    expect(result).toBe('failed');
    expect(transport.dials()).toBeLessThanOrEqual(1);
    transport.close();
  });
});

describe('the router’s own fence refusal is not a dead carrier, so it is never sent again', () => {
  test('a read the router fenced (re-paired, unpaired, republished) is lost once, with no second dial', async () => {
    const transport = await scripted(['fenced', 'answer']);
    const result = await attempt(transport, 'GET');
    expect(result.answered).toBe(false);
    expect((result.failure as Error).message).toBe(PAIRING_CLEARED_REASON);
    expect(transport.dials()).toBe(1);
    transport.close();
  });

  test('a same-code close that is NOT one of the fence sentences is still a carrier that died', async () => {
    const transport = await scripted(['closed', 'answer']);
    expect((await attempt(transport, 'GET')).answered).toBe(true);
    expect(transport.dials()).toBe(2);
    transport.close();
  });
});
