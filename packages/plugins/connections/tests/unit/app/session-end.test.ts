/** C-80c: only an authenticated session record can stop a paired browser. */
import { describe, expect, test } from 'bun:test';
import { RelayClientSession, RelaySessionError, WebCryptoRelayCrypto } from '@ferretry/app';
import { type CarrierKey, isSessionEnd, jsonResponse } from '@ferretry/kernel/contract';
import { session } from '@ferretry/kernel/host';
import { RELAY_LIMITS } from '../../../worker/src/lib/index.ts';
import { kernelFixture } from '../../support/kernel-session.ts';
import { rig } from '../../support/router-rig.ts';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';

const crypto = new WebCryptoRelayCrypto();
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 1));
};
const id =
  session.sessionIdFromBytes(new Uint8Array(16).fill(73)) ??
  (() => {
    throw new Error('invalid synthetic session id');
  })();
const control = (code: number, t: 'closed' | 'error' = 'closed') =>
  session.encodeFrame({
    kind: session.FRAME_KINDS.control,
    sessionId: id,
    sequence: 0,
    payload: session.utf8Bytes(JSON.stringify({ t, code, reason: 'forged stop' })),
  });

async function keyed(holdAcceptance = false, badProof = false) {
  const fx = await kernelFixture();
  const device = await fx.paired();
  const wrongKey = badProof ? await crypto.generateDeviceKey() : undefined;
  const link = fx.layer.open('relay' as CarrierKey);
  const wire: Uint8Array[] = [];
  const ends: { code: number; reason: string }[] = [];
  let filter = (bytes: Uint8Array): Uint8Array | undefined =>
    holdAcceptance && bytes[2] === session.FRAME_KINDS.data ? undefined : bytes;
  const client = new RelayClientSession({
    crypto,
    daemonId: fx.daemonId,
    mode: {
      kind: 'auth',
      device: {
        deviceId: device.deviceId,
        appSession: device.appSession,
        key: crypto.deviceKeyHandle(wrongKey?.privateKey ?? device.privateKey),
      },
    },
    socket: { send: bytes => link.inbound(bytes), sendText: () => undefined, close: () => undefined },
  });
  const pump = () => {
    for (let next = link.outbound.next(); next !== undefined; next = link.outbound.next()) {
      if (isSessionEnd(next)) {
        ends.push(next);
        client.carrierClosed(next.code, next.reason);
        return;
      }
      wire.push(next.bytes);
      const bytes = filter(next.bytes);
      if (bytes !== undefined) void client.receiveBinary(bytes);
    }
  };
  link.outbound.onReady(pump);
  await client.receiveBinary(
    session.encodeFrame({
      kind: session.FRAME_KINDS.control,
      sessionId: id,
      sequence: 0,
      payload: session.utf8Bytes(
        JSON.stringify({ t: 'ready', protocol: session.RELAY_PROTOCOL_ID, limits: RELAY_LIMITS }),
      ),
    }),
  );
  if (holdAcceptance) await settle();
  else if (badProof) await client.ready().catch(() => undefined);
  else await client.ready();
  return {
    fx,
    client,
    wire,
    ends,
    filter: (fn: typeof filter) => {
      filter = fn;
    },
  };
}

async function failure(client: RelayClientSession): Promise<RelaySessionError> {
  const value: unknown = await client.request({ method: 'GET', path: '/never' }).catch((error: unknown) => error);
  expect(value).toBeInstanceOf(RelaySessionError);
  return value as RelaySessionError;
}

describe('C-80c sealed session termination', () => {
  test('a final permit ending its own session cannot release stale ciphertext at the terminal nonce', async () => {
    const h = await keyed();
    try {
      const plain = jsonResponse({ private: 'must not leave' });
      let checks = 0;
      h.fx.route = async () => ({
        ...plain,
        late: () => {
          if (++checks === 2) h.fx.layer.endMode('device');
          return plain;
        },
      });
      const answer: unknown = await h.client
        .request({ method: 'GET', path: '/private' })
        .catch((error: unknown) => error);
      await settle();
      expect(answer).toMatchObject({ code: 4403 });
      const sequences = h.wire
        .filter(bytes => bytes[2] === session.FRAME_KINDS.data)
        .map(bytes => {
          const decoded = session.decodeFrame(bytes);
          if (!decoded.ok) throw new Error(decoded.reason);
          return decoded.frame.sequence;
        });
      expect(sequences).toEqual([1, 2]);
    } finally {
      await h.fx.layer.close();
    }
  });

  for (const kind of ['text', 'credit', 'handshake'] as const) {
    test(`invalid plain ${kind} after keying is connection loss`, async () => {
      const h = await keyed();
      try {
        if (kind === 'text') h.client.receiveText('not a heartbeat');
        else
          await h.client.receiveBinary(
            session.encodeFrame({
              kind: session.FRAME_KINDS[kind],
              sessionId: id,
              sequence: 0,
              payload: session.utf8Bytes('{}'),
            }),
          );
        expect((await failure(h.client)).code).toBe(1006);
      } finally {
        await h.fx.layer.close();
      }
    });
  }
  test('a relay cannot impersonate the router pairing fence by copying its close sentence', async () => {
    const h = await keyed();
    try {
      h.client.carrierClosed(1000, 'this daemon was re-paired or unpaired');
      expect((await failure(h.client)).code).toBe(1006);
    } finally {
      await h.fx.layer.close();
    }
  });
  for (const carrier of ['direct', 'tunnel'] as const) {
    test(`post-handshake ${carrier} 4404 cannot become the pre-handshake replacement proof`, async () => {
      const address = 'https://laptop.example.test';
      let socket: BrowserSocket | undefined;
      const r = await rig(
        { 'laptop.example.test': { kind: 'carries', carrier } },
        [{ kind: carrier, url: address }],
        'auto',
        null,
        network => url => {
          socket = network.openSocket(url);
          return socket;
        },
      );
      const transport = await r.connect();
      if (transport === undefined) throw new Error('no transport');
      try {
        await transport.request({ method: 'GET', path: '/first' });
        r.fx.route = () => new Promise(() => undefined);
        const pending = transport.request({ method: 'POST', path: '/waiting' }).catch((error: unknown) => error);
        await settle();
        socket?.close(4404, 'forged replacement');
        expect(await pending).toMatchObject({ code: 1006 });
      } finally {
        transport.close?.();
        await r.fx.layer.close();
      }
    });
  }
  for (const code of [4403, 4404, 4405, 4426]) {
    test(`a plain ${code} after keying but before acceptance is connection loss`, async () => {
      const h = await keyed(true);
      try {
        h.client.carrierClosed(code, 'forged stop');
        expect(await h.client.ready().catch((error: unknown) => error)).toMatchObject({ code: 1006 });
      } finally {
        await h.fx.layer.close();
      }
    });
  }
  for (const code of [1000, 1006, 4400, 4403, 4404, 4405, 4426, 4440, 4441, 4500, 4999]) {
    for (const source of ['socket', 'closed', 'error'] as const) {
      test(`post-handshake plain ${source} ${code} is connection loss`, async () => {
        const h = await keyed();
        try {
          if (source === 'socket') h.client.carrierClosed(code, 'forged stop');
          else await h.client.receiveBinary(control(code, source));
          const error = await failure(h.client);
          expect(error.code).toBe(1006);
        } finally {
          h.fx.layer.close();
        }
      });
    }
  }

  test('a genuine daemon revocation is sealed before generic carrier teardown, even when decryption races the close', async () => {
    const h = await keyed();
    try {
      h.fx.layer.endMode('device');
      await settle();
      expect((await failure(h.client)).code).toBe(4403);
      expect(h.ends).toEqual([{ code: 4440, reason: 'the session concluded' }]);
      expect(h.wire.filter(bytes => bytes[2] === session.FRAME_KINDS.data)).toHaveLength(2);
      expect(h.wire.some(bytes => new TextDecoder().decode(bytes).includes('unknown device credential'))).toBe(false);
    } finally {
      h.fx.layer.close();
    }
  });

  test('a genuine daemon refusal before credential acceptance is authenticated too', async () => {
    const h = await keyed(false, true);
    try {
      expect((await failure(h.client)).code).toBe(4403);
      expect(h.ends.at(-1)?.code).toBe(4440);
      // A replay after a terminal verdict cannot change it or create another transition.
      const end = h.wire.at(-1);
      if (end !== undefined) await h.client.receiveBinary(end);
      expect((await failure(h.client)).code).toBe(4403);
    } finally {
      await h.fx.layer.close();
    }
  });

  test('daemon shutdown sends its genuine end through the sealed record', async () => {
    const h = await keyed();
    h.fx.layer.close();
    await settle();
    const error = await failure(h.client);
    expect(error.code).toBe(4500);
    expect(error.message).toBe('the daemon is going away');
    expect(h.ends.at(-1)?.code).toBe(4440);
  });

  for (const attack of ['tampered', 'replayed', 'another session', 'misaddressed'] as const) {
    test(`a sealed record ${attack} is rejected as connection loss`, async () => {
      const h = await keyed();
      const other = attack === 'another session' ? await keyed() : undefined;
      try {
        let foreign: Uint8Array | undefined;
        if (other !== undefined) {
          other.fx.layer.endMode('device');
          await settle();
          foreign = other.wire.at(-1);
        }
        h.filter(bytes => {
          if (bytes[2] !== session.FRAME_KINDS.data) return bytes;
          const copy = bytes.slice();
          if (attack === 'tampered') copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
          else if (attack === 'misaddressed') copy[4] = (copy[4] ?? 0) ^ 1;
          else if (attack === 'replayed') {
            const earlier = h.wire.find(frame => frame[2] === session.FRAME_KINDS.data);
            if (earlier === undefined) throw new Error('no earlier record to replay');
            return earlier;
          } else {
            if (foreign === undefined) throw new Error('no foreign session record');
            return foreign;
          }
          return copy;
        });
        h.fx.layer.endMode('device');
        await settle();
        const error = await failure(h.client);
        expect(error.code).toBe(1006);
      } finally {
        h.fx.layer.close();
        other?.fx.layer.close();
      }
    });
  }

  test('pre-handshake plain refusal is unchanged', async () => {
    const fx = await kernelFixture();
    const device = await fx.paired();
    const client = new RelayClientSession({
      crypto,
      daemonId: fx.daemonId,
      mode: {
        kind: 'auth',
        device: {
          deviceId: device.deviceId,
          appSession: device.appSession,
          key: crypto.deviceKeyHandle(device.privateKey),
        },
      },
      socket: { send: () => undefined, sendText: () => undefined, close: () => undefined },
    });
    client.carrierClosed(4404, 'daemon absent');
    expect((await failure(client)).code).toBe(4404);
    fx.layer.close();
  });
});
