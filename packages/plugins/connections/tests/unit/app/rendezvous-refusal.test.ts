/** The refusal frame the Worker sends before it hangs up (R159): read off the wire the Worker writes. */
import { describe, expect, test } from 'bun:test';
import { rendezvousRefusal } from '../../../app/lib/rendezvous-refusal.ts';
import {
  encodeControlMessage,
  encodeFrame,
  FRAME_KINDS,
  RELAY_LIMITS,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  type SessionId,
} from '../../../worker/src/lib/index.ts';

const frame = (kind: number, sessionId: SessionId, payload: Uint8Array) =>
  encodeFrame({ kind: kind as 1, sessionId, sequence: 0, payload });
const refusal = (code: number, reason: string) =>
  frame(FRAME_KINDS.control, RENDEZVOUS_SESSION_ID, encodeControlMessage({ t: 'error', code, reason }));
const json = (value: unknown) =>
  frame(FRAME_KINDS.control, RENDEZVOUS_SESSION_ID, new TextEncoder().encode(JSON.stringify(value)));

describe('reading a rendezvous refusal', () => {
  test('R159 reads the code and reason the Worker writes before it closes', () => {
    expect(rendezvousRefusal(refusal(4433, 'hosted relay per-daemon daily bandwidth ceiling is reached'))).toEqual({
      code: 4433,
      reason: 'hosted relay per-daemon daily bandwidth ceiling is reached',
    });
  });

  test('anything that is not a refusal on the rendezvous id reads as nothing', () => {
    const ready = frame(
      FRAME_KINDS.control,
      RENDEZVOUS_SESSION_ID,
      encodeControlMessage({ t: 'ready', protocol: RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
    );
    const otherSession: SessionId = { bytes: new Uint8Array(16).fill(7), text: 'x' };
    const good = refusal(4433, 'r');
    expect(rendezvousRefusal(ready)).toBeUndefined();
    expect(
      rendezvousRefusal(
        frame(FRAME_KINDS.control, otherSession, encodeControlMessage({ t: 'error', code: 4433, reason: 'r' })),
      ),
    ).toBeUndefined();
    expect(
      rendezvousRefusal(frame(FRAME_KINDS.data, RENDEZVOUS_SESSION_ID, new Uint8Array([1, 2, 3]))),
    ).toBeUndefined();
    expect(rendezvousRefusal(good.subarray(0, 28))).toBeUndefined();
    expect(rendezvousRefusal(new Uint8Array(40))).toBeUndefined();
    const wrongVersion = good.slice();
    wrongVersion[1] = 9;
    expect(rendezvousRefusal(wrongVersion)).toBeUndefined();
    const notUtf8 = frame(FRAME_KINDS.control, RENDEZVOUS_SESSION_ID, new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(rendezvousRefusal(notUtf8)).toBeUndefined();
    expect(
      rendezvousRefusal(frame(FRAME_KINDS.control, RENDEZVOUS_SESSION_ID, new TextEncoder().encode('nope'))),
    ).toBeUndefined();
    expect(rendezvousRefusal(json(null))).toBeUndefined();
    expect(rendezvousRefusal(json(4433))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'closed', code: 4433, reason: 'r' }))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'error', code: '4433', reason: 'r' }))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'error', code: 4433.5, reason: 'r' }))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'error', code: 1000, reason: 'r' }))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'error', code: 5000, reason: 'r' }))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'error', code: 4433, reason: 7 }))).toBeUndefined();
    expect(rendezvousRefusal(json({ t: 'error', code: 4433, reason: 'x'.repeat(201) }))).toBeUndefined();
  });
});
