import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FULL_DEVICE_GRANTS } from '../../../core/gate/contract/policy.ts';
import { bootRealDaemon, type RealDaemon } from './support/real-daemon.ts';

/**
 * WHO BUZZES THE PHONE FOR AN ASK, end to end and offline (O8-14 P1): the real `fy` process, a real `fyd` (every real
 * plugin, the real Asks engine and Access) on a temp FY_HOME, ONE test enrolment (a paired device with one push
 * subscription, planted as state), and the push captured at the process boundary (`push-capture-preload.ts`: a request to a
 * push service host is answered and counted, nothing leaves the machine).
 *
 * The same journeys run with Agenda OFF (`work` absent, the default) and ON (`work: on`), and must buzz the same: a `--buzz` notice exactly
 * once, a quiet notice and an ordinary `fy agenda add` not at all. A card's own ask buzzes through the same subscriber (the
 * host-level `ask-buzz.test.ts` in Access); a card's ask cannot be raised by a verb, so it is not repeated here.
 */

setDefaultTimeout(180_000);

const PRELOAD = join(import.meta.dir, 'support/push-capture-preload.ts');
const AT = '2026-11-10T09:00:00.000Z';
const DEVICE = `fy_device_id_${'p'.repeat(22)}`;

/** One enrolled phone, planted as state for a daemon whose identity is planted too (a device grant belongs to ONE daemon id). */
async function enrolment(): Promise<Record<string, string>> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const daemonId = `fy_daemon_${createHash('sha256').update(spki).digest('base64url')}`;
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const device = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  return {
    'state/kernel/identity.json': `${JSON.stringify({
      schemaVersion: 1,
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    })}\n`,
    'state/access/devices.json': JSON.stringify({
      format: 1,
      daemonId,
      devices: [
        {
          id: DEVICE,
          daemonId,
          name: 'Phone',
          platform: 'browser',
          createdAt: AT,
          lastSeenAt: AT,
          publicKey: Buffer.from(device).toString('base64url'),
          grants: FULL_DEVICE_GRANTS,
        },
      ],
    }),
    'state/access/push.json': JSON.stringify({
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
  };
}

const pushes = async (daemon: RealDaemon): Promise<number> => {
  const text = await readFile(join(daemon.home, 'pushes.log'), 'utf8').catch(() => '');
  return text.split('\n').filter(line => line !== '').length;
};

const disposers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const dispose of disposers) await dispose();
});

describe.each([
  ['Agenda OFF (the default: work is off)', false],
  ['Agenda ON (work: on)', true],
] as const)('the phone buzz with %s', (_name, workOn) => {
  const booted = (async () => {
    const daemon = await bootRealDaemon([{ id: 'f1', mode: 'auto' }], await enrolment(), { preload: PRELOAD, workOn });
    disposers.push(daemon.dispose);
    return daemon;
  })();

  it('buzzes exactly once for `fy notify --buzz`, however often it is read', async () => {
    const daemon = await booted;
    const before = await pushes(daemon);
    const ran = await daemon.fy('f1', ['notify', 'Relay is down', '--buzz', '--ferret', 'f1']);
    expect(ran.code).toBe(0);
    await Bun.sleep(1_500);
    expect(await pushes(daemon)).toBe(before + 1);
    const again = await daemon.fy('f1', ['agenda', 'ls', '--ferret', 'f1']);
    expect(again.code).toBe(0);
    await Bun.sleep(500);
    expect(await pushes(daemon)).toBe(before + 1);
    expect(await readFile(join(daemon.home, 'state/access/ask-buzzes.jsonl'), 'utf8')).toContain('"kind":"notice"');
  });

  it('buzzes nothing for a quiet notice, and nothing for an ordinary `fy agenda add`', async () => {
    const daemon = await booted;
    const before = await pushes(daemon);
    expect((await daemon.fy('f1', ['notify', 'FYI only', '--ferret', 'f1'])).code).toBe(0);
    const added = await daemon.fy('f1', [
      'agenda',
      'add',
      'Pick eu-west?',
      '--title',
      'Region',
      '--premise',
      'A relay ships Friday',
      '--context',
      'Two regions are near',
      '--new',
      'An independent decision',
      '--json',
    ]);
    expect(added.err).toBe('');
    expect(added.code).toBe(0);
    await Bun.sleep(1_500);
    expect(await pushes(daemon)).toBe(before);
  });
});
