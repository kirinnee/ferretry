import { describe, expect, test } from 'bun:test';
import type { SessionLayer } from '@ferretry/kernel/contract';
import { testIdentity } from '@ferretry/kernel/testing';
import { createIdentitySigner } from '../../../../../core/kernel/host/session/signer.ts';
import { realSessionLayer, settle } from '../../support/kernel-layer.ts';
import { RelayLink } from '../../../daemon/lib/relay/link.ts';
import {
  type ControlMessage,
  decodeControlMessage,
  encodeControlMessage,
  RELAY_LIMITS,
} from '../../../daemon/lib/relay/control.ts';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KINDS,
  fromBase64Url,
  NONCE_BYTES,
  RELAY_PROTOCOL_ID,
  RENDEZVOUS_SESSION_ID,
  sessionIdFromBytes,
  type SessionId,
  toBase64Url,
} from '@ferretry/kernel/wire';
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
      sign: async () => {
        signed++;
        return { daemonId: 'fy_daemon_' + 'a'.repeat(43), publicKey: 'A'.repeat(59), signature: 'A'.repeat(86) };
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

describe('the rendezvous link against the real Kernel', () => {
  /** A link whose identity and session layer are the Kernel's own: the signer and the per-connection bound are real. */
  async function realLink(layer?: SessionLayer) {
    const throwaway = await testIdentity();
    const signer = createIdentitySigner(throwaway.key);
    const sent: Uint8Array[] = [];
    const closes: number[] = [];
    const link = new RelayLink({
      layer: layer ?? (await realSessionLayer()).layer,
      relayHost: 'relay.example',
      identity: { daemonId: throwaway.daemonId, sign: request => signer.sign(request) },
      socket: {
        send: bytes => void sent.push(bytes),
        sendText: () => undefined,
        close: code => void closes.push(code),
      },
      scheduler: { after: () => ({ cancel: () => undefined }) },
    });
    return { link, sent, closes, throwaway };
  }
  const controls = (sent: readonly Uint8Array[]) =>
    sent.flatMap(bytes => {
      const decoded = decodeFrame(bytes);
      if (!decoded.ok || decoded.frame.kind !== FRAME_KINDS.control) return [];
      const message = decodeControlMessage(decoded.frame.payload);
      return message === null ? [] : [{ sessionId: decoded.frame.sessionId.text, message }];
    });

  test('R46 the claim signs the bare label then LP(protocol), LP(daemonId), LP(host), LP(nonce), 4-byte big-endian', async () => {
    const h = await realLink();
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    await h.link.accept(
      control({
        t: 'challenge',
        protocol: RELAY_PROTOCOL_ID,
        host: 'relay.example',
        nonce: toBase64Url(nonce),
        deadlineSeconds: 10,
      }),
    );
    const claim = controls(h.sent).find(entry => entry.message.t === 'claim')?.message;
    if (claim?.t !== 'claim') throw new Error('no claim was sent');
    // The transcript is spelled out here, independently of the code that builds it.
    const utf8 = (text: string) => new TextEncoder().encode(text);
    const lp = (bytes: Uint8Array) => {
      const out = new Uint8Array(4 + bytes.length);
      new DataView(out.buffer).setUint32(0, bytes.length, false);
      out.set(bytes, 4);
      return out;
    };
    const parts = [
      utf8('ferretry-relay-claim-v1'),
      lp(utf8(RELAY_PROTOCOL_ID)),
      lp(utf8(h.throwaway.daemonId)),
      lp(utf8('relay.example')),
      lp(nonce),
    ];
    const transcript = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      transcript.set(part, offset);
      offset += part.length;
    }
    const publicKey = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(h.throwaway.publicKeySpki),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const verify = (message: Uint8Array) =>
      crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        new Uint8Array(fromBase64Url(claim.signature)!),
        new Uint8Array(message),
      );
    expect(claim.publicKey).toBe(toBase64Url(h.throwaway.publicKeySpki));
    expect(await verify(transcript)).toBe(true);
    // A length-prefixed label is a different message: the label is deliberately bare.
    expect(await verify(new Uint8Array([...lp(parts[0]!), ...transcript.slice(parts[0]!.length)]))).toBe(false);
    h.link.close();
  });

  test('R50 an unknown control message or key is refused and the socket closes', async () => {
    for (const payload of [
      { t: 'subscribe' },
      { t: 'closed', code: 4400, reason: 'x', extra: 1 },
      { t: 'challenge', protocol: RELAY_PROTOCOL_ID, host: 'relay.example', nonce: 'A', deadlineSeconds: 10, more: 1 },
    ]) {
      const h = await realLink();
      await h.link.accept(
        encodeFrame({
          kind: FRAME_KINDS.control,
          sessionId: RENDEZVOUS_SESSION_ID,
          sequence: 0,
          payload: new TextEncoder().encode(JSON.stringify(payload)),
        }),
      );
      expect(h.closes).toEqual([4400]);
      expect(controls(h.sent).some(entry => entry.message.t === 'claim')).toBe(false);
    }
  });

  test('R232 six sessions awaiting a credential per rendezvous socket; a seventh is 4429, another socket is unaffected', async () => {
    const fx = await realSessionLayer();
    const one = await realLink(fx.layer);
    const two = await realLink(fx.layer);
    for (let n = 1; n <= 7; n += 1) await one.link.accept(control({ t: 'open' }, id(n)));
    await two.link.accept(control({ t: 'open' }, id(1)));
    await settle();
    const closed = (sent: readonly Uint8Array[]) => controls(sent).filter(entry => entry.message.t === 'closed');
    expect(closed(one.sent)).toEqual([
      {
        sessionId: id(7).text,
        message: { t: 'closed', code: 4429, reason: 'too many sessions are awaiting a credential' },
      },
    ]);
    expect(one.link.report().sessions).toBe(6);
    expect(closed(two.sent)).toEqual([]);
    expect(two.link.report().sessions).toBe(1);
    one.link.close();
    two.link.close();
  });
});

describe('rendezvous control the link must answer or refuse', () => {
  const challenge = (nonce: string, host = 'relay.example'): ControlMessage => ({
    t: 'challenge',
    protocol: 'ferretry-relay/1',
    host,
    nonce,
    deadlineSeconds: 10,
  });
  const controlsSent = (sent: readonly Uint8Array[]) =>
    sent.flatMap(bytes => {
      const decoded = decodeFrame(bytes);
      return decoded.ok && decoded.frame.kind === FRAME_KINDS.control
        ? [{ sessionId: decoded.frame.sessionId, message: decodeControlMessage(decoded.frame.payload) }]
        : [];
    });

  test('a session identifier that is already live is ended with a refusal, and the first session goes with it', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    await h.link.accept(control({ t: 'open' }, id(1)));
    expect(h.link.report().sessions).toBe(0);
    expect(h.link.report().lastRefusal).toBe('session 4400: this session identifier is already live');
    expect(h.layer.links[0]?.closedWith).toBe('this session identifier is already live');
    expect(controlsSent(h.sent).at(-1)?.message).toEqual({
      t: 'closed',
      code: 4400,
      reason: 'this session identifier is already live',
    });
  });

  test('a session the rendezvous says is gone is released, and the reason kept', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    await h.link.accept(control({ t: 'closed', code: 4410, reason: 'the peer left' }, id(1)));
    expect(h.link.report().sessions).toBe(0);
    expect(h.layer.links[0]?.closedWith).toBe('the peer left');
    expect(h.link.report().lastRefusal).toBe('the rendezvous ended a session: 4410 the peer left');
    // A close for a session that is not live changes nothing else and does not fail.
    await h.link.accept(control({ t: 'closed', code: 4410, reason: 'again' }, id(9)));
    expect(h.closes).toHaveLength(0);
  });

  test('a refusal from the rendezvous is kept, and the socket is left for the rendezvous to close', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'error', code: 4403, reason: 'not allowed' }));
    expect(h.link.report().lastRefusal).toBe('the rendezvous refused this daemon: 4403 not allowed');
    expect(h.closes).toHaveLength(0);
  });

  test('a message that belongs to another role closes the carrier', async () => {
    const h = harness();
    await h.link.accept(
      control({
        t: 'ready',
        protocol: 'ferretry-relay/1',
        limits: RELAY_LIMITS,
      }),
    );
    expect(h.closes).toEqual([4400]);
    expect(h.link.report().lastRefusal).toContain('unexpected rendezvous control: ready');
  });

  test('a second challenge after the claim closes the carrier', async () => {
    const h = harness();
    await h.link.accept(
      control({
        t: 'claimed',
        protocol: 'ferretry-relay/1',
        limits: RELAY_LIMITS,
      }),
    );
    await h.link.accept(control(challenge(toBase64Url(new Uint8Array(32)))));
    expect(h.closes).toEqual([4400]);
    expect(h.link.report().lastRefusal).toContain('a second challenge arrived after the claim');
    expect(h.signed()).toBe(0);
  });

  test('a challenge nonce that is not the canonical spelling of 32 bytes is refused before anything is signed', async () => {
    const h = harness();
    await h.link.accept(control(challenge(`${'A'.repeat(42)}B`)));
    expect(h.closes).toEqual([4400]);
    expect(h.link.report().lastRefusal).toContain('the challenge nonce is malformed');
    expect(h.signed()).toBe(0);
  });

  test('text that is not JSON is not a control message', async () => {
    const h = harness();
    await h.link.accept(
      encodeFrame({
        kind: FRAME_KINDS.control,
        sessionId: RENDEZVOUS_SESSION_ID,
        sequence: 0,
        payload: new TextEncoder().encode('{nope'),
      }),
    );
    expect(h.closes).toEqual([4400]);
    expect(decodeControlMessage(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(decodeControlMessage(new TextEncoder().encode('{nope'))).toBeNull();
  });

  test('only the newest sessions it ended stay remembered; the oldest is forgotten to bound the memory', async () => {
    const h = harness();
    // Each duplicate open ends its session, which is then remembered for the grace period.
    for (let n = 1; n <= 66; n += 1) {
      await h.link.accept(control({ t: 'open' }, id(n)));
      await h.link.accept(control({ t: 'open' }, id(n)));
    }
    expect(h.timers.size).toBe(64);
    // A late frame for the oldest session is no longer excused: the link is inconsistent.
    await h.link.accept(
      encodeFrame({ kind: FRAME_KINDS.handshake, sessionId: id(1), sequence: 0, payload: new Uint8Array([7]) }),
    );
    expect(h.closes).toEqual([4400]);
  });
});

describe('the grace a locally ended session is remembered for', () => {
  test('a late frame is excused during the grace, and is an inconsistency once it has run out', async () => {
    const h = harness();
    await h.link.accept(control({ t: 'open' }, id(1)));
    await h.link.accept(control({ t: 'open' }, id(1)));
    const late = encodeFrame({
      kind: FRAME_KINDS.handshake,
      sessionId: id(1),
      sequence: 0,
      payload: new Uint8Array([7]),
    });
    await h.link.accept(late);
    expect(h.closes).toHaveLength(0);
    for (const expire of [...h.timers]) expire();
    await h.link.accept(late);
    expect(h.closes).toEqual([4400]);
  });
});
