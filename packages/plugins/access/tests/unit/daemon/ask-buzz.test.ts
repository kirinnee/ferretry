/**
 * The ask buzz is Access's (docs/notifications.md): the phone hears an ask that buzzes by itself — a card's ask, a notice
 * that asked for it (`fy notify --buzz`) — once, with the Agenda plugin OFF (it is not in this host at all). Asks is the
 * kernel's fake, `pushes` counts what the push service received (no network), and a "restart" is a new host on the same
 * ledger. Agenda sends no ask buzz (its own test), so with it on the phone still hears one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { AsksChanged } from '@ferretry/core-asks/contract';
import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { AskBuzzesFile, DevicesFile, PushFile } from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const DEVICE = `fy_device_id_${'p'.repeat(22)}`;
const AT = '2026-11-10T09:00:00.000Z';

/** Access alone on the kernel's test host (no Agenda), one paired device with ONE push enrolment, and a counting push service. */
async function world(ledger?: string) {
  const asks = new FakeAsks();
  const pushes: string[] = [];
  const host = await testHost({
    plugins: [daemon],
    fakes: { gate: new FakeGate(), asks },
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
  if (ledger !== undefined) host.state('access').plant(AskBuzzesFile, ledger);
  return { host, asks, pushes };
}

const raise = async (
  asks: FakeAsks,
  entry: string,
  options: { source?: string; kind?: 'task' | 'notice'; blocking?: boolean } = {},
) =>
  await asks.raise({
    source: sourceKey(options.source ?? 'ferret'),
    ref: {},
    entry: entryId(entry),
    kind: options.kind ?? 'task',
    subject: `Do ${entry}`,
    why: 'because',
    raisedBy: { kind: 'ferret', ferret: 'f1' },
    ferret: 'f1',
    ...(options.blocking === true ? { blocking: true } : {}),
  });

const announce = async (host: TestHost, askId: string, times = 1) => {
  for (let i = 0; i < times; i += 1) host.emit(AsksChanged, { ferret: 'f1', askId: askId as never, state: 'open' });
  await host.settle();
};

describe('the ask buzz, with the Agenda plugin off', () => {
  test("a card's ask buzzes the owner's phone exactly once, however often it is announced", async () => {
    const { host, asks, pushes } = await world();
    const ref = await raise(asks, 'e1', { source: 'card' });
    await announce(host, ref.id, 3);
    expect(pushes).toHaveLength(1);
    expect(host.state('access').files.get('ask-buzzes.jsonl')).toContain('ask:f1:A1');
  });

  test('a notice that asked for the phone buzzes once; a quiet notice and an ordinary ask do not', async () => {
    const { host, asks, pushes } = await world();
    const loud = await raise(asks, 'e1', { kind: 'notice', blocking: true });
    const quiet = await raise(asks, 'e2', { kind: 'notice' });
    const plain = await raise(asks, 'e3');
    await announce(host, quiet.id);
    await announce(host, plain.id);
    expect(pushes).toHaveLength(0);
    await announce(host, loud.id, 2);
    expect(pushes).toHaveLength(1);
  });

  test('a closed ask never buzzes', async () => {
    const { host, asks, pushes } = await world();
    const ref = await raise(asks, 'e1', { source: 'card' });
    host.emit(AsksChanged, { ferret: 'f1', askId: ref.id as never, state: 'closed' });
    await host.settle();
    expect(pushes).toHaveLength(0);
  });

  test('an ask that is gone by the time it is read buzzes nothing, and says nothing', async () => {
    const { host, pushes } = await world();
    host.emit(AsksChanged, { ferret: 'f1', askId: 'A99' as never, state: 'open' });
    await host.settle();
    expect(pushes).toHaveLength(0);
  });

  test('an ask that already buzzed before a restart does not buzz again: the ledger remembers', async () => {
    const line = JSON.stringify({ format: 1, key: 'ask:f1:A1', at: AT, kind: 'card-ask' });
    const { host, asks, pushes } = await world(`${line}\n`);
    const ref = await raise(asks, 'e1', { source: 'card' });
    await announce(host, ref.id);
    expect(pushes).toHaveLength(0);
  });
});
