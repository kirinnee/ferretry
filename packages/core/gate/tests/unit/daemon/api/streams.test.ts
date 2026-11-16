import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon, socket } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import {
  cap,
  DEFAULT_CAPABILITY_GRANTS,
  DEFAULT_GATE_CONFIG,
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
} from '../../../../contract/index.ts';
import { holder } from '../../../../contract/testing/index.ts';
import { world } from '../support.ts';

/** G149: a grant change re-asks every open stream at once, as today's `recheckAll` did. */

const manifest = definePlugin({
  id: 'terminals',
  title: 'Terminals',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  actions: {
    sockets: [
      socket('GET /v1/terminals/:key/stream', {
        minimum: 'operator',
        caller: 'any',
        capability: cap('terminal', 'use'),
        audit: { skip: 'test' },
        guard: { none: 'test' },
      }),
    ],
  },
});

const half = implementDaemon(manifest, {
  build: () => ({
    sockets: {
      'GET /v1/terminals/:key/stream': async () => async () => ({
        open: async () => undefined,
        fromClient: () => undefined,
        close: () => undefined,
      }),
    },
  }),
});

const narrowed = {
  ...DEFAULT_GATE_CONFIG,
  grants: { ...DEFAULT_CAPABILITY_GRANTS, terminal: { use: false, configure: false } },
};

describe('a grant change re-asks the open streams', () => {
  test('G149 narrowing a grant while a stream is open closes it at once, without waiting for its next frame', async () => {
    const w = world();
    w.enrol('d1');
    const host = await testHost({ plugins: [half], gate: w.gate });
    const open = await host.socket('/v1/terminals/x/stream', { as: { kind: 'device', holder: 'd1' } });
    expect(open.response).toBeUndefined();
    expect(open.closed).toBeUndefined();

    w.policy = narrowed;
    w.gate.policyChanged();

    expect(open.closed?.code).toBe(4401);
    await host.stop();
  });

  test('G149 a change that leaves the grant in place keeps the stream open', async () => {
    const w = world();
    w.enrol('d1');
    const host = await testHost({ plugins: [half], gate: w.gate });
    const open = await host.socket('/v1/terminals/x/stream', { as: { kind: 'device', holder: 'd1' } });
    w.gate.policyChanged();
    expect(open.closed).toBeUndefined();
    await host.stop();
  });

  test('G149 a device’s narrowed grant closes its open stream at once, without a gate.yaml change', async () => {
    const w = world();
    w.enrol('d1', FULL_DEVICE_GRANTS);
    w.enrol('d2', FULL_DEVICE_GRANTS);
    const host = await testHost({ plugins: [half], gate: w.gate });
    const narrowedDevice = await host.socket('/v1/terminals/x/stream', { as: { kind: 'device', holder: 'd1' } });
    const other = await host.socket('/v1/terminals/y/stream', { as: { kind: 'device', holder: 'd2' } });
    expect(narrowedDevice.closed).toBeUndefined();

    // Access narrows the device through its provider: nobody calls the gate's policyChanged by hand.
    w.devices.narrow(holder('d1'), LIMITED_DEVICE_GRANTS);

    expect(narrowedDevice.closed?.code).toBe(4401);
    expect(other.closed).toBeUndefined();
    await host.stop();
  });

  test('G149 a revoked device’s open stream closes at once', async () => {
    const w = world();
    w.enrol('d1');
    const host = await testHost({ plugins: [half], gate: w.gate });
    const open = await host.socket('/v1/terminals/x/stream', { as: { kind: 'device', holder: 'd1' } });
    w.devices.revoke(holder('d1'));
    expect(open.closed?.code).toBe(4401);
    await host.stop();
  });

  test('G149 once the host stops, a later change reaches nobody', async () => {
    const w = world();
    w.enrol('d1');
    const host = await testHost({ plugins: [half], gate: w.gate });
    const open = await host.socket('/v1/terminals/x/stream', { as: { kind: 'device', holder: 'd1' } });
    await host.stop();
    w.policy = narrowed;
    w.gate.policyChanged();
    expect(open.closed).toBeUndefined();
  });
});
