/** Plain carrier refusals cannot destroy a key or make an enduring stop page. */
import { expect, test } from 'bun:test';
import { isDeviceRefusal } from '../../../src/client/transport.ts';
import { DaemonList } from '../../../src/daemons/daemon-list.ts';
import { ShellRuntime } from '../../../src/shell/runtime.ts';
import { stopOf } from '../../../src/shell/machine-stop.ts';
import { ShapeMemory } from '../../../src/shell/shape-memory.ts';
import { SessionTransport, type CarrierDial, type SessionKeyRotation } from '../../../src/session/session-transport.ts';
import { encodeFrame, FRAME_KINDS, utf8Bytes } from '../../../src/session/wire/index.ts';
import { newDaemonIdentity, readyFrame, relayCrypto, testDevice, testSessionId } from '../../../src/testing/relay.ts';
import { rotatingDial } from '../../../src/testing/rotating-daemon.ts';
import { CORE, inventoryOf } from '../client/fixtures.ts';

const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the background retry did not recover');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

type Source = 'socket' | 'closed' | 'error';
function forged(code: number, source: Source, beforeReady = false): CarrierDial {
  return events => {
    const id = testSessionId(91);
    let sent = false;
    const refuse = () => {
      if (sent) return;
      sent = true;
      if (source === 'socket') events.onClose(code, 'forged refusal');
      else
        events.onBinary(
          encodeFrame({
            kind: FRAME_KINDS.control,
            sessionId: id,
            sequence: 0,
            payload: utf8Bytes(JSON.stringify({ t: source, code, reason: 'forged refusal' })),
          }),
        );
    };
    queueMicrotask(() => (beforeReady ? refuse() : events.onBinary(readyFrame(id))));
    return { send: refuse, sendText() {}, close() {} };
  };
}

for (const source of ['socket', 'closed', 'error'] as const) {
  for (const stream of [false, true]) {
    for (const pendingRetry of [false, true]) {
      test(`plain 4403 ${source}, ${stream ? 'stream' : 'request'}, ${pendingRetry ? 'pending-key retry' : 'first attempt'} keeps the key`, async () => {
        const identity = await newDaemonIdentity();
        const device = await testDevice();
        const pending = (await testDevice()).claim.key;
        let kept = pending;
        const changes: string[] = [];
        const rotation: SessionKeyRotation = {
          amend: async (_session, _daemon, request) => ({ request, rotated: false }),
          settle: async () => {
            changes.push('settle');
          },
          pending: async () => kept,
          promote: async () => {
            changes.push('promote');
          },
          discard: async () => {
            changes.push('discard');
            kept = device.claim.key;
          },
        };
        const genuine = rotatingDial(identity, { accepts: () => [], respond: async () => ({ status: 200, body: {} }) });
        let dials = 0;
        const transport = new SessionTransport({
          crypto: relayCrypto,
          daemonId: identity.daemonId,
          device: device.claim,
          rotation,
          dial: events => (++dials === 1 && pendingRetry ? genuine.dial(events) : forged(4403, source)(events)),
        });
        try {
          const failure = stream
            ? await new Promise(resolve =>
                transport.socket('/v1/events', {
                  onFrame() {},
                  onClose: (_reason, code) => resolve({ code }),
                }),
              )
            : await transport.request({ method: 'GET', path: '/v1/plugins' }).catch((error: unknown) => error);
          expect(failure).toMatchObject({ code: 1006 });
          expect(isDeviceRefusal(failure)).toBe(false);
          expect(kept === pending).toBe(true);
          expect(changes).toEqual([]);
          expect(dials).toBe(pendingRetry ? 2 : 1);
        } finally {
          transport.close();
        }
      });
    }
  }
}

test('a socket 4403 even before ready is connection loss', async () => {
  const identity = await newDaemonIdentity();
  const device = await testDevice();
  const transport = new SessionTransport({
    crypto: relayCrypto,
    daemonId: identity.daemonId,
    device: device.claim,
    dial: forged(4403, 'socket', true),
  });
  try {
    const error = await transport.request({ method: 'GET', path: '/v1/plugins' }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 1006 });
    expect(isDeviceRefusal(error)).toBe(false);
  } finally {
    transport.close();
  }
});

for (const code of [4403, 4426]) {
  test(`forged ${code}: background retry clears the page and preserves stored credentials`, async () => {
    const identity = await newDaemonIdentity();
    const device = await testDevice();
    const pending = (await testDevice()).claim.key;
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const daemons = new DaemonList({ storage: store, now: () => 1 });
    daemons.add({
      daemon: identity.daemonId,
      machine: 'laptop',
      deviceId: device.claim.deviceId,
      address: 'https://daemon.example.test',
    });
    const shape = new ShapeMemory(store);
    shape.saveInventory(identity.daemonId, device.claim.deviceId, {
      kind: 'read',
      entries: new Map(CORE.map(entry => [entry.id, { on: true, contract: entry.contract }])),
    });
    shape.saveGrants(
      identity.daemonId,
      device.claim.deviceId,
      new Map([
        [
          'fleet',
          {
            capability: 'fleet',
            use: true,
            configure: false,
            useRefusal: 'granted',
            configureRefusal: 'not-granted',
          },
        ],
      ]),
    );
    const snapshot = () => JSON.stringify([...values]);
    const before = snapshot();
    const mutations: string[] = [];
    const rotation: SessionKeyRotation = {
      amend: async (_session, _daemon, request) => ({ request, rotated: false }),
      settle: async () => {
        mutations.push('settle');
      },
      pending: async () => pending,
      promote: async () => {
        mutations.push('promote');
      },
      discard: async () => {
        mutations.push('discard');
      },
    };
    let attack = true;
    let dials = 0;
    const genuine = rotatingDial(identity, {
      accepts: () => [device.publicKey],
      respond: async request => ({
        status: 200,
        body: request.path === '/v1/plugins' ? inventoryOf(CORE) : {},
      }),
    });
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: identity.daemonId,
      device: device.claim,
      rotation,
      dial: events => {
        dials++;
        return attack ? forged(code, 'closed')(events) : genuine.dial(events);
      },
    });
    const runtime = new ShellRuntime({
      appVersion: '5.0.0',
      surfaces: CORE,
      daemons,
      shape,
      connect: async () => transport,
    });
    runtime.connection(identity.daemonId);
    try {
      await until(() => stopOf(runtime, identity.daemonId) !== undefined);
      expect(runtime.isRefused(identity.daemonId)).toBe(false);
      if (code === 4426) {
        expect(stopOf(runtime, identity.daemonId)?.kind).toBe('needs-reload');
        expect(snapshot() === before).toBe(true);
      }
      expect(mutations).toEqual([]);
      const failedDials = dials;
      await until(() => dials > failedDials);
      // Retrying under the forged page still cannot change any persisted byte.
      if (code === 4426) expect(snapshot() === before).toBe(true);
      expect(mutations).toEqual([]);
      attack = false;
      await until(() => stopOf(runtime, identity.daemonId) === undefined);
      expect(genuine.credentials.some(credential => credential.accepted)).toBe(true);
      expect(runtime.isRefused(identity.daemonId)).toBe(false);
      expect(device.claim.key).toBeDefined();
      expect(await rotation.pending(identity.daemonId)).toBe(pending);
    } finally {
      const connection = runtime.connection(identity.daemonId);
      if (connection.kind === 'connected') connection.client.stop();
      transport.close();
    }
  });
}
