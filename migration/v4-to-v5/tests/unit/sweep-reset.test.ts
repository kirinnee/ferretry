import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ResetRefusal,
  backupDirOf,
  backupName,
  homeFiles,
  resetStamp,
  resetV5,
  restoreV5,
  tarEntryProblem,
  type ResetActions,
  type ResetPaths,
  type TarPorts,
} from '../../fixtures/sweep/reset.ts';
import {
  FAKE_NAME,
  isShim,
  readRecord,
  recordText,
  shimText,
  storePathOf,
  type RealPaths,
} from '../../fixtures/sweep/real-claude.ts';

const NOW = new Date('2026-11-18T19:17:05.123Z');

/** The real `tar`, on scratch folders only. */
const tar: TarPorts = {
  create: async (dir, file, members) => {
    const ran = Bun.spawnSync(['tar', '-C', dir, '--warning=no-file-ignored', '-cf', file, ...members]);
    return { code: ran.exitCode, err: ran.stderr.toString() };
  },
  list: async file => {
    const ran = Bun.spawnSync(['tar', '-tf', file]);
    return {
      code: ran.exitCode,
      entries: ran.stdout
        .toString()
        .split('\n')
        .filter(line => line !== ''),
      err: ran.stderr.toString(),
    };
  },
  extract: async (dir, file) => {
    const ran = Bun.spawnSync(['tar', '-C', dir, '-xpf', file]);
    return { code: ran.exitCode, err: ran.stderr.toString() };
  },
};

interface Scratch {
  readonly root: string;
  readonly paths: ResetPaths;
  readonly real: RealPaths;
  readonly v4Marker: string;
}

/** A persisted slot's folder as the kit leaves it: a v4 side, and a RICH 5.0 side (ferrets, logins, devices, a pairing record). */
async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), 'kit-empty-'));
  const v4Marker = join(root, 'v4', 'home', 'marker.txt');
  await mkdir(join(root, 'v4', 'home'), { recursive: true });
  await writeFile(v4Marker, 'v4 data\n');
  const v5Dir = join(root, 'v5');
  const home = join(v5Dir, 'home');
  const harness = join(v5Dir, 'harness-bin');
  await mkdir(join(home, 'config', 'logins'), { recursive: true });
  await mkdir(join(home, 'state', 'kernel', 'accepted-config'), { recursive: true });
  await mkdir(join(home, 'state', 'access'), { recursive: true });
  await mkdir(join(home, 'state', 'logins', 'credentials', 'codex-main'), { recursive: true });
  await mkdir(join(home, 'state', 'terminals'), { recursive: true });
  await mkdir(join(v5Dir, 'user', '.config'), { recursive: true });
  await mkdir(harness, { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    '{"carriers":[{"kind":"bind","host":"127.0.0.1","port":7619}],"extra":"OLD"}\n',
  );
  await writeFile(join(home, 'config', 'logins', 'codex-main.yaml'), 'harness: codex\n');
  await writeFile(join(home, 'state', 'access', 'devices.json'), '{"devices":["phone"]}\n');
  await writeFile(join(home, 'state', 'logins', 'credentials', 'codex-main', 'auth.json'), '{"fake":true}\n');
  await writeFile(join(home, 'state', 'conversation-fixture.json'), '{"ferrets":["alpha","beta"]}\n');
  await writeFile(join(v5Dir, 'user', '.config', 'leftover'), 'x\n');
  await writeFile(join(harness, 'claude'), '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
  const paths: ResetPaths = { real: root, v5Dir, home, user: join(v5Dir, 'user'), harness, port: 7619 };
  return { root, paths, real: { v5Dir, fyHome: home, harness }, v4Marker };
}

interface Trace {
  readonly steps: string[];
  readonly actions: ResetActions;
}

function actionsFor(paths: ResetPaths, extra: { startCheck?: () => Promise<void> } = {}): Trace {
  const steps: string[] = [];
  return {
    steps,
    actions: {
      stop: async () =>
        void steps.push(
          `stop (old home present: ${String((await lstat(paths.home).catch(() => undefined)) !== undefined)})`,
        ),
      installBuild: async () => void steps.push('installBuild'),
      start: async () => {
        steps.push('start');
        await extra.startCheck?.();
      },
      say: () => undefined,
    },
  };
}

const listing = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      out.push(path.slice(root.length));
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return out.sort();
};

const mode = async (path: string): Promise<string> => ((await lstat(path)).mode & 0o777).toString(8);

describe('reset-v5: an empty home on a persisted slot', () => {
  test('the new home is an EMPTY folder: no config, no limits file, no gate, no name, no identity, no ferret, login or device', async () => {
    const { root, paths, real } = await scratch();
    try {
      const { actions } = actionsFor(paths);
      await resetV5(paths, real, tar, actions, { keepRealClaude: false, now: NOW });
      expect(await homeFiles(paths.home)).toEqual([]);
      for (const gone of ['logins', 'runtimes', 'profiles', 'projects'])
        expect(await lstat(join(paths.home, 'config', gone)).catch(() => undefined)).toBeUndefined();
      expect(await lstat(join(paths.home, 'state', 'access')).catch(() => undefined)).toBeUndefined();
      expect(await lstat(join(paths.home, 'state', 'kernel', 'identity.json')).catch(() => undefined)).toBeUndefined();
      expect(await readdir(paths.user)).toEqual([]);
      expect(await mode(paths.home)).toBe('700');
      expect(await readdir(paths.home)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the old home is a tar: mode 0600 in a 0700 folder, UTC-stamped, holding the old data; stop comes first, start last', async () => {
    const { root, paths, real } = await scratch();
    try {
      const trace = actionsFor(paths);
      const { tar: file } = await resetV5(paths, real, tar, trace.actions, { keepRealClaude: false, now: NOW });
      expect(trace.steps).toEqual(['stop (old home present: true)', 'installBuild', 'start']);
      expect(file).toBe(join(backupDirOf(root), 'v5-reset-20261118T191705Z.tar'));
      expect(resetStamp(NOW)).toBe('20261118T191705Z');
      expect(backupName('S', 'restore')).toBe('v5-restore-S.tar');
      expect(await mode(file)).toBe('600');
      expect(await mode(backupDirOf(root))).toBe('700');
      const entries = (await tar.list(file)).entries;
      expect(entries).toContain('home/state/conversation-fixture.json');
      expect(entries).toContain('home/state/access/devices.json');
      expect(entries).toContain('user/.config/leftover');
      expect(entries.every(entry => tarEntryProblem(entry) === undefined)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the v4 side and the persisted files (units, wrappers, cli names, programs, harness) are untouched', async () => {
    const { root, paths, real, v4Marker } = await scratch();
    try {
      await mkdir(join(root, 'bin'), { recursive: true });
      await writeFile(join(root, 'bin', 'fy5s9'), 'wrapper\n');
      await writeFile(join(root, 'cli-names.json'), '{"v5":"fy5"}\n');
      await mkdir(join(paths.v5Dir, 'bin'), { recursive: true });
      await writeFile(join(paths.v5Dir, 'bin', 'fyd'), 'program\n');
      const beforeV4 = await listing(join(root, 'v4'));
      const kept = ['bin', 'cli-names.json', join('v5', 'bin'), join('v5', 'harness-bin')];
      const before = await Promise.all(
        kept.map(
          async name => await listing(join(root, name)).catch(async () => [await readFile(join(root, name), 'utf8')]),
        ),
      );
      await resetV5(paths, real, tar, actionsFor(paths).actions, { keepRealClaude: false, now: NOW });
      expect(await listing(join(root, 'v4'))).toEqual(beforeV4);
      expect(await readFile(v4Marker, 'utf8')).toBe('v4 data\n');
      const after = await Promise.all(
        kept.map(
          async name => await listing(join(root, name)).catch(async () => [await readFile(join(root, name), 'utf8')]),
        ),
      );
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a missing home is refused before anything is stopped', async () => {
    const { root, paths, real } = await scratch();
    try {
      await rm(paths.home, { recursive: true });
      const trace = actionsFor(paths);
      await expect(resetV5(paths, real, tar, trace.actions, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /no 5.0 home to reset/u,
      );
      expect(trace.steps).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a tar that cannot be written removes nothing', async () => {
    const { root, paths, real } = await scratch();
    try {
      const broken: TarPorts = { ...tar, create: async () => ({ code: 2, err: 'disk full' }) };
      await expect(
        resetV5(paths, real, broken, actionsFor(paths).actions, { keepRealClaude: false, now: NOW }),
      ).rejects.toThrow(/nothing was removed/u);
      expect(await lstat(join(paths.home, 'state', 'conversation-fixture.json'))).toBeDefined();
      expect(await readdir(backupDirOf(root))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('reset-v5 and real claude', () => {
  async function withRealClaude(s: Scratch): Promise<{ stub: string }> {
    const stub = join(s.root, 'stub-claude');
    await writeFile(stub, '#!/bin/sh\necho REAL "$@"\n', { mode: 0o755 });
    const store = storePathOf(s.real.fyHome, 'claude-real');
    await mkdir(store, { recursive: true });
    await writeFile(join(s.real.harness, FAKE_NAME), '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
    await writeFile(
      join(s.real.harness, 'claude'),
      shimText({ fake: join(s.real.harness, FAKE_NAME), real: stub, store }),
      { mode: 0o755 },
    );
    await writeFile(
      join(s.real.v5Dir, 'real-claude.json'),
      recordText({ login: 'claude-real', store, binary: stub, rootedAt: null }),
    );
    return { stub };
  }

  test('refuses while real claude is on, unless --keep-real-claude; the refusal changes nothing and stops nothing', async () => {
    const s = await scratch();
    try {
      await withRealClaude(s);
      const trace = actionsFor(s.paths);
      await expect(resetV5(s.paths, s.real, tar, trace.actions, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /--keep-real-claude/u,
      );
      expect(trace.steps).toEqual([]);
      expect(await lstat(join(s.paths.home, 'state', 'conversation-fixture.json'))).toBeDefined();
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test("--keep-real-claude re-points the dispatcher at the NEW home's store for the same login (the store is missing until sign-in)", async () => {
    const s = await scratch();
    try {
      const { stub } = await withRealClaude(s);
      const store = storePathOf(s.paths.home, 'claude-real');
      let seenAtStart = '';
      const trace = actionsFor(s.paths, {
        // The shim is already the new one when the daemon starts.
        startCheck: async () => void (seenAtStart = await readFile(join(s.real.harness, 'claude'), 'utf8')),
      });
      await resetV5(s.paths, s.real, tar, trace.actions, { keepRealClaude: true, now: NOW });
      const claude = await readFile(join(s.real.harness, 'claude'), 'utf8');
      expect(seenAtStart).toBe(claude);
      expect(isShim(claude)).toBe(true);
      expect(claude).toContain(`'${store}') exec env DISABLE_AUTOUPDATER=1 '${stub}'`);
      expect(await readRecord(s.real)).toEqual({ login: 'claude-real', store, binary: stub, rootedAt: null });
      expect(await lstat(store).catch(() => undefined)).toBeUndefined();
      expect(await lstat(join(s.paths.home, 'config', 'logins')).catch(() => undefined)).toBeUndefined();
      // The shim still sends the store's callers to the real claude, and everybody else to the fake.
      const ran = (env: Record<string, string>): string =>
        Bun.spawnSync([join(s.real.harness, 'claude'), 'hi'], { env: { PATH: '/usr/bin:/bin', ...env } })
          .stdout.toString()
          .trim();
      expect(ran({ CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe('REAL hi');
      expect(ran({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })).toBe('FAKE');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a shim with no record is never guessed at', async () => {
    const s = await scratch();
    try {
      await withRealClaude(s);
      await rm(join(s.real.v5Dir, 'real-claude.json'));
      await expect(
        resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, { keepRealClaude: true, now: NOW }),
      ).rejects.toThrow(/no real-claude.json/u);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
});

describe('restore-v5', () => {
  test('puts the old home back; the home it replaces is tarred first', async () => {
    const s = await scratch();
    try {
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      await mkdir(join(s.paths.home, 'config'), { recursive: true });
      await writeFile(join(s.paths.home, 'config', 'marker-of-new-home'), 'new\n');
      const trace = actionsFor(s.paths);
      const later = new Date('2026-11-18T19:30:00Z');
      const { saved } = await restoreV5(s.paths, tar, trace.actions, file, later);
      expect(trace.steps).toEqual(['stop (old home present: true)', 'start']);
      expect(await readFile(join(s.paths.home, 'state', 'conversation-fixture.json'), 'utf8')).toBe(
        '{"ferrets":["alpha","beta"]}\n',
      );
      expect(await readFile(join(s.paths.user, '.config', 'leftover'), 'utf8')).toBe('x\n');
      expect(await lstat(join(s.paths.home, 'config', 'marker-of-new-home')).catch(() => undefined)).toBeUndefined();
      expect(saved).toBe(join(backupDirOf(s.root), 'v5-restore-20261118T193000Z.tar'));
      expect((await tar.list(saved)).entries).toContain('home/config/marker-of-new-home');
      expect(await mode(saved)).toBe('600');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test("refuses a tar outside the slot's backup folder, a link, a group-readable one and an unsafe one; stops nothing", async () => {
    const s = await scratch();
    try {
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      const trace = actionsFor(s.paths);
      const outside = join(s.root, 'elsewhere.tar');
      await writeFile(outside, await readFile(file), { mode: 0o600 });
      await expect(restoreV5(s.paths, tar, trace.actions, outside, NOW)).rejects.toThrow(/not directly inside/u);
      const link = join(backupDirOf(s.root), 'link.tar');
      await symlink(file, link);
      await expect(restoreV5(s.paths, tar, trace.actions, link, NOW)).rejects.toThrow(/not a plain file/u);
      await chmod(file, 0o640);
      await expect(restoreV5(s.paths, tar, trace.actions, file, NOW)).rejects.toThrow(/readable by others/u);
      await chmod(file, 0o600);
      await expect(restoreV5(s.paths, tar, trace.actions, join(backupDirOf(s.root), 'nope.tar'), NOW)).rejects.toThrow(
        /does not exist/u,
      );
      const evil = join(backupDirOf(s.root), 'evil.tar');
      await mkdir(join(s.root, 'stage', 'etc'), { recursive: true });
      await writeFile(join(s.root, 'stage', 'etc', 'passwd'), 'x');
      Bun.spawnSync(['tar', '-C', join(s.root, 'stage'), '-cf', evil, 'etc']);
      await chmod(evil, 0o600);
      await expect(restoreV5(s.paths, tar, trace.actions, evil, NOW)).rejects.toThrow(/not under home\/ or user\//u);
      expect(trace.steps).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('tarEntryProblem: only home/ and user/, nothing absolute, no ..', () => {
    expect(tarEntryProblem('home/')).toBeUndefined();
    expect(tarEntryProblem('home/state/a.json')).toBeUndefined();
    expect(tarEntryProblem('user/.config/x')).toBeUndefined();
    expect(tarEntryProblem('/etc/passwd')).toMatch(/unsafe/u);
    expect(tarEntryProblem('home/../../etc')).toMatch(/unsafe/u);
    expect(tarEntryProblem('v4/home')).toMatch(/not under/u);
  });
});
