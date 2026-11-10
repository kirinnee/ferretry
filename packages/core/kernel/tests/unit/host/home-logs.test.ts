/**
 * `logs/` at boot. The daemon's log lines are dropped until the folder exists, and nothing used to make it on a home
 * that was already set up, so a home copied or restored without it logged nothing, silently. Boot now makes it (a
 * folder only this user may enter), tightens one that is open to others, and refuses — by name, with a plain sentence
 * — a `logs` that is a file or a link or cannot be made. Real files in a temporary home; no ferret, no network.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instantFromEpochMs } from '@ferretry/std';
import { AdmissionPort } from '../../../contract/bound.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { bootHost, type HostOptions, type RunningHost } from '../../../host/host.ts';
import { openHome } from '../../../host/home.ts';
import { fileLogSink, realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission } from '../host/fixtures.ts';

const roots: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const fs = nodeFs(() => 'r');
const NOW = instantFromEpochMs(Date.UTC(2026, 10, 9));
const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

/** A home a first start has set up, as a copy or a restore may leave it. */
async function setUpHome(): Promise<{ readonly root: string; readonly home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fy-home-logs-'));
  roots.push(root);
  const home = join(root, 'home');
  await openHome(fs, home, 'fyd 5.0.0', NOW);
  return { root, home };
}

/** The daemon booted on `home`, its log written to `logs/fyd.log` exactly as `fyd` does. */
async function boot(home: string) {
  const sink = fileLogSink(line => {
    try {
      appendFileSync(`${home}/logs/fyd.log`, line, { mode: 0o600 });
    } catch {
      // dropped until boot creates logs/, as in fyd.ts
    }
  });
  const adapters: HostOptions['adapters'] = {
    ...realAdapters(home, sink, { binary: 'fy' }),
    clock: fixedClock(),
    homeLock: async () => ({ release: async () => undefined }),
  };
  const gate = definePlugin({
    version: '5.0.0',
    api: 5,
    kinds: [],
    id: 'gate',
    title: 'Gate',
    core: true,
    provides: { admission: AdmissionPort },
  });
  const result = await bootHost({
    home,
    version: '5.0.0',
    implementations: [implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) })],
    adapters,
  });
  if (result.kind === 'running') hosts.push(result.host);
  return result;
}

describe('logs/ when the daemon boots', () => {
  test('is made, 0700, on a first start, and the boot is logged in it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-home-logs-'));
    roots.push(root);
    const home = join(root, 'home');

    const result = await boot(home);

    expect(result.kind).toBe('running');
    expect(await modeOf(join(home, 'logs'))).toBe(0o700);
    expect((await readFile(join(home, 'logs', 'fyd.log'), 'utf8')).length).toBeGreaterThan(0);
  });

  test('is made on a home that already exists without it, and the boot says so in the log it just made', async () => {
    const { home } = await setUpHome();
    await rm(join(home, 'logs'), { recursive: true });

    const result = await boot(home);

    expect(result.kind).toBe('running');
    expect(await modeOf(join(home, 'logs'))).toBe(0o700);
    expect(await readFile(join(home, 'logs', 'fyd.log'), 'utf8')).toContain('logs/ did not exist and was made (0700)');
  });

  test('is refused, with a sentence naming it, when it is a regular file', async () => {
    const { home } = await setUpHome();
    await rm(join(home, 'logs'), { recursive: true });
    await writeFile(join(home, 'logs'), 'not a folder');

    const result = await boot(home);

    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.sentence).toContain(join(home, 'logs'));
    expect(result.sentence).toContain('is a file, not a folder');
    expect(result.sentence).toContain('did not start');
    expect(await readFile(join(home, 'logs'), 'utf8')).toBe('not a folder');
  });

  test('is refused when it is a link, and what the link points at is never touched', async () => {
    const { root, home } = await setUpHome();
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o755 });
    await chmod(elsewhere, 0o755);
    await rm(join(home, 'logs'), { recursive: true });
    await symlink(elsewhere, join(home, 'logs'));

    const outcome = await openHome(fs, home, 'fyd 5.0.0', NOW);

    expect(outcome.kind).toBe('logs-refused');
    if (outcome.kind !== 'logs-refused') return;
    expect(outcome.sentence).toContain('is a link, not a folder');
    expect(await modeOf(elsewhere)).toBe(0o755);
  });

  test('is tightened to 0700 and reported when it is open to other users', async () => {
    const { home } = await setUpHome();
    await chmod(join(home, 'logs'), 0o755);

    const result = await boot(home);

    expect(result.kind).toBe('running');
    expect(await modeOf(join(home, 'logs'))).toBe(0o700);
    expect(await readFile(join(home, 'logs', 'fyd.log'), 'utf8')).toContain(
      'logs/ was open to other users and is now 0700',
    );
  });

  test('is refused, saying so, when this user has no search bit in it (the log could not be written)', async () => {
    const { home } = await setUpHome();
    await chmod(join(home, 'logs'), 0o600);

    const outcome = await openHome(fs, home, 'fyd 5.0.0', NOW);

    expect(outcome.kind).toBe('logs-refused');
    if (outcome.kind !== 'logs-refused') return;
    expect(outcome.sentence).toContain('is a folder this user cannot write in');
    expect(outcome.sentence).toContain(join(home, 'logs'));
    expect(await modeOf(join(home, 'logs'))).toBe(0o600);
  });

  test.skipIf(process.getuid?.() === 0)(
    'is refused when it is read-only (0500), not accepted and logged nothing',
    async () => {
      const { home } = await setUpHome();
      await chmod(join(home, 'logs'), 0o500);

      const outcome = await openHome(fs, home, 'fyd 5.0.0', NOW);

      expect(outcome.kind).toBe('logs-refused');
      if (outcome.kind !== 'logs-refused') return;
      expect(outcome.sentence).toContain('is a folder this user cannot write in');
      await chmod(join(home, 'logs'), 0o700);
    },
  );

  test('is refused when the folder is mode 0700 but not writable by this user (another user’s)', async () => {
    const { home } = await setUpHome();
    // The one place the kernel asks: a folder of another user answers not-writable although its mode bits look right.
    const foreign: typeof fs = { ...fs, writable: async path => !path.endsWith('/logs') && (await fs.writable(path)) };

    const outcome = await openHome(foreign, home, 'fyd 5.0.0', NOW);

    expect(outcome.kind).toBe('logs-refused');
    if (outcome.kind !== 'logs-refused') return;
    expect(outcome.sentence).toContain('is a folder this user cannot write in');
  });

  test('is tightened through the opened folder, so a swap for a link after the look is refused and its target never chmodded', async () => {
    const { root, home } = await setUpHome();
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o755 });
    await chmod(elsewhere, 0o755);
    await rm(join(home, 'logs'), { recursive: true });
    await symlink(elsewhere, join(home, 'logs'));
    // The look found an open folder (as before the swap); by the time the mode is set, a link is there.
    const swapped: typeof fs = {
      ...fs,
      lstat: async path => {
        const info = await fs.lstat(path);
        return path.endsWith('/logs') && info !== undefined ? { ...info, kind: 'directory', mode: 0o755 } : info;
      },
    };

    const outcome = await openHome(swapped, home, 'fyd 5.0.0', NOW);

    expect(outcome.kind).toBe('logs-refused');
    expect(await modeOf(elsewhere)).toBe(0o755);
  });

  test('config/ and state/ are made by the first write when a copied home lacks them (run/ is the home lock’s)', async () => {
    const { home } = await setUpHome();
    for (const folder of ['config', 'state']) await rm(join(home, folder), { recursive: true });

    const result = await boot(home);

    expect(result.kind).toBe('running');
    for (const folder of ['config', 'state', 'state/kernel', 'logs'])
      expect((await stat(join(home, folder))).isDirectory()).toBe(true);
  });

  test('is refused, saying why, when the folder cannot be made', async () => {
    const { home } = await setUpHome();
    await rm(join(home, 'logs'), { recursive: true });
    // The one place the kernel looks is where a refusing file system answers: a make that throws is a sentence too.
    const refusing: typeof fs = {
      ...fs,
      mkdirp: async path => {
        if (path.endsWith('/logs')) throw new Error('EACCES: permission denied');
        await fs.mkdirp(path);
      },
    };

    const outcome = await openHome(refusing, home, 'fyd 5.0.0', NOW);

    expect(outcome.kind).toBe('logs-refused');
    if (outcome.kind !== 'logs-refused') return;
    expect(outcome.sentence).toContain('could not be made (EACCES: permission denied)');
    expect(outcome.sentence).toContain(join(home, 'logs'));
  });
});
