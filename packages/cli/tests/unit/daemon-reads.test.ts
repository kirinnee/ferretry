import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunRecordDaemonHealth } from '../../src/adapters/daemon/health.ts';
import { BunDaemonProcess } from '../../src/adapters/daemon/process.ts';
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

  test('V-0244 a daemon on another protocol still answers: process control never judges the protocol', async () => {
    const health = new RunRecordDaemonHealth(
      async () => 'http://127.0.0.1:7457',
      async () => json({ status: 'ok', uptimeSeconds: 5, pid: 4321, version: '4.9.0', protocol: 9 }),
    );
    expect(await health.probe()).toEqual({ pid: 4321, version: '4.9.0', protocol: 9 });
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
  test('V-0236 tells absent, empty, claimed and unclaimed homes apart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-marker-'));
    try {
      expect(await homeMarker.inspect(join(root, 'nope'))).toBe('absent');
      await mkdir(join(root, 'plain'));
      expect(await homeMarker.inspect(join(root, 'plain'))).toBe('empty');
      await writeFile(join(root, 'plain', 'logs'), '');
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

describe('which process holds the daemon lock (V-0244, V-0237, V-0236)', () => {
  test('V-0244 a host with neither /proc nor lsof cannot say, and the answer is "unknown", never "yes"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    try {
      const lock = join(root, 'daemon.lock');
      await writeFile(lock, '');
      const process = new BunDaemonProcess({ procDirectory: join(root, 'no-proc'), lsof: join(root, 'no-lsof') });
      expect(await process.holdsOpen(4321, lock)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('V-0244 a pid whose descriptors do not include the lock does not hold it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-proc-'));
    try {
      const lock = join(root, 'daemon.lock');
      await writeFile(lock, '');
      await mkdir(join(root, 'proc', 'self', 'fd'), { recursive: true });
      await mkdir(join(root, 'proc', '4321', 'fd'), { recursive: true });
      await symlink(join(root, 'elsewhere'), join(root, 'proc', '4321', 'fd', '3'));
      const process = new BunDaemonProcess({ procDirectory: join(root, 'proc') });
      expect(await process.holdsOpen(4321, lock)).toBe(false);
      await symlink(lock, join(root, 'proc', '4321', 'fd', '4'));
      expect(await process.holdsOpen(4321, lock)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
