import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PROVENANCE_FILE,
  ResetHalfway,
  ResetRefusal,
  homeFiles,
  installPrograms,
  keptDirOf,
  resetStamp,
  resetV5,
  restoreV5,
  writeBindPin,
  type ResetActions,
  type ResetPaths,
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
const STAMP = '20261118T191705Z';
const LATER = new Date('2026-11-18T19:30:00Z');
const options = { keepRealClaude: false, now: NOW };

interface Scratch {
  readonly root: string;
  readonly paths: ResetPaths;
  readonly real: RealPaths;
  readonly v4Marker: string;
}

/** A persisted slot's folder as the kit leaves it: a v4 side, and a RICH 5.0 side (ferrets, logins, devices, links, modes). */
async function scratch(slot = 3): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), 'kit-empty-'));
  const v4Marker = join(root, 'v4', 'home', 'marker.txt');
  await mkdir(join(root, 'v4', 'home'), { recursive: true });
  await writeFile(v4Marker, 'v4 data\n');
  const v5Dir = join(root, 'v5');
  const home = join(v5Dir, 'home');
  const harness = join(v5Dir, 'harness-bin');
  const bin = join(v5Dir, 'bin');
  await mkdir(join(home, 'config', 'logins'), { recursive: true });
  await mkdir(join(home, 'state', 'kernel', 'accepted-config'), { recursive: true });
  await mkdir(join(home, 'state', 'access'), { recursive: true });
  await mkdir(join(home, 'state', 'logins', 'credentials', 'codex-main'), { recursive: true });
  await mkdir(join(home, 'state', 'terminals'), { recursive: true });
  await mkdir(join(v5Dir, 'user', '.config'), { recursive: true });
  await mkdir(harness, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(home, 'config', 'daemon.json'),
    '{"carriers":[{"kind":"bind","host":"127.0.0.1","port":7619}],"extra":"OLD"}\n',
  );
  await writeFile(join(home, 'config', 'logins', 'codex-main.yaml'), 'harness: codex\n');
  await writeFile(join(home, 'state', 'access', 'devices.json'), '{"devices":["phone"]}\n');
  await writeFile(join(home, 'state', 'logins', 'credentials', 'codex-main', 'auth.json'), '{"fake":true}\n', {
    mode: 0o600,
  });
  await writeFile(join(home, 'state', 'conversation-fixture.json'), '{"ferrets":["alpha","beta"]}\n');
  await writeFile(join(home, 'state', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  await symlink('conversation-fixture.json', join(home, 'state', 'inner-link'));
  await symlink('/nonexistent-outside/anything', join(home, 'state', 'outside-link'));
  await writeFile(join(v5Dir, 'user', '.config', 'leftover'), 'x\n');
  await writeFile(join(harness, 'claude'), '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
  await writeFile(join(bin, 'fyd'), 'program\n', { mode: 0o755 });
  const paths: ResetPaths = {
    slot,
    real: root,
    v5Dir,
    home,
    user: join(v5Dir, 'user'),
    harness,
    bin,
    port: 7619,
  };
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

/** Every path, type, mode, link target and file hash under `root`: equal digests mean every byte (and mode) is the same. */
async function digest(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const path = join(folder, entry.name);
      const info = await lstat(path);
      const shown = `${path.slice(root.length)} ${(info.mode & 0o777).toString(8)}`;
      if (entry.isSymbolicLink()) lines.push(`l ${shown} -> ${await readlink(path)}`);
      else if (entry.isDirectory()) {
        lines.push(`d ${shown}`);
        await walk(path);
      } else
        lines.push(
          `f ${shown} ${createHash('sha256')
            .update(await readFile(path))
            .digest('hex')}`,
        );
    }
  };
  await walk(root);
  return lines.join('\n');
}

const mode = async (path: string): Promise<string> => ((await lstat(path)).mode & 0o777).toString(8);
const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;
const keptOf = (s: Scratch, stamp = STAMP): string => join(keptDirOf(s.root), stamp);
const noTar = async (root: string): Promise<void> => {
  expect((await listing(root)).filter(name => /\.tar|reset-backups|\.reset-staging|\.restore-/u.test(name))).toEqual(
    [],
  );
};

describe('reset-v5: an empty home on a persisted slot', () => {
  test('the new home is an EMPTY folder: no config, no limits file, no gate, no name, no identity, no ferret, login or device', async () => {
    const { root, paths, real } = await scratch();
    try {
      await resetV5(paths, real, actionsFor(paths).actions, options);
      expect(await homeFiles(paths.home)).toEqual([]);
      for (const gone of ['logins', 'runtimes', 'profiles', 'projects'])
        expect(await exists(join(paths.home, 'config', gone))).toBe(false);
      expect(await exists(join(paths.home, 'state', 'access'))).toBe(false);
      expect(await exists(join(paths.home, 'state', 'kernel', 'identity.json'))).toBe(false);
      expect(await readdir(paths.user)).toEqual([]);
      expect(await mode(paths.home)).toBe('700');
      expect(await readdir(paths.home)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the old home is MOVED, not copied or packed: same folders (same inodes), every byte and mode, a 0600 record; no tar, no backup folder, no staging; stop first, start last', async () => {
    const { root, paths, real } = await scratch();
    try {
      const home = await lstat(paths.home);
      const homeDigest = await digest(paths.home);
      const userDigest = await digest(paths.user);
      const trace = actionsFor(paths);
      const done = await resetV5(paths, real, trace.actions, options);
      expect(trace.steps).toEqual(['stop (old home present: true)', 'installBuild', 'start']);
      const dir = join(await realpath(root), 'kept', STAMP);
      expect(done).toEqual({ kept: dir, stamp: STAMP });
      expect(resetStamp(NOW)).toBe(STAMP);
      expect(await mode(keptOf({ root } as Scratch))).toBe('700');
      expect(await mode(dir)).toBe('700');
      expect(await digest(join(dir, 'home'))).toBe(homeDigest);
      expect(await digest(join(dir, 'user'))).toBe(userDigest);
      const moved = await lstat(join(dir, 'home'));
      expect([moved.ino, moved.dev]).toEqual([home.ino, home.dev]);
      expect(await mode(join(dir, PROVENANCE_FILE))).toBe('600');
      const record = JSON.parse(await readFile(join(dir, PROVENANCE_FILE), 'utf8')) as Record<string, unknown>;
      expect(record).toMatchObject({ format: 1, slot: 3, slotRealpath: await realpath(root), stamp: STAMP });
      expect(record.members).toEqual([
        { name: 'home', ino: home.ino, dev: home.dev },
        { name: 'user', ino: (await lstat(join(dir, 'user'))).ino, dev: home.dev },
      ]);
      expect((await readdir(dir)).sort()).toEqual(['home', PROVENANCE_FILE, 'user']);
      await noTar(root);
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
      const beforeV4 = await listing(join(root, 'v4'));
      const kept = ['bin', join('v5', 'bin'), join('v5', 'harness-bin')];
      const before = await Promise.all(kept.map(async name => await digest(join(root, name))));
      await resetV5(paths, real, actionsFor(paths).actions, options);
      expect(await listing(join(root, 'v4'))).toEqual(beforeV4);
      expect(await readFile(v4Marker, 'utf8')).toBe('v4 data\n');
      expect(await readFile(join(root, 'cli-names.json'), 'utf8')).toBe('{"v5":"fy5"}\n');
      expect(await Promise.all(kept.map(async name => await digest(join(root, name))))).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a missing home is refused before anything is stopped', async () => {
    const { root, paths, real } = await scratch();
    try {
      await rm(paths.home, { recursive: true });
      const trace = actionsFor(paths);
      await expect(resetV5(paths, real, trace.actions, options)).rejects.toThrow(/no 5.0 home to reset/u);
      expect(trace.steps).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a 5.0 side that will not stop: the reset refuses, moves nothing and starts nothing; the same for a restore', async () => {
    const s = await scratch();
    try {
      const steps: string[] = [];
      const stuck: ResetActions = {
        stop: async () => {
          steps.push('stop');
          throw new ResetRefusal('the 5.0 side of slot 3 is still running after its units were stopped');
        },
        installBuild: async () => void steps.push('installBuild'),
        start: async () => void steps.push('start'),
        say: () => undefined,
      };
      const before = await listing(s.root);
      await expect(resetV5(s.paths, s.real, stuck, options)).rejects.toThrow(/still running/u);
      expect(steps).toEqual(['stop']);
      expect(await listing(s.root)).toEqual(before);
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      const afterReset = await listing(s.root);
      steps.length = 0;
      await expect(restoreV5(s.paths, stuck, STAMP, LATER)).rejects.toThrow(/still running/u);
      expect(steps).toEqual(['stop']);
      expect(await listing(s.root)).toEqual(afterReset);
    } finally {
      await rm(s.root, { recursive: true, force: true });
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
      await expect(resetV5(s.paths, s.real, trace.actions, options)).rejects.toThrow(/--keep-real-claude/u);
      expect(trace.steps).toEqual([]);
      expect(await exists(join(s.paths.home, 'state', 'conversation-fixture.json'))).toBe(true);
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
      await resetV5(s.paths, s.real, trace.actions, { keepRealClaude: true, now: NOW });
      const claude = await readFile(join(s.real.harness, 'claude'), 'utf8');
      expect(seenAtStart).toBe(claude);
      expect(isShim(claude)).toBe(true);
      expect(claude).toContain(`'${store}') exec env DISABLE_AUTOUPDATER=1 '${stub}'`);
      expect(await readRecord(s.real)).toEqual({ login: 'claude-real', store, binary: stub, rootedAt: null });
      expect(await exists(store)).toBe(false);
      expect(await exists(join(s.paths.home, 'config', 'logins'))).toBe(false);
      // The shim still sends the store's callers to the real claude, and everybody else to the fake.
      const ran = (env: Record<string, string>): string =>
        Bun.spawnSync([join(s.real.harness, 'claude'), 'hi'], { env: { PATH: '/usr/bin:/bin', ...env } })
          .stdout.toString()
          .trim();
      expect(ran({ CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe('REAL hi');
      expect(ran({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })).toBe('FAKE');
      // The old home, with its login store, is whole in the kept folder.
      expect(await exists(join(keptOf(s), 'home', 'state', 'logins', 'credentials', 'claude-real'))).toBe(true);
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
        resetV5(s.paths, s.real, actionsFor(s.paths).actions, { keepRealClaude: true, now: NOW }),
      ).rejects.toThrow(/no real-claude.json/u);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
});

describe('restore-v5: rename only', () => {
  test('reset then restore keeps every byte: the tree hashes the same, the home it replaces is kept, the emptied kept folder is gone', async () => {
    const s = await scratch();
    try {
      const homeDigest = await digest(s.paths.home);
      const userDigest = await digest(s.paths.user);
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      await mkdir(join(s.paths.home, 'config'), { recursive: true });
      await writeFile(join(s.paths.home, 'config', 'marker-of-new-home'), 'new\n');
      const trace = actionsFor(s.paths);
      const { saved } = await restoreV5(s.paths, trace.actions, STAMP, LATER);
      expect(trace.steps).toEqual(['stop (old home present: true)', 'start']);
      expect(await digest(s.paths.home)).toBe(homeDigest);
      expect(await digest(s.paths.user)).toBe(userDigest);
      expect(await exists(join(s.paths.home, 'config', 'marker-of-new-home'))).toBe(false);
      expect(saved).toBe(join(await realpath(s.root), 'kept', resetStamp(LATER)));
      expect(await readFile(join(saved ?? '', 'home', 'config', 'marker-of-new-home'), 'utf8')).toBe('new\n');
      expect(await exists(keptOf(s))).toBe(false);
      await noTar(s.root);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('restore works when there is no current home at all (nothing is kept for it)', async () => {
    const s = await scratch();
    try {
      const homeDigest = await digest(s.paths.home);
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      await rm(s.paths.home, { recursive: true });
      await rm(s.paths.user, { recursive: true });
      const trace = actionsFor(s.paths);
      const { saved } = await restoreV5(s.paths, trace.actions, STAMP, LATER);
      expect(saved).toBeUndefined();
      expect(trace.steps).toEqual(['stop (old home present: false)', 'start']);
      expect(await digest(s.paths.home)).toBe(homeDigest);
      expect(await readFile(join(s.paths.user, '.config', 'leftover'), 'utf8')).toBe('x\n');
      expect(await readdir(keptDirOf(s.root))).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a kept copy with no user folder still restores (an empty user folder is made)', async () => {
    const s = await scratch();
    try {
      await rm(s.paths.user, { recursive: true });
      const homeDigest = await digest(s.paths.home);
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      expect((await readdir(keptOf(s))).sort()).toEqual(['home', PROVENANCE_FILE]);
      await restoreV5(s.paths, actionsFor(s.paths).actions, STAMP, LATER);
      expect(await digest(s.paths.home)).toBe(homeDigest);
      expect(await readdir(s.paths.user)).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('refuses a stamp that is no stamp, a kept folder that is not there, one with no record, a loose or damaged record, a stray entry; stops nothing', async () => {
    const s = await scratch();
    try {
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      const trace = actionsFor(s.paths);
      const before = await listing(s.root);
      await expect(restoreV5(s.paths, trace.actions, '../v5', LATER)).rejects.toThrow(/not a stamp/u);
      await expect(restoreV5(s.paths, trace.actions, '20261118T000000Z', LATER)).rejects.toThrow(/not a kept copy/u);
      const record = join(keptOf(s), PROVENANCE_FILE);
      const text = await readFile(record, 'utf8');
      await chmod(record, 0o644);
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/readable by others/u);
      await chmod(record, 0o600);
      await writeFile(record, '{"format":1', { mode: 0o600 });
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/not valid JSON/u);
      await writeFile(record, JSON.stringify({ format: 2 }), { mode: 0o600 });
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/damaged/u);
      await writeFile(record, text.replace('"home"', '"etc"'), { mode: 0o600 });
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/does not keep|no home/u);
      await writeFile(record, text, { mode: 0o600 });
      await writeFile(join(keptOf(s), 'stray'), 'x');
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/holds/u);
      await rm(join(keptOf(s), 'stray'));
      await rm(record);
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/no provenance\.json/u);
      expect(trace.steps).toEqual([]);
      await writeFile(record, text, { mode: 0o600 });
      expect((await listing(s.root)).filter(name => !name.includes('provenance'))).toEqual(
        before.filter(name => !name.includes('provenance')),
      );
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('refuses to restore in the very second it would keep the current home under the same name, before stopping anything', async () => {
    const s = await scratch();
    try {
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      const trace = actionsFor(s.paths);
      await expect(restoreV5(s.paths, trace.actions, STAMP, NOW)).rejects.toThrow(/already exists/u);
      expect(trace.steps).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
});

// ─── every review round's proof scenario: refused, or harmless (an external marker survives) ──────────────────────────

describe('reset-v5 and restore-v5: links and swaps are refused or harmless', () => {
  const marked = async (victim: Scratch): Promise<void> => {
    expect(await readFile(join(victim.paths.home, 'config', 'daemon.json'), 'utf8')).toContain('OLD');
    expect(await readFile(join(victim.paths.user, '.config', 'leftover'), 'utf8')).toBe('x\n');
    expect(await readFile(join(victim.paths.bin, 'fyd'), 'utf8')).toBe('program\n');
  };
  const swapV5 = async (s: Scratch, victim: Scratch): Promise<void> => {
    await rename(s.paths.v5Dir, `${s.paths.v5Dir}.original`);
    await symlink(victim.paths.v5Dir, s.paths.v5Dir);
  };
  const outcome = async (go: () => Promise<unknown>): Promise<Error | undefined> => {
    try {
      await go();
      return undefined;
    } catch (error) {
      return error as Error;
    }
  };

  test('a v5 folder that is a link to another slot (the original parent proof) moves nothing there and stops nothing', async () => {
    const a = await scratch();
    const victim = await scratch(4);
    try {
      await rm(a.paths.v5Dir, { recursive: true });
      await symlink(victim.paths.v5Dir, a.paths.v5Dir);
      const before = await listing(victim.root);
      const trace = actionsFor(a.paths);
      await expect(resetV5(a.paths, a.real, trace.actions, options)).rejects.toThrow(/not a plain folder/u);
      expect(trace.steps).toEqual([]);
      await expect(restoreV5(a.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/not a plain folder/u);
      expect(trace.steps).toEqual([]);
      await marked(victim);
      expect(await listing(victim.root)).toEqual(before);
      expect(await exists(keptDirOf(a.root))).toBe(false);
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('a home, user, bin, config or kept folder that is a link, and a slot reached with the wrong parent, are refused before anything is stopped', async () => {
    const a = await scratch();
    const victim = await scratch(4);
    try {
      const trace = actionsFor(a.paths);
      const before = await listing(victim.root);
      const refused = async (): Promise<void> => {
        await expect(resetV5(a.paths, a.real, trace.actions, options)).rejects.toThrow(/not a plain folder/u);
      };
      await rm(a.paths.home, { recursive: true });
      await symlink(victim.paths.home, a.paths.home);
      await refused();
      await rm(a.paths.home);
      await mkdir(a.paths.home);
      await rm(a.paths.user, { recursive: true });
      await symlink(victim.paths.user, a.paths.user);
      await refused();
      await rm(a.paths.user);
      await mkdir(a.paths.user);
      await rename(a.paths.bin, `${a.paths.bin}.real`);
      await symlink(victim.paths.bin, a.paths.bin);
      await refused();
      await rm(a.paths.bin);
      await rename(`${a.paths.bin}.real`, a.paths.bin);
      await symlink(join(victim.paths.home, 'config'), join(a.paths.home, 'config'));
      await refused();
      await rm(join(a.paths.home, 'config'));
      await symlink(victim.root, keptDirOf(a.root));
      await refused();
      await rm(keptDirOf(a.root));
      // `paths` says the slot is `a`, but its v5 paths are the victim's.
      const crossed: ResetPaths = { ...victim.paths, real: a.root };
      await expect(resetV5(crossed, { ...victim.real }, actionsFor(crossed).actions, options)).rejects.toThrow(
        /resolves to/u,
      );
      expect(trace.steps).toEqual([]);
      expect(await listing(victim.root)).toEqual(before);
      await marked(victim);
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('daemon.json that is a link makes the whole reset refuse before the stop', async () => {
    const a = await scratch();
    const victim = await scratch(4);
    try {
      const target = join(victim.root, 'outside-target');
      await writeFile(target, 'EXTERNAL');
      await rm(join(a.paths.home, 'config', 'daemon.json'));
      await symlink(target, join(a.paths.home, 'config', 'daemon.json'));
      const trace = actionsFor(a.paths);
      await expect(resetV5(a.paths, a.real, trace.actions, options)).rejects.toThrow(
        /daemon\.json is not a plain file/u,
      );
      expect(trace.steps).toEqual([]);
      expect(await readFile(target, 'utf8')).toBe('EXTERNAL');
    } finally {
      await rm(a.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('a kept copy made by ANOTHER slot, copied here with or without its record, is refused', async () => {
    const b = await scratch();
    const c = await scratch(4);
    try {
      await resetV5(b.paths, b.real, actionsFor(b.paths).actions, options);
      await mkdir(keptDirOf(c.root), { mode: 0o700 });
      Bun.spawnSync(['cp', '-a', keptOf(b), keptOf(c)]);
      const trace = actionsFor(c.paths);
      await expect(restoreV5(c.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/another slot/u);
      await rm(join(keptOf(c), PROVENANCE_FILE));
      await expect(restoreV5(c.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/no provenance\.json/u);
      // A record forged for THIS slot over the copy: the folders are not the ones that were moved (other inodes).
      const forged = JSON.parse(await readFile(join(keptOf(b), PROVENANCE_FILE), 'utf8')) as Record<string, unknown>;
      await writeFile(
        join(keptOf(c), PROVENANCE_FILE),
        JSON.stringify({ ...forged, slot: 4, slotRealpath: await realpath(c.root) }),
        { mode: 0o600 },
      );
      await expect(restoreV5(c.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/not the folder that was moved/u);
      expect(trace.steps).toEqual([]);
      await marked(c);
    } finally {
      await rm(b.root, { recursive: true, force: true });
      await rm(c.root, { recursive: true, force: true });
    }
  });

  test('a kept home replaced by a link to another slot is refused, and nothing there moves', async () => {
    const s = await scratch();
    const victim = await scratch(4);
    try {
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      await rename(join(keptOf(s), 'home'), join(s.root, 'original-home'));
      await symlink(victim.paths.home, join(keptOf(s), 'home'));
      const trace = actionsFor(s.paths);
      await expect(restoreV5(s.paths, trace.actions, STAMP, LATER)).rejects.toThrow(/not a plain folder/u);
      expect(trace.steps).toEqual([]);
      await marked(victim);
    } finally {
      await rm(s.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('v5 swapped for another slot during the stop, or during the build install: refused before anything is moved; the other slot is untouched', async () => {
    for (const during of ['stop', 'installBuild'] as const) {
      const s = await scratch();
      const victim = await scratch(4);
      try {
        const before = await listing(victim.root);
        const steps: string[] = [];
        const actions: ResetActions = {
          stop: async () => {
            steps.push('stop');
            if (during === 'stop') await swapV5(s, victim);
          },
          installBuild: async () => {
            steps.push('installBuild');
            if (during === 'installBuild') await swapV5(s, victim);
          },
          start: async () => void steps.push('start'),
          say: () => undefined,
        };
        await expect(resetV5(s.paths, s.real, actions, options)).rejects.toThrow(/not a plain folder/u);
        expect(steps).toEqual(during === 'stop' ? ['stop'] : ['stop', 'installBuild']);
        expect(await listing(victim.root)).toEqual(before);
        await marked(victim);
        expect(await exists(join(s.root, 'kept'))).toBe(false);
        expect(await exists(join(`${s.paths.v5Dir}.original`, 'home', 'state', 'conversation-fixture.json'))).toBe(
          true,
        );
      } finally {
        await rm(s.root, { recursive: true, force: true });
        await rm(victim.root, { recursive: true, force: true });
      }
    }
  });

  test("the last window (v5 swapped for another slot's v5 between the look and the rename): what arrived is put straight back; the other slot is untouched", async () => {
    const s = await scratch();
    const victim = await scratch(4);
    try {
      const before = await listing(victim.root);
      const failed = await outcome(
        async () =>
          await resetV5(s.paths, s.real, actionsFor(s.paths).actions, {
            ...options,
            hooks: { beforeMove: async name => (name === 'home' ? await swapV5(s, victim) : undefined) },
          }),
      );
      expect(failed).toBeInstanceOf(ResetRefusal);
      expect(failed?.message).toMatch(/was replaced while it was being moved aside/u);
      expect(await listing(victim.root)).toEqual(before);
      await marked(victim);
      expect(await exists(join(victim.root, 'kept'))).toBe(false);
      expect(await readdir(join(await realpath(s.root), 'kept'))).toEqual([]);
      expect(await exists(join(`${s.paths.v5Dir}.original`, 'home', 'state', 'conversation-fixture.json'))).toBe(true);
    } finally {
      await rm(s.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('the same window on the user folder, after home moved: home goes back, nothing of the other slot moves', async () => {
    const s = await scratch();
    const victim = await scratch(4);
    try {
      const before = await listing(victim.root);
      const homeDigest = await digest(s.paths.home);
      const failed = await outcome(
        async () =>
          await resetV5(s.paths, s.real, actionsFor(s.paths).actions, {
            ...options,
            hooks: {
              beforeMove: async name => {
                if (name === 'user') await rename(s.paths.user, join(s.root, 'user-away'));
                if (name === 'user') await symlink(victim.paths.user, s.paths.user);
              },
            },
          }),
      );
      expect(failed).toBeInstanceOf(ResetRefusal);
      expect(await listing(victim.root)).toEqual(before);
      await marked(victim);
      expect(await digest(s.paths.home)).toBe(homeDigest);
      expect(await readdir(join(await realpath(s.root), 'kept'))).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('the new home cannot be made (a folder-shaped thing was put in its place): the old home is whole in kept/<stamp>, and restore-v5 puts it back with no current home', async () => {
    const s = await scratch();
    try {
      const homeDigest = await digest(s.paths.home);
      const userDigest = await digest(s.paths.user);
      const trace = actionsFor(s.paths);
      const planting: ResetActions = {
        ...trace.actions,
        say: () => void symlink('/nonexistent-outside/home', s.paths.home),
      };
      const failed = await outcome(async () => await resetV5(s.paths, s.real, planting, options));
      expect(failed).toBeInstanceOf(ResetHalfway);
      expect(failed?.message).toContain(`restore-v5 ${STAMP}`);
      expect(trace.steps).toEqual(['stop (old home present: true)', 'installBuild']);
      expect(await digest(join(keptOf(s), 'home'))).toBe(homeDigest);
      expect(await digest(join(keptOf(s), 'user'))).toBe(userDigest);
      // The thing in the way is gone; the owner restores. There is no current home and no current user folder.
      await rm(s.paths.home);
      const restoring = actionsFor(s.paths);
      await restoreV5(s.paths, restoring.actions, STAMP, LATER);
      expect(restoring.steps).toEqual(['stop (old home present: false)', 'start']);
      expect(await digest(s.paths.home)).toBe(homeDigest);
      expect(await digest(s.paths.user)).toBe(userDigest);
      await noTar(s.root);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a stamp folder that already exists is never reused: nothing is moved', async () => {
    const s = await scratch();
    try {
      await mkdir(keptOf(s), { recursive: true });
      const homeDigest = await digest(s.paths.home);
      await expect(resetV5(s.paths, s.real, actionsFor(s.paths).actions, options)).rejects.toThrow(/already exists/u);
      expect(await digest(s.paths.home)).toBe(homeDigest);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });
});

// ─── H1: the build installer and the bind pin write only into folders just proven to be this slot's own ─────────────────

describe('installPrograms and writeBindPin: nothing is written through a link', () => {
  const libexecOf = async (s: Scratch): Promise<string> => {
    const libexec = join(s.root, 'libexec');
    await mkdir(libexec);
    for (const name of ['fy', 'fyd', 'BUILD.json']) await writeFile(join(libexec, name), `new ${name}\n`);
    return libexec;
  };
  const NAMES = ['fy', 'fyd', 'BUILD.json'];

  test('installs: the old program is kept as <name>.prev, new ones are 0755 (the stamp 0644), no temp or link left', async () => {
    const s = await scratch();
    try {
      const libexec = await libexecOf(s);
      await installPrograms(s.paths, libexec, NAMES, 'BUILD.json');
      await installPrograms(s.paths, libexec, NAMES, 'BUILD.json');
      expect((await readdir(s.paths.bin)).sort()).toEqual([
        'BUILD.json',
        'BUILD.json.prev',
        'fy',
        'fy.prev',
        'fyd',
        'fyd.prev',
      ]);
      expect(await readFile(join(s.paths.bin, 'fyd'), 'utf8')).toBe('new fyd\n');
      expect(await readFile(join(s.paths.bin, 'fyd.prev'), 'utf8')).toBe('new fyd\n');
      expect(await mode(join(s.paths.bin, 'fyd'))).toBe('755');
      expect(await mode(join(s.paths.bin, 'BUILD.json'))).toBe('644');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a v5/bin that is a link to another slot is refused: nothing is removed, renamed or written there', async () => {
    const s = await scratch();
    const victim = await scratch(4);
    try {
      const libexec = await libexecOf(s);
      await rename(s.paths.bin, `${s.paths.bin}.real`);
      await symlink(victim.paths.bin, s.paths.bin);
      const before = await listing(victim.root);
      await expect(installPrograms(s.paths, libexec, NAMES, 'BUILD.json')).rejects.toThrow(/not a plain folder/u);
      expect(await listing(victim.root)).toEqual(before);
      expect(await readFile(join(victim.paths.bin, 'fyd'), 'utf8')).toBe('program\n');
    } finally {
      await rm(s.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });

  test('a program name that is a link, or a .prev that is a folder, is refused; the link target is never written', async () => {
    const s = await scratch();
    try {
      const libexec = await libexecOf(s);
      const outside = join(s.root, 'outside-file');
      await writeFile(outside, 'EXTERNAL');
      await rm(join(s.paths.bin, 'fyd'));
      await symlink(outside, join(s.paths.bin, 'fyd'));
      await expect(installPrograms(s.paths, libexec, NAMES, 'BUILD.json')).rejects.toThrow(/is not a plain file/u);
      expect(await readFile(outside, 'utf8')).toBe('EXTERNAL');
      await rm(join(s.paths.bin, 'fyd'));
      await writeFile(join(s.paths.bin, 'fyd'), 'program\n');
      await mkdir(join(s.paths.bin, 'fyd.prev'));
      await expect(installPrograms(s.paths, libexec, NAMES, 'BUILD.json')).rejects.toThrow(/is a folder/u);
      expect(await readFile(join(s.paths.bin, 'fyd'), 'utf8')).toBe('program\n');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('a link planted at the exact name between the rename and the create is never followed (exclusive create)', async () => {
    const s = await scratch();
    try {
      const libexec = await libexecOf(s);
      const outside = join(s.root, 'outside-file');
      await writeFile(outside, 'EXTERNAL');
      // The program does not exist yet, and a link sits where it will be created.
      await rm(join(s.paths.bin, 'fyd'));
      await symlink(outside, join(s.paths.bin, 'fyd'));
      await expect(installPrograms(s.paths, libexec, ['fyd'], 'BUILD.json')).rejects.toThrow(/not a plain file/u);
      expect(await readFile(outside, 'utf8')).toBe('EXTERNAL');
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('writeBindPin on an empty home writes ONLY config/daemon.json (0600, via a temp file renamed in): one bind carrier on 127.0.0.1 and the slot port', async () => {
    const s = await scratch();
    try {
      await resetV5(s.paths, s.real, actionsFor(s.paths).actions, options);
      expect(await homeFiles(s.paths.home)).toEqual([]);
      await writeBindPin(s.paths, s.paths.port);
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

  test('writeBindPin merges into what the daemon wrote: other carriers and keys stay, an old bind is replaced, a non-object is not trusted, broken JSON is refused', async () => {
    const s = await scratch();
    try {
      const file = join(s.paths.home, 'config', 'daemon.json');
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
      await writeBindPin(s.paths, 7619);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        name: 'kept',
        carriers: [
          { kind: 'bind', host: '127.0.0.1', port: 7619 },
          { kind: 'relay', url: 'x' },
        ],
      });
      await writeFile(file, '[1,2]');
      await writeBindPin(s.paths, 7619);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        carriers: [{ kind: 'bind', host: '127.0.0.1', port: 7619 }],
      });
      await writeFile(file, '{"broken');
      await expect(writeBindPin(s.paths, 7619)).rejects.toThrow(/not valid JSON/u);
      expect(await readFile(file, 'utf8')).toBe('{"broken');
      expect((await readdir(join(s.paths.home, 'config'))).filter(name => name.includes('tmp'))).toEqual([]);
    } finally {
      await rm(s.root, { recursive: true, force: true });
    }
  });

  test('writeBindPin refuses a daemon.json that is a link, a config folder that is a link and a home that is a link: the external files are never written', async () => {
    const s = await scratch();
    const victim = await scratch(4);
    try {
      const external = join(victim.root, 'external.json');
      await writeFile(external, '{"EXTERNAL":true}');
      const file = join(s.paths.home, 'config', 'daemon.json');
      await rm(file);
      await symlink(external, file);
      await expect(writeBindPin(s.paths, 7619)).rejects.toThrow(/not a plain file/u);
      expect(await readFile(external, 'utf8')).toBe('{"EXTERNAL":true}');
      await rm(file);
      const before = await listing(victim.root);
      await rename(join(s.paths.home, 'config'), join(s.root, 'config-away'));
      await symlink(join(victim.paths.home, 'config'), join(s.paths.home, 'config'));
      await expect(writeBindPin(s.paths, 7619)).rejects.toThrow(/not a plain folder/u);
      expect(await listing(victim.root)).toEqual(before);
      await rm(join(s.paths.home, 'config'));
      await rename(s.paths.home, join(s.root, 'home-away'));
      await symlink(victim.paths.home, s.paths.home);
      await expect(writeBindPin(s.paths, 7619)).rejects.toThrow(/not a plain folder/u);
      expect(await listing(victim.root)).toEqual(before);
      expect(await readFile(join(victim.paths.home, 'config', 'daemon.json'), 'utf8')).toContain('OLD');
    } finally {
      await rm(s.root, { recursive: true, force: true });
      await rm(victim.root, { recursive: true, force: true });
    }
  });
});
