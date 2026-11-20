import { describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_TOOL,
  CODEX_TOOL,
  disableReal,
  enableReal,
  isShim,
  loginFileProblem,
  readRecord,
  recordText,
  shimText,
  statusLine,
  storePathOf,
  type RealPaths,
} from '../../fixtures/sweep/real-claude.ts';
import { realCodexPreflight } from '../../fixtures/sweep/reset.ts';

const CODEX_YAML = 'harness: codex\nstore: ferretry\n';
const CLAUDE_YAML = 'harness: claude-code\nstore: ferretry\n';

/** A scratch slot: fake claude AND fake codex, a 5.0 home with a codex login (+ its store), and STUB "real" binaries. Never the real ones. */
async function scratch(): Promise<{
  root: string;
  paths: RealPaths;
  stub: string;
  store: string;
  ferretHome: (name: string, linkTo: string | undefined) => Promise<string>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rc58-'));
  const v5Dir = join(root, 'v5');
  const harness = join(v5Dir, 'harness-bin');
  const fyHome = join(v5Dir, 'home');
  await mkdir(harness, { recursive: true });
  await mkdir(join(fyHome, 'config', 'logins'), { recursive: true });
  await writeFile(join(harness, 'claude'), '#!/bin/sh\necho FAKE-CLAUDE "$@"\n', { mode: 0o755 });
  await writeFile(join(harness, 'codex'), '#!/bin/sh\necho FAKE-CODEX "$@"\n', { mode: 0o755 });
  await writeFile(join(fyHome, 'config', 'logins', 'codex-real.yaml'), CODEX_YAML);
  const store = storePathOf(fyHome, 'codex-real');
  await mkdir(store, { recursive: true, mode: 0o755 });
  const stub = join(root, 'stub-codex');
  await writeFile(stub, '#!/bin/sh\necho "REAL-CODEX home=$CODEX_HOME $*"\n', { mode: 0o755 });
  // A ferret's own home under state/codex/agent-homes: an auth.json that is a link (as the runtime wrapper makes it), or no link.
  const ferretHome = async (name: string, linkTo: string | undefined): Promise<string> => {
    const home = join(fyHome, 'state', 'codex', 'agent-homes', name);
    await mkdir(home, { recursive: true });
    if (linkTo !== undefined) await symlink(linkTo, join(home, 'auth.json'));
    return home;
  };
  return { root, paths: { v5Dir, fyHome, harness }, stub, store, ferretHome };
}

const noRoot = { root: async () => ({ link: undefined }) };
const idle = { liveFerrets: async () => undefined };

async function runShim(shim: string, args: string[], env: Record<string, string>): Promise<string> {
  const child = Bun.spawn([shim, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out.trim();
}

describe('the codex shim on a persisted (symlinked) slot', () => {
  test('a ferret whose auth.json link is the REAL path of the store (as the 5.0 kernel writes it) or the logical one gets the real codex; nothing else does', async () => {
    const { root, paths, stub, ferretHome } = await scratch();
    try {
      // A persisted slot: the logical FY_HOME is a link to a persistent folder, as /tmp/.../slot8/... is on the live slot.
      const persistent = join(root, 'persistent-home');
      await rename(paths.fyHome, persistent);
      await symlink(persistent, paths.fyHome);
      const logicalStore = storePathOf(paths.fyHome, 'codex-real');
      const realStore = storePathOf(await realpath(paths.fyHome), 'codex-real');
      expect(realStore).not.toBe(logicalStore);

      const { record } = await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      expect(record.store).toBe(logicalStore); // the record and the sign-in match stay the logical spelling
      const shim = join(paths.harness, 'codex');
      const shimSource = await readFile(shim, 'utf8');
      expect(shimSource).toContain(join(realStore, 'auth.json'));

      // the sign-in / token refresh hand the logical store as CODEX_HOME
      expect(await runShim(shim, ['login'], { CODEX_HOME: logicalStore })).toBe(
        `REAL-CODEX home=${logicalStore} login`,
      );
      // a ferret whose link was written with the real path (the 5.0 kernel) and one with the logical path
      const byReal = await ferretHome('by-real', join(realStore, 'auth.json'));
      expect(await runShim(shim, ['hi'], { CODEX_HOME: byReal })).toBe(`REAL-CODEX home=${byReal} hi`);
      const byLogical = await ferretHome('by-logical', join(logicalStore, 'auth.json'));
      expect(await runShim(shim, ['hi'], { CODEX_HOME: byLogical })).toBe(`REAL-CODEX home=${byLogical} hi`);
      // exact only: another login's real path, a prefix/suffix near miss, a trailing slash, a dot-dot spelling
      for (const [name, target] of [
        ['other-login', join(await realpath(paths.fyHome), 'state', 'logins', 'credentials', 'x', 'auth.json')],
        ['suffix', `${join(realStore, 'auth.json')}.bak`],
        ['sub', join(realStore, 'sub', 'auth.json')],
        ['dotdot', `${realStore}/../codex-real/auth.json`],
      ] as const) {
        const home = await ferretHome(name, target);
        expect(await runShim(shim, ['hi'], { CODEX_HOME: home })).toBe('FAKE-CODEX hi');
      }
      // the real path as CODEX_HOME itself is NOT the logical store string: only the link target gets the two spellings
      expect(await runShim(shim, ['hi'], { CODEX_HOME: realStore })).toBe('FAKE-CODEX hi');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('on records a version line and refuses a binary that does not say codex (or does not run)', async () => {
    const { root, paths, stub } = await scratch();
    try {
      const ok = await enableReal(
        paths,
        'codex-real',
        stub,
        { ...noRoot, version: async () => 'codex-cli 0.9.9' },
        CODEX_TOOL,
      );
      expect(ok.notes.some(line => line.includes('--version: codex-cli 0.9.9'))).toBe(true);
      await disableReal(paths, idle, { force: false }, CODEX_TOOL);
      const before = await readFile(join(paths.harness, 'codex'), 'utf8');
      await expect(
        enableReal(paths, 'codex-real', stub, { ...noRoot, version: async () => 'node v20' }, CODEX_TOOL),
      ).rejects.toThrow(/does not name codex/u);
      await expect(
        enableReal(paths, 'codex-real', stub, { ...noRoot, version: async () => undefined }, CODEX_TOOL),
      ).rejects.toThrow(/did not run/u);
      expect(await readFile(join(paths.harness, 'codex'), 'utf8')).toBe(before);
      expect(await lstat(join(paths.v5Dir, 'real-codex.json')).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the codex shim', () => {
  test('real for the exact store (the sign-in) and for a ferret home linked to that store; the fake for everyone else', async () => {
    const { root, paths, stub, store, ferretHome } = await scratch();
    try {
      await writeFile(join(store, 'auth.json'), 'MUST-NOT-BE-READ');
      await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      const shim = join(paths.harness, 'codex');
      // the sign-in: CODEX_HOME is the login's store
      expect(await runShim(shim, ['login'], { CODEX_HOME: store })).toBe(`REAL-CODEX home=${store} login`);
      // a ferret on a runtime of that login: its home's auth.json is a link to <store>/auth.json
      const mine = await ferretHome('mine', join(store, 'auth.json'));
      expect(await runShim(shim, ['hi'], { CODEX_HOME: mine })).toBe(`REAL-CODEX home=${mine} hi`);
      // a ferret of ANOTHER login (its link points elsewhere), a home with no link, a home whose auth.json is a plain file
      const other = await ferretHome(
        'other',
        join(root, 'v5', 'home', 'state', 'logins', 'credentials', 'x', 'auth.json'),
      );
      expect(await runShim(shim, ['hi'], { CODEX_HOME: other })).toBe('FAKE-CODEX hi');
      const bare = await ferretHome('bare', undefined);
      expect(await runShim(shim, ['hi'], { CODEX_HOME: bare })).toBe('FAKE-CODEX hi');
      const plain = await ferretHome('plain', undefined);
      await writeFile(join(plain, 'auth.json'), 'not a link');
      expect(await runShim(shim, ['hi'], { CODEX_HOME: plain })).toBe('FAKE-CODEX hi');
      // near misses of the store, unset, empty
      for (const home of [`${store}/`, `${store}-2`, `${store}/sub`, '']) {
        expect(await runShim(shim, ['hi'], { CODEX_HOME: home })).toBe('FAKE-CODEX hi');
      }
      expect(await runShim(shim, ['hi'], {})).toBe('FAKE-CODEX hi');
      // the claude variable means nothing to it
      expect(await runShim(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe('FAKE-CODEX hi');
      // --version / -V always reach the real binary
      // ...but in a THROWAWAY home (never the caller's, never unset), removed afterwards
      const scratchTmp = join(root, 'tmp');
      await mkdir(scratchTmp);
      expect(await runShim(shim, ['--version'], { TMPDIR: scratchTmp })).toMatch(
        /^REAL-CODEX home=\/\S+\/tmp\.\S+ --version$/u,
      );
      expect(await runShim(shim, ['-V'], { CODEX_HOME: '/elsewhere', TMPDIR: scratchTmp })).toMatch(
        /^REAL-CODEX home=\/\S+\/tmp\.\S+ -V$/u,
      );
      expect(await runShim(shim, ['-V'], { CODEX_HOME: '/elsewhere', TMPDIR: scratchTmp })).not.toContain('/elsewhere');
      expect(await readdir(scratchTmp)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a store path with glob characters or quotes is matched literally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rc58-'));
    try {
      const real = join(root, 'real');
      const fake = join(root, 'fake');
      await writeFile(real, '#!/bin/sh\necho REAL\n', { mode: 0o755 });
      await writeFile(fake, '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
      const store = "/s/*/it's [a]?";
      const shim = join(root, 'codex');
      await writeFile(shim, shimText({ fake, real, store }, CODEX_TOOL), { mode: 0o755 });
      expect(await runShim(shim, ['x'], { CODEX_HOME: store })).toBe('REAL');
      expect(await runShim(shim, ['x'], { CODEX_HOME: "/s/abc/it's a?" })).toBe('FAKE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('is recognisable as codex only, and refuses a relative path or a newline in one', () => {
    const text = shimText({ fake: '/f', real: '/r', store: '/s' }, CODEX_TOOL);
    expect(isShim(text, CODEX_TOOL)).toBe(true);
    expect(isShim(text)).toBe(false);
    expect(text.split('\n')[1]).toBe(CODEX_TOOL.marker);
    expect(() => shimText({ fake: 'f', real: '/r', store: '/s' }, CODEX_TOOL)).toThrow();
    expect(() => shimText({ fake: '/f', real: '/r\n', store: '/s' }, CODEX_TOOL)).toThrow();
    // it never opens a credential: the only reads are a path compare and `readlink`
    expect(text).not.toMatch(/\bcat\b|<\s*"?\$CODEX_HOME/u);
  });
});

describe('claude is unchanged', () => {
  test('the claude shim text is byte-for-byte what it was', () => {
    expect(shimText({ fake: '/f', real: '/r', store: '/s' })).toBe(
      [
        '#!/bin/sh',
        '# fy-sweep real-claude shim',
        '# Real claude ONLY for the one login store below; every other caller gets the fake. Written by `slot.ts real-claude`.',
        'case "${1-}" in',
        '  --version|-v) exec env DISABLE_AUTOUPDATER=1 \'/r\' "$@" ;;',
        'esac',
        'case "${CLAUDE_SECURESTORAGE_CONFIG_DIR-}" in',
        "  '/s') exec env DISABLE_AUTOUPDATER=1 '/r' \"$@\" ;;",
        'esac',
        'exec \'/f\' "$@"',
        '',
      ].join('\n'),
    );
    expect(shimText({ fake: '/f', real: '/r', store: '/s' })).toBe(
      shimText({ fake: '/f', real: '/r', store: '/s' }, CLAUDE_TOOL),
    );
  });

  test('the claude status lines and files keep their names', () => {
    expect(statusLine(undefined)).toBe('real claude: off (every claude is the fake)');
    expect(statusLine({ login: 'l', store: '/s', binary: '/b', rootedAt: null }, 'shim-missing')).toBe(
      'real claude: on for login l (/b)  WARNING: harness-bin/claude is not the shim any more; run real-claude on again',
    );
    expect([CLAUDE_TOOL.recordFile, CLAUDE_TOOL.fakeName]).toEqual(['real-claude.json', 'claude.fake']);
  });
});

describe('on / off', () => {
  test('on keeps the fake codex, writes real-codex.json, leaves claude alone; off puts the fake back exactly', async () => {
    const { root, paths, stub, store } = await scratch();
    try {
      await writeFile(join(store, 'auth.json'), 'MUST-NOT-BE-READ');
      const fakeBefore = await readFile(join(paths.harness, 'codex'), 'utf8');
      const claudeBefore = await readFile(join(paths.harness, 'claude'), 'utf8');
      const { record } = await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      expect(record).toEqual({ login: 'codex-real', store, binary: stub, rootedAt: null });
      expect(await readRecord(paths, CODEX_TOOL)).toEqual(record);
      expect(await readRecord(paths)).toBeUndefined();
      expect(isShim(await readFile(join(paths.harness, 'codex'), 'utf8'), CODEX_TOOL)).toBe(true);
      expect(await readFile(join(paths.harness, 'codex.fake'), 'utf8')).toBe(fakeBefore);
      expect(await readFile(join(paths.harness, 'claude'), 'utf8')).toBe(claudeBefore);
      expect(((await lstat(store)).mode & 0o777).toString(8)).toBe('700');
      expect(JSON.stringify(record)).not.toContain('MUST-NOT');

      const { was } = await disableReal(paths, idle, { force: false }, CODEX_TOOL);
      expect(was?.login).toBe('codex-real');
      expect(await readFile(join(paths.harness, 'codex'), 'utf8')).toBe(fakeBefore);
      expect(((await lstat(join(paths.harness, 'codex'))).mode & 0o777).toString(8)).toBe('755');
      expect(await lstat(join(paths.harness, 'codex.fake')).catch(() => undefined)).toBeUndefined();
      expect(await lstat(join(paths.v5Dir, 'real-codex.json')).catch(() => undefined)).toBeUndefined();
      expect(await readFile(join(store, 'auth.json'), 'utf8')).toBe('MUST-NOT-BE-READ');
      expect(await readFile(join(paths.fyHome, 'config', 'logins', 'codex-real.yaml'), 'utf8')).toBe(CODEX_YAML);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('real claude and real codex are independent: each its own record, fake and shim', async () => {
    const { root, paths, stub } = await scratch();
    try {
      await writeFile(join(paths.fyHome, 'config', 'logins', 'claude-real.yaml'), CLAUDE_YAML);
      await mkdir(storePathOf(paths.fyHome, 'claude-real'), { recursive: true });
      const claudeStub = join(root, 'stub-claude');
      await writeFile(claudeStub, '#!/bin/sh\necho REAL-CLAUDE\n', { mode: 0o755 });
      await enableReal(paths, 'claude-real', claudeStub, noRoot);
      await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      expect((await readRecord(paths))?.login).toBe('claude-real');
      expect((await readRecord(paths, CODEX_TOOL))?.login).toBe('codex-real');
      await disableReal(paths, idle, { force: false }, CODEX_TOOL);
      expect((await readRecord(paths))?.login).toBe('claude-real');
      expect(isShim(await readFile(join(paths.harness, 'claude'), 'utf8'))).toBe(true);
      expect(await readFile(join(paths.harness, 'codex'), 'utf8')).toContain('FAKE-CODEX');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the same login again re-points; a second login is refused; a claude login is refused for codex and the reverse', async () => {
    const { root, paths, stub } = await scratch();
    try {
      await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      const other = join(root, 'stub2');
      await writeFile(other, '#!/bin/sh\necho REAL2\n', { mode: 0o755 });
      await enableReal(paths, 'codex-real', other, noRoot, CODEX_TOOL);
      expect((await readRecord(paths, CODEX_TOOL))?.binary).toBe(other);
      await writeFile(join(paths.fyHome, 'config', 'logins', 'second.yaml'), CODEX_YAML);
      await mkdir(storePathOf(paths.fyHome, 'second'), { recursive: true });
      await expect(enableReal(paths, 'second', stub, noRoot, CODEX_TOOL)).rejects.toThrow(
        /real codex is already on for login codex-real.*real-codex <n> off/su,
      );
      await writeFile(join(paths.fyHome, 'config', 'logins', 'claude-real.yaml'), CLAUDE_YAML);
      await expect(disableReal(paths, idle, { force: false }, CODEX_TOOL)).resolves.toBeDefined();
      await expect(enableReal(paths, 'claude-real', stub, noRoot, CODEX_TOOL)).rejects.toThrow(/not codex/u);
      await expect(enableReal(paths, 'codex-real', stub, noRoot)).rejects.toThrow(/not claude-code/u);
      expect(loginFileProblem('l', CODEX_YAML, CODEX_TOOL)).toBeUndefined();
      expect(loginFileProblem('l', 'harness: codex\nstore: host\n', CODEX_TOOL)).toContain('not ferretry');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('refuses a missing login or a name-less call, a linked store, and a real binary that is the fake or a codex shim; changes nothing', async () => {
    const { root, paths, stub, store } = await scratch();
    try {
      await expect(enableReal(paths, 'nope', stub, noRoot, CODEX_TOOL)).rejects.toThrow(/Codex, Ferretry-managed/u);
      await expect(enableReal(paths, undefined, stub, noRoot, CODEX_TOOL)).rejects.toThrow(
        /real-codex <n> on <login>/u,
      );
      await writeFile(join(paths.fyHome, 'config', 'logins', 'link.yaml'), CODEX_YAML);
      await symlink(store, storePathOf(paths.fyHome, 'link'));
      await expect(enableReal(paths, 'link', stub, noRoot, CODEX_TOOL)).rejects.toThrow(/symbolic link/u);
      await expect(enableReal(paths, 'codex-real', join(paths.harness, 'codex'), noRoot, CODEX_TOOL)).rejects.toThrow(
        /fake/u,
      );
      const copy = join(root, 'shimcopy');
      await writeFile(copy, shimText({ fake: '/f', real: stub, store: '/s' }, CODEX_TOOL), { mode: 0o755 });
      await expect(enableReal(paths, 'codex-real', copy, noRoot, CODEX_TOOL)).rejects.toThrow(/real-codex shim/u);
      expect(await readRecord(paths, CODEX_TOOL)).toBeUndefined();
      expect(await readFile(join(paths.harness, 'codex'), 'utf8')).toContain('FAKE-CODEX');
      expect(await lstat(join(paths.harness, 'codex.fake')).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('off twice is a no-op; a live ferret refuses unless forced; a shim with no record is not guessed at', async () => {
    const { root, paths, stub } = await scratch();
    try {
      expect((await disableReal(paths, idle, { force: false }, CODEX_TOOL)).was).toBeUndefined();
      await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      const busy = { liveFerrets: async () => 'a ferret still runs on runtime r' };
      await expect(disableReal(paths, busy, { force: false }, CODEX_TOOL)).rejects.toThrow(/still runs/u);
      expect(await readRecord(paths, CODEX_TOOL)).toBeDefined();
      await rm(join(paths.v5Dir, 'real-codex.json'));
      await expect(disableReal(paths, idle, { force: false }, CODEX_TOOL)).rejects.toThrow(/no real-codex.json/u);
      await writeFile(
        join(paths.v5Dir, 'real-codex.json'),
        recordText({ login: 'codex-real', store: 'x', binary: stub, rootedAt: null }),
      );
      expect((await disableReal(paths, busy, { force: true }, CODEX_TOOL)).was?.login).toBe('codex-real');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the status line', () => {
  test('off, on, and shim missing (the shim was overwritten)', async () => {
    expect(statusLine(undefined, 'ok', CODEX_TOOL)).toBe('real codex: off (every codex is the fake)');
    const record = { login: 'l', store: '/s', binary: '/b', rootedAt: null };
    expect(statusLine(record, 'ok', CODEX_TOOL)).toBe('real codex: on for login l (/b)');
    expect(statusLine(record, 'shim-missing', CODEX_TOOL)).toBe(
      'real codex: on for login l (/b)  WARNING: harness-bin/codex is not the shim any more; run real-codex on again',
    );
    // a status check reads the file the way slot.ts does: record present but harness-bin/codex is a fake again
    const { root, paths, stub } = await scratch();
    try {
      await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      await writeFile(join(paths.harness, 'codex'), '#!/bin/sh\necho FAKE-CODEX\n', { mode: 0o755 });
      expect(isShim(await readFile(join(paths.harness, 'codex'), 'utf8'), CODEX_TOOL)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('reset-v5 and real codex', () => {
  test('refuses while real codex is on (or a codex shim has no record); passes when it is off', async () => {
    const { root, paths, stub } = await scratch();
    try {
      await expect(realCodexPreflight(paths)).resolves.toBeUndefined();
      await enableReal(paths, 'codex-real', stub, noRoot, CODEX_TOOL);
      await expect(realCodexPreflight(paths)).rejects.toThrow(/real codex is on for login codex-real/u);
      await rm(join(paths.v5Dir, 'real-codex.json'));
      await expect(realCodexPreflight(paths)).rejects.toThrow(/real-codex shim but there is no real-codex.json/u);
      await writeFile(
        join(paths.v5Dir, 'real-codex.json'),
        recordText({ login: 'codex-real', store: 'x', binary: stub, rootedAt: null }),
      );
      await disableReal(paths, idle, { force: false }, CODEX_TOOL);
      await expect(realCodexPreflight(paths)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
