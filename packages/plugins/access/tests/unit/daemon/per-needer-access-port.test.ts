/**
 * Access's `provides.access` on the kernel's test host: each plugin is handed its OWN port, with `clear` narrowed to the
 * lines of its own namespace (docs/notifications.md). The pure narrowing is tested in `push/reach.test.ts`; this tests
 * the WIRING, which that cannot: if the daemon half handed every plugin `access.port` unchanged, only a test through
 * the host would fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { AccessPort, type AccessApi, DevicesFile, PushFile } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const tenant = (id: string, seen: Record<string, AccessApi>) =>
  implementDaemon(
    definePlugin({ id, title: id, version: '1.0.0', api: 5, core: false, kinds: [], needs: { access: AccessPort } }),
    {
      build: ({ needs }) => {
        seen[id] = needs.access;
        return {};
      },
    },
  );

const DEVICE = `fy_device_id_${'p'.repeat(22)}`;
const AT = '2026-11-10T09:00:00.000Z';

/** The host with Access, three tenants, one paired device and ONE real push enrolment; `pushes` counts what the "push service" received. */
async function world() {
  const seen: Record<string, AccessApi> = {};
  const pushes: string[] = [];
  const host = await testHost({
    plugins: [daemon, tenant('accounts', seen), tenant('agenda', seen), tenant('stranger', seen)],
    fakes: { gate: new FakeGate() },
    fetch: url => {
      pushes.push(url.href);
      return new Response(null, { status: 201 });
    },
  });
  hosts.push(host);
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', signing.publicKey)).toString('base64url');
  host.state('access').plant(
    DevicesFile,
    JSON.stringify({
      format: 1,
      daemonId: host.identity.daemonId,
      devices: [
        {
          id: DEVICE,
          daemonId: host.identity.daemonId,
          name: 'Phone',
          platform: 'browser',
          createdAt: AT,
          lastSeenAt: AT,
          publicKey: spki,
          grants: FULL_DEVICE_GRANTS,
        },
      ],
    }),
  );
  host.state('access').plant(
    PushFile,
    JSON.stringify({
      format: 1,
      subscriptions: [
        {
          id: 'push-aaaaaaaa-1111-4111-8111-111111111111',
          deviceId: DEVICE,
          deviceName: 'Phone',
          subscription: {
            endpoint: 'https://fcm.googleapis.com/send/abc',
            expirationTime: null,
            keys: {
              p256dh: Buffer.from(point).toString('base64url'),
              auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
            },
          },
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    }),
  );
  return { host, seen, pushes };
}

describe('the access port each plugin is handed (followups row 110)', () => {
  test('row 110: a plugin outside the clear table is handed no clear at all', async () => {
    const { seen } = await world();

    expect(seen.stranger?.clear).toBeUndefined();
    expect(seen.stranger?.buzz).toBeFunction();
  });

  test("row 110: Accounts' handle cannot clear Agenda's line (agenda-A3), and Agenda's cannot clear Accounts'", async () => {
    const { seen, pushes } = await world();

    // Nothing is sent for a line outside the plugin's own namespace: no push reaches the enrolled device.
    expect(await seen.accounts?.clear?.(['agenda-A3'])).toBe(0);
    expect(await seen.agenda?.clear?.(['pa-pa_0123456789abcdef01234567'])).toBe(0);
    expect(pushes).toEqual([]);
  });

  test('row 110: each plugin can still clear its own line, which reaches the enrolled device', async () => {
    const { seen, pushes } = await world();

    expect(await seen.accounts?.clear?.(['pa-pa_0123456789abcdef01234567'])).toBe(1);
    expect(await seen.agenda?.clear?.(['agenda-A3'])).toBe(1);
    expect(pushes).toHaveLength(2);
  });
});
