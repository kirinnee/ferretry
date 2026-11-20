import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FAKE_NAME,
  RECORD_FILE,
  Refusal,
  SHIM_MARKER,
  disableReal,
  enableReal,
  isShim,
  loginFileProblem,
  loginNameProblem,
  parseRecord,
  readRecord,
  recordText,
  runtimesUsing,
  shimText,
  statusLine,
  storePathOf,
  topLevelValue,
  type RealPaths,
} from '../../fixtures/sweep/real-claude.ts';
import { KIT_FILES } from '../../fixtures/sweep/persist.ts';

const LOGIN_YAML = 'harness: claude-code\nstore: ferretry\n';

/** A scratch slot: a v5 folder with a fake claude, a 5.0 home with one login and its store, and a STUB "real" claude. Never the real one. */
async function scratch(): Promise<{ root: string; paths: RealPaths; stub: string; store: string }> {
  const root = await mkdtemp(join(tmpdir(), 'a562-'));
  const v5Dir = join(root, 'v5');
  const harness = join(v5Dir, 'harness-bin');
  const fyHome = join(v5Dir, 'home');
  await mkdir(harness, { recursive: true });
  await mkdir(join(fyHome, 'config', 'logins'), { recursive: true });
  await writeFile(join(harness, 'claude'), '#!/bin/sh\necho FAKE "$@"\n', { mode: 0o755 });
  await writeFile(join(fyHome, 'config', 'logins', 'claude-real.yaml'), LOGIN_YAML);
  const store = storePathOf(fyHome, 'claude-real');
  await mkdir(store, { recursive: true, mode: 0o755 });
  const stub = join(root, 'stub-claude');
  await writeFile(stub, '#!/bin/sh\necho "REAL auto=$DISABLE_AUTOUPDATER $*"\n', { mode: 0o755 });
  return { root, paths: { v5Dir, fyHome, harness }, stub, store };
}

const noRoot = { root: async () => ({ link: undefined }) };
const idle = { liveFerrets: async () => undefined };

async function runShim(shim: string, args: string[], env: Record<string, string>): Promise<string> {
  const child = Bun.spawn([shim, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out.trim();
}

describe('the shim', () => {
  test('real only for the exact store; the fake for everything else; --version/-v always real; autoupdater off', async () => {
    const { root, paths, stub, store } = await scratch();
    try {
      await enableReal(paths, 'claude-real', stub, noRoot);
      const shim = join(paths.harness, 'claude');
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe('REAL auto=1 hi');
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${store}/` })).toBe('FAKE hi');
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${store}-2` })).toBe('FAKE hi');
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' })).toBe('FAKE hi');
      expect(await runShim(shim, ['hi'], {})).toBe('FAKE hi');
      expect(await runShim(shim, ['--version'], {})).toBe('REAL auto=1 --version');
      expect(await runShim(shim, ['-v'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/elsewhere' })).toBe('REAL auto=1 -v');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('on a persisted (symlinked) slot: the real claude for the store the daemon hands it (its logical path), the fake otherwise; the shim is unchanged by the link', async () => {
    const { root, paths, stub } = await scratch();
    try {
      // The logical FY_HOME is a link to a persistent folder, as the live slot's is.
      const persistent = join(root, 'persistent-home');
      await rename(paths.fyHome, persistent);
      await symlink(persistent, paths.fyHome);
      const logicalStore = storePathOf(paths.fyHome, 'claude-real');
      const realStore = storePathOf(await realpath(paths.fyHome), 'claude-real');
      expect(realStore).not.toBe(logicalStore);
      await enableReal(paths, 'claude-real', stub, noRoot);
      const shim = join(paths.harness, 'claude');
      // 5.0 builds CLAUDE_SECURESTORAGE_CONFIG_DIR from the daemon's own FY_HOME (the logical path): that matches.
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: logicalStore })).toBe('REAL auto=1 hi');
      // Claude's value is an environment string, never a link target, so it stays an exact match (no second spelling).
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: realStore })).toBe('FAKE hi');
      expect(await readFile(shim, 'utf8')).not.toContain(realStore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a store path with glob characters or quotes is matched literally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a562-'));
    try {
      const real = join(root, 'real');
      const fake = join(root, 'fake');
      await writeFile(real, '#!/bin/sh\necho REAL\n', { mode: 0o755 });
      await writeFile(fake, '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
      const store = "/s/*/it's [a]?";
      const shim = join(root, 'claude');
      await writeFile(shim, shimText({ fake, real, store }), { mode: 0o755 });
      expect(await runShim(shim, ['x'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe('REAL');
      expect(await runShim(shim, ['x'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/s/abc/it's a?" })).toBe('FAKE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('is recognisable, and refuses a relative path or a newline in one', () => {
    const text = shimText({ fake: '/f', real: '/r', store: '/s' });
    expect(isShim(text)).toBe(true);
    expect(text.split('\n')[1]).toBe(SHIM_MARKER);
    expect(isShim('#!/bin/sh\necho fake\n')).toBe(false);
    expect(() => shimText({ fake: 'f', real: '/r', store: '/s' })).toThrow();
    expect(() => shimText({ fake: '/f', real: '/r\n', store: '/s' })).toThrow();
  });
});

describe('pure helpers', () => {
  test('login names', () => {
    expect(loginNameProblem('claude-real')).toBeUndefined();
    for (const bad of [undefined, '', '../x', 'a/b', '-x', 'a..b', 'a b']) expect(loginNameProblem(bad)).toBeDefined();
  });

  test('the login file must be claude-code + ferretry', () => {
    expect(loginFileProblem('l', LOGIN_YAML)).toBeUndefined();
    expect(loginFileProblem('l', 'harness: "claude-code"  # c\nstore: ferretry\n')).toBeUndefined();
    expect(loginFileProblem('l', 'harness: codex\nstore: ferretry\n')).toContain('not claude-code');
    expect(loginFileProblem('l', 'harness: claude-code\nstore: host\n')).toContain('not ferretry');
    expect(loginFileProblem('l', '  harness: claude-code\n  store: ferretry\n')).toContain('(none)');
    expect(topLevelValue('a: 1\nb: two # note\n', 'b')).toBe('two');
  });

  test('the record round-trips and rejects anything else', () => {
    const record = { login: 'l', store: '/s', binary: '/b', rootedAt: null };
    expect(parseRecord(recordText(record))).toEqual(record);
    expect(parseRecord('nope')).toBeUndefined();
    expect(parseRecord('{"login":"l"}')).toBeUndefined();
    expect(parseRecord('[]')).toBeUndefined();
  });

  test('runtimes using a login, by name only', () => {
    const files = new Map([
      ['a.yaml', 'login: claude-real\nprofile: p\n'],
      ['b.yaml', 'login: other\n'],
      ['c.yml', "login: 'claude-real'\n"],
    ]);
    expect(runtimesUsing('claude-real', files)).toEqual(['a', 'c']);
  });

  test('the status line', () => {
    expect(statusLine(undefined)).toContain('off');
    const on = statusLine({ login: 'l', store: '/s', binary: '/b', rootedAt: null });
    expect(on).toBe('real claude: on for login l (/b)');
    expect(statusLine({ login: 'l', store: '/s', binary: '/b', rootedAt: null }, 'shim-missing')).toContain('WARNING');
  });

  test('the kit copy carries this file', () => {
    expect(KIT_FILES).toContain('real-claude.ts');
  });
});

describe('enableReal', () => {
  test('puts the shim in, keeps the fake, makes the store 0700, writes the record (names and paths only)', async () => {
    const { root, paths, stub, store } = await scratch();
    try {
      await writeFile(join(store, 'inside'), 'MUST-NOT-BE-READ');
      const { record } = await enableReal(paths, 'claude-real', stub, {
        root: async path => ({ link: `${root}/gcroots/${path.length}` }),
      });
      expect(record).toEqual({ login: 'claude-real', store, binary: stub, rootedAt: `${root}/gcroots/${stub.length}` });
      expect(await readRecord(paths)).toEqual(record);
      expect(isShim(await readFile(join(paths.harness, 'claude'), 'utf8'))).toBe(true);
      expect(await readFile(join(paths.harness, FAKE_NAME), 'utf8')).toContain('echo FAKE');
      expect(((await lstat(store)).mode & 0o777).toString(8)).toBe('700');
      expect(JSON.stringify(record)).not.toContain('MUST-NOT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the same login again re-points (the fake is kept once); a second login is refused', async () => {
    const { root, paths, stub } = await scratch();
    try {
      await enableReal(paths, 'claude-real', stub, noRoot);
      const other = join(root, 'stub2');
      await writeFile(other, '#!/bin/sh\necho REAL2\n', { mode: 0o755 });
      await enableReal(paths, 'claude-real', other, noRoot);
      expect((await readRecord(paths))?.binary).toBe(other);
      expect(await readFile(join(paths.harness, FAKE_NAME), 'utf8')).toContain('echo FAKE');
      await writeFile(join(paths.fyHome, 'config', 'logins', 'second.yaml'), LOGIN_YAML);
      await mkdir(storePathOf(paths.fyHome, 'second'), { recursive: true });
      await expect(enableReal(paths, 'second', stub, noRoot)).rejects.toThrow(/already on for login claude-real/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a missing login, a wrong login file, a linked / file store; changes nothing', async () => {
    const { root, paths, stub, store } = await scratch();
    const before = async (): Promise<string[]> => await readdir(paths.harness);
    try {
      const names = await before();
      await expect(enableReal(paths, 'nope', stub, noRoot)).rejects.toThrow(Refusal);
      await expect(enableReal(paths, undefined, stub, noRoot)).rejects.toThrow(Refusal);
      await writeFile(join(paths.fyHome, 'config', 'logins', 'host.yaml'), 'harness: claude-code\nstore: host\n');
      await mkdir(storePathOf(paths.fyHome, 'host'), { recursive: true });
      await expect(enableReal(paths, 'host', stub, noRoot)).rejects.toThrow(/not ferretry/u);
      await writeFile(join(paths.fyHome, 'config', 'logins', 'nostore.yaml'), LOGIN_YAML);
      await writeFile(join(paths.fyHome, 'config', 'logins', 'link.yaml'), LOGIN_YAML);
      await symlink(store, storePathOf(paths.fyHome, 'link'));
      await expect(enableReal(paths, 'link', stub, noRoot)).rejects.toThrow(/symbolic link/u);
      await writeFile(join(paths.fyHome, 'config', 'logins', 'file.yaml'), LOGIN_YAML);
      await writeFile(storePathOf(paths.fyHome, 'file'), 'x');
      await expect(enableReal(paths, 'file', stub, noRoot)).rejects.toThrow(/not a folder/u);
      expect(await before()).toEqual(names);
      expect(await readRecord(paths)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a login that was added but not signed in yet (no store folder) is accepted; no folder is made; the real binary runs once 5.0 makes the store', async () => {
    const { root, paths, stub } = await scratch();
    try {
      await writeFile(join(paths.fyHome, 'config', 'logins', 'fresh.yaml'), LOGIN_YAML);
      const store = storePathOf(paths.fyHome, 'fresh');
      expect(await lstat(store).catch(() => undefined)).toBeUndefined();
      const { record } = await enableReal(paths, 'fresh', stub, noRoot);
      expect(record.store).toBe(store);
      expect(await lstat(store).catch(() => undefined)).toBeUndefined();
      expect(isShim(await readFile(join(paths.harness, 'claude'), 'utf8'))).toBe(true);
      // sign-in: 5.0 creates the store, then runs claude with it
      await mkdir(store, { recursive: true, mode: 0o700 });
      expect(await runShim(join(paths.harness, 'claude'), ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe(
        'REAL auto=1 hi',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a real binary that is inside the harness folder even when the slot path goes through a link', async () => {
    const { root, paths } = await scratch();
    try {
      const linked = join(root, 'linked-v5');
      await symlink(paths.v5Dir, linked);
      const viaLink: RealPaths = {
        v5Dir: linked,
        fyHome: join(linked, 'home'),
        harness: join(linked, 'harness-bin'),
      };
      await expect(enableReal(viaLink, 'claude-real', join(paths.harness, 'claude'), noRoot)).rejects.toThrow(
        /inside the slot's harness-bin/u,
      );
      expect(isShim(await readFile(join(paths.harness, 'claude'), 'utf8'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a shim marker is found in a large binary by its head only', async () => {
    const { root, paths } = await scratch();
    try {
      const big = join(root, 'big-shim');
      await writeFile(big, shimText({ fake: '/f', real: '/r', store: '/s' }) + 'x'.repeat(5_000_000), { mode: 0o755 });
      await expect(enableReal(paths, 'claude-real', big, noRoot)).rejects.toThrow(/shim/u);
      // a marker far past the head is not looked for (it is not a shim)
      const late = join(root, 'late');
      await writeFile(late, '#!/bin/sh\n' + 'x'.repeat(1000) + SHIM_MARKER + '\n', { mode: 0o755 });
      await enableReal(paths, 'claude-real', late, noRoot);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a real binary that is relative, missing, not executable, the fake, or a shim', async () => {
    const { root, paths, stub } = await scratch();
    try {
      await expect(enableReal(paths, 'claude-real', 'claude', noRoot)).rejects.toThrow(/absolute/u);
      await expect(enableReal(paths, 'claude-real', join(root, 'missing'), noRoot)).rejects.toThrow(/does not exist/u);
      const plain = join(root, 'plain');
      await writeFile(plain, 'x', { mode: 0o644 });
      await expect(enableReal(paths, 'claude-real', plain, noRoot)).rejects.toThrow(/not an executable/u);
      await expect(enableReal(paths, 'claude-real', join(paths.harness, 'claude'), noRoot)).rejects.toThrow(/fake/u);
      const copy = join(root, 'shimcopy');
      await writeFile(copy, shimText({ fake: '/f', real: stub, store: '/s' }), { mode: 0o755 });
      await expect(enableReal(paths, 'claude-real', copy, noRoot)).rejects.toThrow(/shim/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('disableReal', () => {
  test('puts the fake back exactly, removes the record, leaves the login and its store alone', async () => {
    const { root, paths, stub, store } = await scratch();
    try {
      const original = await readFile(join(paths.harness, 'claude'), 'utf8');
      await writeFile(join(store, 'inside'), 'kept');
      await enableReal(paths, 'claude-real', stub, noRoot);
      const { was } = await disableReal(paths, idle, { force: false });
      expect(was?.login).toBe('claude-real');
      expect(await readFile(join(paths.harness, 'claude'), 'utf8')).toBe(original);
      expect(((await lstat(join(paths.harness, 'claude'))).mode & 0o777).toString(8)).toBe('755');
      expect(await lstat(join(paths.harness, FAKE_NAME)).catch(() => undefined)).toBeUndefined();
      expect(await lstat(join(paths.v5Dir, RECORD_FILE)).catch(() => undefined)).toBeUndefined();
      expect(await readFile(join(store, 'inside'), 'utf8')).toBe('kept');
      expect(await readFile(join(paths.fyHome, 'config', 'logins', 'claude-real.yaml'), 'utf8')).toBe(LOGIN_YAML);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('off twice is a no-op; a live ferret refuses unless forced; a shim with no record is not guessed at', async () => {
    const { root, paths, stub } = await scratch();
    try {
      expect((await disableReal(paths, idle, { force: false })).was).toBeUndefined();
      await enableReal(paths, 'claude-real', stub, noRoot);
      const busy = { liveFerrets: async () => 'a ferret still runs on runtime r' };
      await expect(disableReal(paths, busy, { force: false })).rejects.toThrow(/still runs/u);
      expect(await readRecord(paths)).toBeDefined();
      expect(isShim(await readFile(join(paths.harness, 'claude'), 'utf8'))).toBe(true);
      await rm(join(paths.v5Dir, RECORD_FILE));
      await expect(disableReal(paths, idle, { force: false })).rejects.toThrow(/no real-claude.json/u);
      await writeFile(
        join(paths.v5Dir, RECORD_FILE),
        recordText({ login: 'claude-real', store: 'x', binary: stub, rootedAt: null }),
      );
      expect((await disableReal(paths, busy, { force: true })).was?.login).toBe('claude-real');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('removes only its own GC root link', async () => {
    const { root, paths, stub } = await scratch();
    try {
      const folder = join(root, 'gcroots');
      await mkdir(folder);
      const binary = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-claude-code-9/bin/claude';
      const link = join(folder, '0123456789abcdfghijklmnpqrsvwxyz-claude-code-9');
      await symlink('/nonexistent', link);
      await enableReal(paths, 'claude-real', stub, noRoot);
      await writeFile(
        join(paths.v5Dir, RECORD_FILE),
        recordText({ login: 'claude-real', store: 'x', binary, rootedAt: link }),
      );
      await disableReal(paths, idle, { force: false });
      expect(await lstat(link).catch(() => undefined)).toBeUndefined();
      // a record naming a root that is not that store path's link is left alone
      const other = join(folder, 'something-else');
      await writeFile(other, 'x');
      await enableReal(paths, 'claude-real', stub, noRoot);
      await writeFile(
        join(paths.v5Dir, RECORD_FILE),
        recordText({ login: 'claude-real', store: 'x', binary, rootedAt: other }),
      );
      await disableReal(paths, idle, { force: false });
      expect(await lstat(other).catch(() => undefined)).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
