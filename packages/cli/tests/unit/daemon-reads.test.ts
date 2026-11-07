import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRecordDaemonHealth } from '../../src/adapters/daemon/health.ts';
import { homeMarker } from '../../src/adapters/daemon/state-home-marker.ts';
import { ClientResetInventory, RESET_ROUTES } from '../../src/lib/daemon/reset-inventory.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the daemon health the lifecycle verbs read', () => {
  test('V-0244 reads the pid from /healthz at the address the run record names', async () => {
    const asked: string[] = [];
    const health = new RunRecordDaemonHealth(
      async () => 'http://127.0.0.1:7457',
      async url => {
        asked.push(url);
        return json({ status: 'ok', uptimeSeconds: 5, pid: 4321, version: '5.0.0', protocol: 1 });
      },
    );
    expect(await health.probe()).toMatchObject({ pid: 4321, version: '5.0.0' });
    expect(asked).toEqual(['http://127.0.0.1:7457/healthz']);
  });

  test('V-0244 a booting daemon (503), a stranger and a refusal are all "did not answer"', async () => {
    const answer = (fetcher: () => Promise<Response>) =>
      new RunRecordDaemonHealth(async () => 'http://x', fetcher).probe();
    expect(await answer(async () => json({ status: 'starting' }, 503))).toBeUndefined();
    expect(await answer(async () => json({ hello: 'world' }))).toBeUndefined();
    expect(await answer(async () => Promise.reject(new Error('ECONNREFUSED')))).toBeUndefined();
  });
});

describe('what a reset counts', () => {
  const client = (answers: Record<string, unknown>) => ({
    call: async <Answer = unknown>(route: string): Promise<Answer> => {
      if (!(route in answers)) throw new Error(`no ${route}`);
      return answers[route] as Answer;
    },
  });

  test('V-0236 counts secrets, devices and ferrets by length alone, through the routes their owners declare', async () => {
    const all = client({
      [RESET_ROUTES.secrets]: { secrets: [{}, {}] },
      [RESET_ROUTES.devices]: { devices: [{}], hostLocal: true },
      [RESET_ROUTES.ferrets]: [{}, {}, {}],
    });
    expect(await new ClientResetInventory(all, all, all).count()).toEqual({ secrets: 2, devices: 1, ferrets: 3 });
  });

  test('V-0236 any failure is "unavailable", never an error: a reset must not depend on what it recovers from', async () => {
    const none = client({});
    expect(await new ClientResetInventory(none, none, none).count()).toBeUndefined();
  });
});

describe('the state home marker a reset requires', () => {
  test('V-0236 tells absent, claimed and unclaimed homes apart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-marker-'));
    try {
      expect(await homeMarker.inspect(join(root, 'nope'))).toBe('absent');
      await mkdir(join(root, 'plain'));
      expect(await homeMarker.inspect(join(root, 'plain'))).toBe('unclaimed');
      await mkdir(join(root, 'ours'));
      await writeFile(
        join(root, 'ours', 'home.json'),
        JSON.stringify({ format: 1, createdBy: 'fyd 5.0.0', createdAt: '2026-11-07T00:00:00.000Z' }),
      );
      expect(await homeMarker.inspect(join(root, 'ours'))).toBe('claimed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
