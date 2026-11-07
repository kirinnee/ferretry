import { describe, expect, test } from 'bun:test';
import { RelayLink } from '../../../daemon/lib/relay/link.ts';
import { type ControlMessage, decodeControlMessage, encodeControlMessage } from '../../../daemon/lib/relay/control.ts';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  RENDEZVOUS_SESSION_ID,
  sessionIdFromBytes,
  type SessionId,
  toBase64Url,
} from '../../../daemon/lib/wire-mirror/index.ts';
import { FakeSessions } from '../../support/sessions.ts';
const id = (n: number) => sessionIdFromBytes(new Uint8Array(16).fill(n))!;
const control = (message: ControlMessage, sessionId: SessionId = RENDEZVOUS_SESSION_ID) =>
  encodeFrame({ kind: FRAME_KINDS.control, sessionId, sequence: 0, payload: encodeControlMessage(message) });
function harness(failWrites = false) {
  const layer = new FakeSessions();
  const sent: Uint8Array[] = [];
  const closes: number[] = [];
  let signed = 0;
  const timers = new Set<() => void>();
  const link = new RelayLink({
    layer,
    relayHost: 'relay.example',
    identity: {
      daemonId: 'fy_daemon_' + 'a'.repeat(43),
      signClaim: async () => {
        signed++;
        return { publicKeySpki: new Uint8Array(44), signature: new Uint8Array(64) };
      },
    },
    socket: {
      send: b => {
        if (failWrites) throw new Error('socket write failed');
        sent.push(b);
      },
      sendText: () => undefined,
      close: c => {
        closes.push(c);
      },
    },
    scheduler: {
      after: (_ms, fn) => {
        timers.add(fn);
        return {
          cancel: () => {
            timers.delete(fn);
          },
        };
      },
    },
  });
  return { link, layer, sent, closes, timers, signed: () => signed };
}
describe('rendezvous carrier boundary', () => {
  test('R48 a challenge for an unconfigured host is refused before the signer runs', async () => {
    const h = harness();
    await h.link.accept(
      control({
        t: 'challenge',
        protocol: 'ferretry-relay/1',
        host: 'hostile.example',
        nonce: toBase64Url(new Uint8Array(32)),
        deadlineSeconds: 10,
      }),
    );
    expect(h.signed()).toBe(0);
    expect(h.closes).toEqual([4400]);
  });
  test('R45 a claim names only the all-zero session and the copied strict claim fields', async () => {
    const h = harness();
    await h.link.accept(
      control({
        t: 'challenge',
        protocol: 'ferretry-relay/1',
        host: 'relay.example',
        nonce: toBase64Url(new Uint8Array(32)),
        deadlineSeconds: 10,
      }),
    );
    expect(h.signed()).toBe(1);
    const frame = decodeFrame(h.sent[0]!);
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      expect(frame.frame.sessionId).toEqual(RENDEZVOUS_SESSION_ID);
      expect(decodeControlMessage(frame.frame.payload)?.t).toBe('claim');
    }
  });
  test('R43 unknown control keys close the carrier rather than being ignored', async () => {
    const h = harness();
    await h.link.accept(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: new TextEncoder().encode(JSON.stringify({ t: 'open', unexpected: true })),
      }),
    );
    expect(h.closes).toEqual([4400]);
    expect(h.layer.links).toHaveLength(0);
  });
  test('R63 ending one session leaves the other sessions on the same socket alive', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    await h.link.accept(control({ t: 'open' }, id(2)));
    h.layer.links[0]!.offer({ code: 4441, reason: 'the access lease ended' });
    expect(h.link.report().sessions).toBe(1);
    expect(h.closes).toHaveLength(0);
    h.layer.links[1]!.offer({ sequence: 1, bytes: new Uint8Array([9]) });
    expect(h.sent.at(-1)).toEqual(new Uint8Array([9]));
    h.link.close();
  });
  test('R102 a relayed frame reaches exactly the session named by its envelope', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    await h.link.accept(control({ t: 'open' }, id(2)));
    const bytes = encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId: id(2),
      sequence: 0,
      payload: new Uint8Array([7]),
    });
    await h.link.accept(bytes);
    expect(h.layer.links[0]?.inbounds).toHaveLength(0);
    expect(h.layer.links[1]?.inbounds[0]).toBe(bytes);
    expect(h.layer.carriers.map(String)).toEqual(['relay', 'relay']);
    h.link.close();
  });
  test('R63 in-flight frames for a locally ended session are dropped during its grace', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    h.layer.links[0]!.offer({ code: 4429, reason: 'too many sessions' });
    await h.link.accept(
      encodeFrame({ kind: FRAME_KINDS.handshake, sessionId: id(1), sequence: 0, payload: new Uint8Array([7]) }),
    );
    expect(h.closes).toHaveLength(0);
    h.link.close();
    expect(h.timers.size).toBe(0);
  });
  test('R63 a frame for a never-opened session closes the whole inconsistent link', async () => {
    const h = harness();
    await h.link.accept(
      encodeFrame({ kind: FRAME_KINDS.handshake, sessionId: id(8), sequence: 0, payload: new Uint8Array([7]) }),
    );
    expect(h.closes).toEqual([4400]);
  });
  test('R140 a dropped relay socket releases every Kernel link before forgetting it', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    await h.link.accept(control({ t: 'open' }, id(2)));
    h.link.close();
    expect(h.layer.links.every(link => link.closedWith !== undefined)).toBe(true);
    expect(h.layer.links.every(link => link.listeners.size === 0)).toBe(true);
  });
});

test('R140 an outbound socket failure releases Kernel sessions rather than leaking the queue', async () => {
  const h = harness(true);
  await h.link.accept(control({ t: 'open' }, id(1)));
  h.layer.links[0]!.offer({ sequence: 1, bytes: new Uint8Array([1]) });
  expect(h.closes).toEqual([4500]);
  expect(h.layer.links[0]?.closedWith).toBeDefined();
});
