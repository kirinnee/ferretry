/**
 * The guarantee rows for the keys THIS device holds for direct clean-up (S170–S173). The daemon-side rows (S162–S169) are
 * in `tests/unit/daemon/`; these are the browser's half: no getter, sealed at rest, the CSP agreeing with the provider
 * table, and one shared clean-up path.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLEANUP_PROVIDERS } from '../../../../contract/index.ts';
import { DeviceSpeedupKeys, type SpeedupKeyRecords } from '../../../../app/lib/stt/speedup-keys.ts';
import { requestDeviceCleanup } from '../../../../app/lib/stt/device-cleanup.ts';
import { DEFAULT_VOICE_CLEANUP } from '../../../../app/lib/stt/voice-cleanup.ts';

const GROQ_KEY = 'gsk_test_0123456789abcdefAB';
const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..');

class MemoryRecords implements SpeedupKeyRecords {
  readonly values = new Map<string, unknown>();
  async get(slot: string): Promise<unknown> {
    return this.values.get(slot);
  }
  async put(slot: string, value: unknown): Promise<void> {
    this.values.set(slot, value);
  }
  async delete(slot: string): Promise<void> {
    this.values.delete(slot);
  }
}

const vault = () => {
  const records = new MemoryRecords();
  const sent: { readonly url: string; readonly init: RequestInit }[] = [];
  const keys = new DeviceSpeedupKeys(records, crypto.subtle, async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    return Response.json({ choices: [{ message: { content: 'hello world' } }] });
  });
  return { records, sent, keys };
};

const logged: string[] = [];
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  logged.length = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    spies.push(spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.join(' '))));
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe('device-held speed-up keys', () => {
  test('S170 the device key store has no getter: it shows only "ends with", decrypts only in send, goes only to the provider-table URL with no cookie, referrer or cache, and logs nothing', async () => {
    const { keys, sent } = vault();
    await keys.save('groq', GROQ_KEY);

    // No method hands the value back: the whole surface is status / save / remove / send.
    const surface = Object.getOwnPropertyNames(DeviceSpeedupKeys.prototype).filter(name => name !== 'constructor');
    expect(surface.sort()).toEqual(['remove', 'save', 'send', 'status']);
    const status = await keys.status('groq');
    expect(status).toEqual({ kind: 'saved', endsWith: 'AB' });
    expect(JSON.stringify(status)).not.toContain(GROQ_KEY);

    const answer = await keys.send('groq', { endpoint: 'chat', body: '{}' });
    expect(answer.kind).toBe('response');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(CLEANUP_PROVIDERS.groq.endpoint);
    expect(sent[0]?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(logged.join('\n')).not.toContain(GROQ_KEY);
  });

  test('S171 the device key is AES-GCM under a non-extractable wrapping CryptoKey kept in IndexedDB, with the provider id bound as additional data', async () => {
    const { records, keys } = vault();
    await keys.save('groq', GROQ_KEY);

    const wrapping = records.values.get('wrapping-key') as CryptoKey;
    expect(wrapping.extractable).toBe(false);
    expect(wrapping.algorithm.name).toBe('AES-GCM');
    await expect(crypto.subtle.exportKey('raw', wrapping)).rejects.toBeDefined();
    const sealed = records.values.get('provider:groq') as { data: ArrayBuffer };
    expect(new TextDecoder().decode(sealed.data)).not.toContain(GROQ_KEY);

    // The provider id is the additional data: a record copied into another provider's slot does not open.
    records.values.set('provider:cerebras', sealed);
    expect((await keys.send('cerebras', { endpoint: 'models' })).kind).toBe('unreadable');
    expect((await keys.send('groq', { endpoint: 'models' })).kind).toBe('response');
  });

  test('S172 connect-src lists exactly the two provider hosts, and agrees with the provider table', () => {
    const headers = readFileSync(join(REPO_ROOT, 'packages/app/public/_headers'), 'utf8');
    const connect = /connect-src ([^;]*);/u.exec(headers)?.[1] ?? '';
    const named = connect.split(/\s+/u).filter(source => /^https:\/\/[a-z]/u.test(source) && !source.endsWith(':'));
    const table = Object.values(CLEANUP_PROVIDERS)
      .map(provider => `https://${provider.host}`)
      .sort();
    expect(named.sort()).toEqual(table);
    expect(table).toHaveLength(2);
  });

  test('S173 both paths run the same shared clean-up code; with no key anywhere, the raw words are kept', async () => {
    // The browser and the daemon import the one implementation from the contract.
    const device = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'app/lib/stt/device-cleanup.ts'), 'utf8');
    const daemon = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'daemon/lib/stt/enhancement.ts'), 'utf8');
    for (const source of [device, daemon]) {
      expect(source).toMatch(/prepareCleanup/u);
      expect(source).toMatch(/readCleanupReply/u);
      expect(source).toMatch(/contract\/(index\.ts|cleanup\/)/u);
    }

    // With no key on this device the device path answers nothing, so the caller asks the daemon; and a daemon with no key
    // either keeps the words (tests/unit/daemon). Nothing is invented.
    const { keys, sent } = vault();
    const answer = await requestDeviceCleanup(keys, {
      provider: 'groq',
      model: CLEANUP_PROVIDERS.groq.defaultModel,
      text: 'raw words stay',
      dictionary: [],
      context: [],
      userContext: '',
      cleanup: DEFAULT_VOICE_CLEANUP,
    } as never);
    expect(answer).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
