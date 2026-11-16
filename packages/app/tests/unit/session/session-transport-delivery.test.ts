import { describe, expect, test } from 'bun:test';
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
 */
async function scripted(script: readonly ('answer' | 'dead' | 'dies')[]) {
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
  return new SessionTransport({ crypto: relayCrypto, daemonId: identity.daemonId, device: device.claim, dial });
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
