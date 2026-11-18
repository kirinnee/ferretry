import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  symlinkProblem,
  tarEntryProblem,
  tarMembersProblem,
  writeBindPin,
  writeProvenance,
  type ResetActions,
  type ResetPaths,
  type TarMember,
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
  const paths: ResetPaths = { slot: 3, real: root, v5Dir, home, user: join(v5Dir, 'user'), harness, port: 7619 };
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
      await writeProvenance(s.paths, evil, NOW);
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

// ─── the two HIGH findings of the review of PR 2054: a link in the tree, and a tar the kit did not make ─────────────

describe('reset-v5: a link in the tree is refused before anything is stopped (HIGH 1)', () => {
  test('a v5 folder that is a link to another slot removes nothing there, stops nothing', async () => {
    const a = await scratch();
    const foreign = await scratch();
    try {
      await rm(a.paths.v5Dir, { recursive: true });
      await symlink(foreign.paths.v5Dir, a.paths.v5Dir);
      const trace = actionsFor(a.paths);
      await expect(resetV5(a.paths, a.real, tar, trace.actions, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /not a plain folder|link|outside/u,
      );
      expect(trace.steps).toEqual([]);
      expect(await readFile(join(foreign.paths.home, 'config', 'daemon.json'), 'utf8')).toContain('OLD');
      expect(await readdir(backupDirOf(a.root)).catch(() => [])).toEqual([]);
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(foreign.root, { recursive: true, force: true });
    }
  });

  test('a home or user folder that is a link, or a v5 parent reached through a linked slot folder, is refused too', async () => {
    const a = await scratch();
    const foreign = await scratch();
    try {
      const trace = actionsFor(a.paths);
      await rm(a.paths.home, { recursive: true });
      await symlink(foreign.paths.home, a.paths.home);
      await expect(resetV5(a.paths, a.real, tar, trace.actions, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /not a plain folder/u,
      );
      await rm(a.paths.home);
      await mkdir(a.paths.home);
      await rm(a.paths.user, { recursive: true });
      await symlink(foreign.paths.user, a.paths.user);
      await expect(resetV5(a.paths, a.real, tar, trace.actions, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /not a plain folder/u,
      );
      await rm(a.paths.user);
      await mkdir(a.paths.user);
      // The backup folder as a link to somewhere else.
      await symlink(foreign.root, backupDirOf(a.root));
      await expect(resetV5(a.paths, a.real, tar, trace.actions, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /not a plain folder/u,
      );
      expect(trace.steps).toEqual([]);
      expect(await readFile(join(foreign.paths.home, 'config', 'daemon.json'), 'utf8')).toContain('OLD');
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(foreign.root, { recursive: true, force: true });
    }
  });

  test('the slot folder reached through a link whose target is another folder: v5 must resolve to <slot realpath>/v5', async () => {
    const a = await scratch();
    const foreign = await scratch();
    try {
      // `paths` says the slot is `a`, but its v5 paths are the foreign slot's (a copy of the paths with the wrong parent).
      const crossed: ResetPaths = { ...foreign.paths, real: a.root };
      const trace = actionsFor(crossed);
      await expect(
        resetV5(crossed, { ...foreign.real }, tar, trace.actions, { keepRealClaude: false, now: NOW }),
      ).rejects.toThrow(/resolves to/u);
      expect(trace.steps).toEqual([]);
      expect(await lstat(join(foreign.paths.home, 'config', 'daemon.json'))).toBeDefined();
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(foreign.root, { recursive: true, force: true });
    }
  });
});

describe('restore-v5: only a tar THIS slot made, and a safe one (HIGH 2)', () => {
  /** A hand-made tar in the slot's backup folder, 0600, with (by default) a valid provenance record for it. */
  async function plant(
    s: Scratch,
    name: string,
    build: (stage: string) => Promise<void>,
    options: { record?: boolean; extra?: string[] } = {},
  ): Promise<string> {
    const stage = join(s.root, `stage-${name}`);
    await mkdir(stage, { recursive: true });
    await build(stage);
    const dir = join(s.root, 'reset-backups');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${name}.tar`);
    const made = Bun.spawnSync(['tar', '-C', stage, ...(options.extra ?? []), '-cf', file, 'home', 'user']);
    if (made.exitCode !== 0) throw new Error(made.stderr.toString());
    await chmod(file, 0o600);
    if (options.record !== false) await writeProvenance(s.paths, file, NOW);
    return file;
  }
  const plain = async (stage: string): Promise<void> => {
    await mkdir(join(stage, 'home', 'config'), { recursive: true });
    await writeFile(join(stage, 'home', 'config', 'daemon.json'), '{"restored":true}\n');
    await mkdir(join(stage, 'user'), { recursive: true });
  };
  const refusesUntouched = async (s: Scratch, file: string, message: RegExp): Promise<void> => {
    const trace = actionsFor(s.paths);
    const before = await listing(s.paths.home);
    await expect(restoreV5(s.paths, tar, trace.actions, file, NOW)).rejects.toThrow(message);
    expect(trace.steps).toEqual([]);
    expect(await listing(s.paths.home)).toEqual(before);
    expect((await readdir(s.root)).filter(name => name.startsWith('.restore-'))).toEqual([]);
  };

  test('a reset tar of ANOTHER slot copied here is refused, with or without its record', async () => {
    const b = await scratch();
    const c = await scratch();
    try {
      const { tar: saved } = await resetV5(b.paths, b.real, tar, actionsFor(b.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      await mkdir(backupDirOf(c.root), { mode: 0o700 });
      const copied = join(backupDirOf(c.root), 'arbitrary.tar');
      await Bun.write(copied, Bun.file(saved));
      await chmod(copied, 0o600);
      await refusesUntouched(c, copied, /no provenance record/u);
      await Bun.write(`${copied}.provenance.json`, Bun.file(`${saved}.provenance.json`));
      await chmod(`${copied}.provenance.json`, 0o600);
      await refusesUntouched(c, copied, /another slot|not made by this slot|does not match/u);
    } finally {
      await rm(b.root, { recursive: true, force: true });
      await rm(c.root, { recursive: true, force: true });
    }
  });

  test('a tar of this slot that was changed after the reset (hash differs) is refused', async () => {
    const s = await scratch();
    try {
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      const other = join(s.root, 'other-stage');
      await mkdir(join(other, 'home'), { recursive: true });
      await mkdir(join(other, 'user'), { recursive: true });
      Bun.spawnSync(['tar', '-C', other, '-cf', file, 'home', 'user']);
      await chmod(file, 0o600);
      const trace = actionsFor(s.paths);
      await expect(restoreV5(s.paths, tar, trace.actions, file, NOW)).rejects.toThrow(/hash/u);
      expect(trace.steps).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a record with a loose mode, a link as the record, or junk in it is refused', async () => {
    const s = await scratch();
    try {
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      const record = `${file}.provenance.json`;
      const good = await readFile(record, 'utf8');
      expect(await mode(record)).toBe('600');
      await chmod(record, 0o644);
      await refusesUntouched(s, file, /provenance record .*readable by others/u);
      await chmod(record, 0o600);
      await writeFile(record, '{"slot":"x"}');
      await refusesUntouched(s, file, /provenance record/u);
      await rm(record);
      await symlink(join(s.root, 'elsewhere.json'), record);
      await refusesUntouched(s, file, /provenance record/u);
      await rm(record);
      await writeFile(record, good, { mode: 0o600 });
      // Back to a good record: the restore works.
      const trace = actionsFor(s.paths);
      await restoreV5(s.paths, tar, trace.actions, file, new Date('2026-11-18T19:40:00Z'));
      expect(trace.steps).toEqual(['stop (old home present: true)', 'start']);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('an unrelated tar carrying home -> /outside is refused even with a record, and the home is not replaced', async () => {
    const s = await scratch();
    const outside = join(s.root, 'outside-home');
    try {
      await mkdir(join(outside, 'config'), { recursive: true });
      const file = await plant(s, 'unrelated', async stage => {
        await symlink(outside, join(stage, 'home'));
        await mkdir(join(stage, 'user'));
      });
      await refusesUntouched(s, file, /symlink|link/u);
      expect(await lstat(s.paths.home)).toBeDefined();
      expect((await lstat(s.paths.home)).isSymbolicLink()).toBe(false);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('links that point out of the archive, absolute names, .., fifos and a path through a link are refused', async () => {
    const s = await scratch();
    try {
      const cases: Array<[string, (stage: string) => Promise<void>, string[], RegExp]> = [
        [
          'abs-link',
          async stage => {
            await plain(stage);
            await symlink('/etc/passwd', join(stage, 'home', 'config', 'pw'));
          },
          [],
          /points outside/u,
        ],
        [
          'rel-link',
          async stage => {
            await plain(stage);
            await symlink('../../../../etc', join(stage, 'home', 'config', 'up'));
          },
          [],
          /points outside/u,
        ],
        [
          'fifo',
          async stage => {
            await plain(stage);
            Bun.spawnSync(['mkfifo', join(stage, 'home', 'pipe')]);
          },
          [],
          /not a plain file|special|fifo/u,
        ],
        [
          'dotdot',
          async stage => {
            await plain(stage);
          },
          ['--transform', 's,^home/config,home/../x,'],
          /unsafe path/u,
        ],
        [
          'absolute',
          async stage => {
            await plain(stage);
          },
          ['-P', '--transform', 's,^home/config,/tmp/zz,'],
          /unsafe path/u,
        ],
      ];
      for (const [name, build, extra, message] of cases) {
        const file = await plant(s, name, build, { extra });
        await refusesUntouched(s, file, message);
      }
      // A member that goes THROUGH a link the archive itself made is refused (once extracted, the link could point anywhere).
      const through = await plant(
        s,
        'through',
        async stage => {
          await plain(stage);
          await mkdir(join(stage, 'home', 'real'));
          await writeFile(join(stage, 'home', 'real', 'file'), 'x');
          await symlink('real', join(stage, 'home', 'via'));
        },
        { extra: ['--transform', 's,^home/real/file$,home/via/file,'] },
      );
      await refusesUntouched(s, through, /under a symlink it made itself/u);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a good tar round-trips: long names, inner relative links and a hard link survive; the swap is from a temp folder, nothing is left', async () => {
    const s = await scratch();
    try {
      const long = join('state', 'x'.repeat(90), 'y'.repeat(90), 'z'.repeat(40));
      await mkdir(join(s.paths.home, long), { recursive: true });
      await writeFile(join(s.paths.home, long, 'deep.txt'), 'deep\n');
      await symlink('conversation-fixture.json', join(s.paths.home, 'state', 'inner-link'));
      await Bun.$`ln ${join(s.paths.home, 'state', 'conversation-fixture.json')} ${join(s.paths.home, 'state', 'hard')}`.quiet();
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      await restoreV5(s.paths, tar, actionsFor(s.paths).actions, file, new Date('2026-11-18T19:31:00Z'));
      expect(await readFile(join(s.paths.home, long, 'deep.txt'), 'utf8')).toBe('deep\n');
      expect(await readFile(join(s.paths.home, 'state', 'inner-link'), 'utf8')).toBe('{"ferrets":["alpha","beta"]}\n');
      expect(await readFile(join(s.paths.home, 'state', 'hard'), 'utf8')).toBe('{"ferrets":["alpha","beta"]}\n');
      expect((await readdir(s.root)).filter(name => name.startsWith('.restore-'))).toEqual([]);
      expect(await mode(join(backupDirOf(s.root), 'v5-restore-20261118T193100Z.tar.provenance.json'))).toBe('600');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('the provenance record names the slot, its realpath, the UTC stamp and the tar hash', async () => {
    const s = await scratch();
    try {
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      const record = JSON.parse(await readFile(`${file}.provenance.json`, 'utf8')) as Record<string, unknown>;
      const hash = new Bun.CryptoHasher('sha256').update(await readFile(file)).digest('hex');
      expect(record).toEqual({
        format: 1,
        slot: s.paths.slot,
        slotRealpath: await realpath(s.root),
        tar: 'v5-reset-20261118T191705Z.tar',
        created: '2026-11-18T19:17:05.123Z',
        sha256: hash,
      });
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
});

describe('tarMembersProblem and symlinkProblem (pure)', () => {
  const v5 = '/slots/s3/v5';
  test('links: inside is fine; outside, absolute-elsewhere and chained-through-a-link are not', () => {
    expect(symlinkProblem('home/a/b', '../c', v5)).toBeUndefined();
    expect(symlinkProblem('home/a', 'c/d', v5)).toBeUndefined();
    expect(symlinkProblem('home/a', '../../etc', v5)).toMatch(/outside/u);
    expect(symlinkProblem('home/a', '..', v5)).toMatch(/outside/u);
    expect(symlinkProblem('home/a', '/etc/passwd', v5)).toMatch(/outside/u);
    expect(symlinkProblem('home/a', '/slots/s3/v5/home/x', v5)).toBeUndefined();
    expect(symlinkProblem('home/a', '/slots/s3/v5/home/../../s4/v5/home', v5)).toMatch(/outside/u);
    expect(symlinkProblem('home/a', '/slots/s3/v5/homeX', v5)).toMatch(/outside/u);
    expect(symlinkProblem('home/a', '', v5)).toMatch(/no target/u);
  });
  test('hard links must name another member of home/ or user/, never through a link; types other than file/dir/link do not reach here', () => {
    const file = (name: string): TarMember => ({ name, kind: 'file', target: '' });
    const hard = (name: string, target: string): TarMember => ({ name, kind: 'hardlink', target });
    expect(tarMembersProblem([file('home/a'), hard('home/b', 'home/a')], v5)).toBeUndefined();
    expect(tarMembersProblem([hard('home/b', 'etc/passwd')], v5)).toMatch(/hard link/u);
    expect(tarMembersProblem([hard('home/b', '/etc/passwd')], v5)).toMatch(/hard link/u);
    expect(tarMembersProblem([hard('home/b', 'home/../../etc')], v5)).toMatch(/hard link/u);
    expect(
      tarMembersProblem([{ name: 'home/l', kind: 'symlink', target: 'x' }, hard('home/b', 'home/l/y')], v5),
    ).toMatch(/through a symlink/u);
    expect(tarMembersProblem([file('/abs')], v5)).toMatch(/unsafe/u);
  });
});

describe('the new home: the port pin and the stop (reviewer gaps)', () => {
  test('writeBindPin on an empty home writes ONLY config/daemon.json: one bind carrier, 127.0.0.1 and the slot port, mode 0600', async () => {
    const s = await scratch();
    try {
      await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, { keepRealClaude: false, now: NOW });
      expect(await homeFiles(s.paths.home)).toEqual([]);
      await writeBindPin(s.paths.home, s.paths.port);
      expect(await homeFiles(s.paths.home)).toEqual([join('config', 'daemon.json')]);
      const file = join(s.paths.home, 'config', 'daemon.json');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        carriers: [{ kind: 'bind', host: '127.0.0.1', port: 7619 }],
      });
      expect(await mode(file)).toBe('600');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('writeBindPin merges into what the daemon wrote: its other carriers and keys stay, an old bind is replaced, a damaged-shape file is not trusted', async () => {
    const s = await scratch();
    try {
      await rm(s.paths.home, { recursive: true });
      const file = join(s.paths.home, 'config', 'daemon.json');
      await mkdir(join(s.paths.home, 'config'), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          name: 'kept',
          carriers: [
            { kind: 'bind', host: '0.0.0.0', port: 1 },
            { kind: 'relay', url: 'x' },
          ],
        }),
      );
      await writeBindPin(s.paths.home, 7619);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        name: 'kept',
        carriers: [
          { kind: 'bind', host: '127.0.0.1', port: 7619 },
          { kind: 'relay', url: 'x' },
        ],
      });
      await writeFile(file, '[1,2]');
      await writeBindPin(s.paths.home, 7619);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        carriers: [{ kind: 'bind', host: '127.0.0.1', port: 7619 }],
      });
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a 5.0 side that will not stop: the reset refuses, moves and removes nothing, writes no tar, starts nothing', async () => {
    const s = await scratch();
    try {
      const steps: string[] = [];
      const stuck: ResetActions = {
        stop: async () => {
          steps.push('stop');
          throw new ResetRefusal(
            'the 5.0 side of slot 3 is still running after its units were stopped; nothing was removed',
          );
        },
        installBuild: async () => void steps.push('installBuild'),
        start: async () => void steps.push('start'),
        say: () => undefined,
      };
      const before = await listing(s.root);
      await expect(resetV5(s.paths, s.real, tar, stuck, { keepRealClaude: false, now: NOW })).rejects.toThrow(
        /still running/u,
      );
      expect(steps).toEqual(['stop']);
      expect(await listing(s.root)).toEqual(before);
      expect(await readdir(backupDirOf(s.root)).catch(() => [])).toEqual([]);
      // The same for a restore: the current home and the tar stay as they were.
      const { tar: file } = await resetV5(s.paths, s.real, tar, actionsFor(s.paths).actions, {
        keepRealClaude: false,
        now: NOW,
      });
      const afterReset = await listing(s.root);
      steps.length = 0;
      await expect(restoreV5(s.paths, tar, stuck, file, new Date('2026-11-18T19:50:00Z'))).rejects.toThrow(
        /still running/u,
      );
      expect(steps).toEqual(['stop']);
      expect(await listing(s.root)).toEqual(afterReset);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
});
