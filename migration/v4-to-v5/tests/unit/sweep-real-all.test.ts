import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_LOGINS,
  CLAUDE_TOOL,
  CODEX_TOOL,
  credentialsRootOf,
  disableReal,
  enableReal,
  isShim,
  parseRecord,
  readRecord,
  statusLine,
  storePathOf,
  type RealPaths,
  type RealTool,
} from '../../fixtures/sweep/real-claude.ts';

const NO_ROOT = { root: async () => ({ link: undefined }) };
const IDLE = { liveFerrets: async () => undefined };

interface Scratch {
  readonly root: string;
  readonly paths: RealPaths;
  readonly stub: Record<'claude' | 'codex', string>;
  /** Makes the login dirs (names only; an empty folder each, nothing is ever written inside) under the credentials root. */
  readonly logins: (...ids: string[]) => Promise<void>;
  readonly ferretHome: (name: string, linkTo: string | undefined) => Promise<string>;
}

/** A scratch slot with fake claude+codex, a 5.0 home (optionally behind a link, as a persisted slot is) and STUB "real" binaries. */
async function scratch(options: { linked: boolean } = { linked: false }): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), 'rc-all-'));
  const v5Dir = join(root, 'v5');
  const harness = join(v5Dir, 'harness-bin');
  const fyHome = join(v5Dir, 'home');
  await mkdir(harness, { recursive: true });
  await mkdir(join(fyHome, 'config', 'logins'), { recursive: true });
  if (options.linked) {
    const persistent = join(root, 'persistent-home');
    await rename(fyHome, persistent);
    await symlink(persistent, fyHome);
  }
  await writeFile(join(harness, 'claude'), '#!/bin/sh\necho FAKE-CLAUDE "$@"\n', { mode: 0o755 });
  await writeFile(join(harness, 'codex'), '#!/bin/sh\necho FAKE-CODEX "$@"\n', { mode: 0o755 });
  const claude = join(root, 'stub-claude');
  const codex = join(root, 'stub-codex');
  await writeFile(claude, '#!/bin/sh\necho "REAL-CLAUDE dir=$CLAUDE_SECURESTORAGE_CONFIG_DIR $*"\n', { mode: 0o755 });
  await writeFile(codex, '#!/bin/sh\necho "REAL-CODEX home=$CODEX_HOME $*"\n', { mode: 0o755 });
  return {
    root,
    paths: { v5Dir, fyHome, harness },
    stub: { claude, codex },
    logins: async (...ids) => {
      for (const id of ids) await mkdir(storePathOf(fyHome, id), { recursive: true });
    },
    ferretHome: async (name, linkTo) => {
      const home = join(fyHome, 'state', 'codex', 'agent-homes', name);
      await mkdir(home, { recursive: true });
      if (linkTo !== undefined) await symlink(linkTo, join(home, 'auth.json'));
      return home;
    },
  };
}

async function run(shim: string, args: string[], env: Record<string, string>): Promise<string> {
  const child = Bun.spawn([shim, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out.trim();
}

const toolOf = (name: 'claude' | 'codex'): RealTool => (name === 'claude' ? CLAUDE_TOOL : CODEX_TOOL);
const withScratch = async (linked: boolean, body: (s: Scratch) => Promise<void>): Promise<void> => {
  const s = await scratch({ linked });
  try {
    await body(s);
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
};

describe('on --all: the claude shim', () => {
  test('every direct child login dir gets the real claude, in the logical AND the realpath spelling; everything else gets the fake', async () => {
    await withScratch(true, async s => {
      const { record } = await enableReal(s.paths, ALL_LOGINS, s.stub.claude, NO_ROOT);
      const root = credentialsRootOf(s.paths.fyHome);
      const realRoot = credentialsRootOf(await realpath(s.paths.fyHome));
      expect(realRoot).not.toBe(root);
      expect(record).toEqual({ login: ALL_LOGINS, store: root, binary: s.stub.claude, rootedAt: null, all: true });
      await s.logins('alpha', 'beta.v2', 'c-3');
      const shim = join(s.paths.harness, 'claude');
      expect(isShim(await readFile(shim, 'utf8'))).toBe(true);
      const dir = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
      for (const base of [root, realRoot])
        for (const id of ['alpha', 'beta.v2', 'c-3', 'not-made-yet', '.hidden'])
          expect(await run(shim, ['hi'], { [dir]: `${base}/${id}` })).toBe(`REAL-CLAUDE dir=${base}/${id} hi`);
      // --version always goes to the real binary
      expect(await run(shim, ['--version'], {})).toContain('REAL-CLAUDE');

      const fake = 'FAKE-CLAUDE hi';
      const other = join(s.root, 'slot9', 'v5', 'home', 'state', 'logins', 'credentials');
      const near: Record<string, string> = {
        'host store': '/home/someone/.claude',
        'the credentials root itself': root,
        'the real root itself': realRoot,
        'nested child': `${root}/alpha/nested`,
        'nested real child': `${realRoot}/alpha/nested`,
        'dot-dot id': `${root}/..`,
        'dot id': `${root}/.`,
        'empty id (trailing slash on the root)': `${root}/`,
        'trailing slash after an id': `${root}/alpha/`,
        'dot-dot walking back in': `${root}/../credentials/alpha`,
        'dot-dot after an id': `${root}/alpha/..`,
        'double slash': `${root}//alpha`,
        'prefix sibling': `${root}-other/alpha`,
        'another slot': `${other}/alpha`,
        'a parent folder': join(root, '..'),
        unset: '',
      };
      for (const [name, value] of Object.entries(near))
        expect(await run(shim, ['hi'], { [dir]: value }), name).toBe(fake);
      // no variable at all
      expect(await run(shim, ['hi'], {})).toBe(fake);
    });
  });

  test('a login dir that is a link (a symlink escape) gets the fake', async () => {
    await withScratch(false, async s => {
      await enableReal(s.paths, ALL_LOGINS, s.stub.claude, NO_ROOT);
      const root = credentialsRootOf(s.paths.fyHome);
      await mkdir(root, { recursive: true });
      const elsewhere = join(s.root, 'host-store');
      await mkdir(elsewhere);
      await symlink(elsewhere, join(root, 'escape'));
      const shim = join(s.paths.harness, 'claude');
      expect(await run(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${root}/escape` })).toBe('FAKE-CLAUDE hi');
      expect(await run(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: elsewhere })).toBe('FAKE-CLAUDE hi');
    });
  });

  test('a root with glob characters in its path is matched literally, never as a pattern', async () => {
    await withScratch(false, async s => {
      const odd = { ...s.paths, fyHome: join(s.root, 'v5', 'ho*me [x]') };
      await mkdir(join(odd.fyHome, 'config', 'logins'), { recursive: true });
      await enableReal(odd, ALL_LOGINS, s.stub.claude, NO_ROOT);
      const shim = join(s.paths.harness, 'claude');
      const root = credentialsRootOf(odd.fyHome);
      const dir = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';
      expect(await run(shim, ['hi'], { [dir]: `${root}/a` })).toBe(`REAL-CLAUDE dir=${root}/a hi`);
      expect(await run(shim, ['hi'], { [dir]: `${join(s.root, 'v5', 'home')}/state/logins/credentials/a` })).toBe(
        'FAKE-CLAUDE hi',
      );
    });
  });
});

describe('on --all: the codex shim', () => {
  test('CODEX_HOME = a child login dir (either spelling) gets the real codex; a ferret whose auth.json link targets <child>/auth.json (either spelling) too', async () => {
    await withScratch(true, async s => {
      const { record } = await enableReal(s.paths, ALL_LOGINS, s.stub.codex, NO_ROOT, CODEX_TOOL);
      const root = credentialsRootOf(s.paths.fyHome);
      const realRoot = credentialsRootOf(await realpath(s.paths.fyHome));
      expect(record).toEqual({ login: ALL_LOGINS, store: root, binary: s.stub.codex, rootedAt: null, all: true });
      const shim = join(s.paths.harness, 'codex');
      expect(isShim(await readFile(shim, 'utf8'), CODEX_TOOL)).toBe(true);
      for (const base of [root, realRoot])
        for (const id of ['alpha', 'beta']) {
          expect(await run(shim, ['login'], { CODEX_HOME: `${base}/${id}` })).toBe(
            `REAL-CODEX home=${base}/${id} login`,
          );
          const ferret = await s.ferretHome(`f-${id}-${base === root ? 'logical' : 'real'}`, `${base}/${id}/auth.json`);
          expect(await run(shim, ['hi'], { CODEX_HOME: ferret })).toBe(`REAL-CODEX home=${ferret} hi`);
        }
      expect(await run(shim, ['--version'], {})).toContain('REAL-CODEX');

      const fake = 'FAKE-CODEX hi';
      const hostStore = join(s.root, 'host', '.codex');
      const nearHomes: Record<string, string> = {
        'host store': hostStore,
        'the credentials root itself': root,
        'nested child': `${root}/alpha/nested`,
        'dot-dot': `${root}/..`,
        dot: `${root}/.`,
        'empty id': `${root}/`,
        'trailing slash': `${root}/alpha/`,
        'another slot': `${join(s.root, 'slot9', 'credentials')}/alpha`,
      };
      for (const [name, value] of Object.entries(nearHomes))
        expect(await run(shim, ['hi'], { CODEX_HOME: value }), name).toBe(fake);
      const nearLinks: Record<string, string> = {
        'link to the root auth.json': `${root}/auth.json`,
        'link to a nested child': `${root}/alpha/nested/auth.json`,
        'link through dot-dot': `${root}/../alpha/auth.json`,
        'link with an inner dot-dot': `${root}/alpha/../auth.json`,
        'link with an empty id': `${root}//auth.json`,
        'link to a dot id': `${root}/./auth.json`,
        'link suffix': `${root}/alpha/auth.json.bak`,
        'link to another file': `${root}/alpha/other.json`,
        'link to the host store': join(hostStore, 'auth.json'),
        'link to another slot': `${join(s.root, 'slot9', 'credentials')}/alpha/auth.json`,
        'relative link': 'alpha/auth.json',
      };
      let i = 0;
      for (const [name, target] of Object.entries(nearLinks)) {
        const ferret = await s.ferretHome(`near-${String((i += 1))}`, target);
        expect(await run(shim, ['hi'], { CODEX_HOME: ferret }), name).toBe(fake);
      }
      // a home whose auth.json is a plain file, a home with no link, no CODEX_HOME at all
      expect(await run(shim, ['hi'], { CODEX_HOME: await s.ferretHome('plain', undefined) })).toBe(fake);
      expect(await run(shim, ['hi'], {})).toBe(fake);
    });
  });

  test('a login dir that is a link, as CODEX_HOME or as the target dir of a ferret link, gets the fake', async () => {
    await withScratch(false, async s => {
      await enableReal(s.paths, ALL_LOGINS, s.stub.codex, NO_ROOT, CODEX_TOOL);
      const root = credentialsRootOf(s.paths.fyHome);
      await mkdir(root, { recursive: true });
      const elsewhere = join(s.root, 'host-codex');
      await mkdir(elsewhere);
      await symlink(elsewhere, join(root, 'escape'));
      const shim = join(s.paths.harness, 'codex');
      expect(await run(shim, ['hi'], { CODEX_HOME: `${root}/escape` })).toBe('FAKE-CODEX hi');
      const ferret = await s.ferretHome('via-escape', `${root}/escape/auth.json`);
      expect(await run(shim, ['hi'], { CODEX_HOME: ferret })).toBe('FAKE-CODEX hi');
    });
  });
});

describe('on --all / off', () => {
  for (const name of ['claude', 'codex'] as const) {
    test(`${name}: on writes an --all record, prints "on for every login", is idempotent, and off puts the fake back (never touching a store)`, async () => {
      await withScratch(false, async s => {
        const tool = toolOf(name);
        await s.logins('alpha');
        const marker = join(storePathOf(s.paths.fyHome, 'alpha'), 'marker');
        await writeFile(marker, 'untouched');
        const first = await enableReal(s.paths, ALL_LOGINS, s.stub[name], NO_ROOT, tool);
        expect(statusLine(first.record, 'ok', tool)).toBe(`real ${name}: on for every login (${s.stub[name]})`);
        await enableReal(s.paths, ALL_LOGINS, s.stub[name], NO_ROOT, tool);
        expect(parseRecord(JSON.stringify(first.record))).toEqual(first.record);
        expect((await readRecord(s.paths, tool))?.all).toBe(true);
        let asked: string | undefined;
        await expect(
          disableReal(
            s.paths,
            {
              liveFerrets: async login => {
                asked = login;
                return 'a ferret still runs';
              },
            },
            { force: false },
            tool,
          ),
        ).rejects.toThrow(/a ferret still runs/u);
        expect(asked).toBe(ALL_LOGINS);
        const off = await disableReal(s.paths, IDLE, { force: false }, tool);
        expect(off.was?.all).toBe(true);
        expect(isShim(await readFile(join(s.paths.harness, name), 'utf8'), tool)).toBe(false);
        expect(await readRecord(s.paths, tool)).toBeUndefined();
        expect(await readFile(marker, 'utf8')).toBe('untouched');
      });
    });

    test(`${name}: --all and per-login refuse each other; a link as the credentials root is refused; a login named * is no login`, async () => {
      await withScratch(false, async s => {
        const tool = toolOf(name);
        await writeFile(
          join(s.paths.fyHome, 'config', 'logins', 'one.yaml'),
          `harness: ${tool.harnessValue}\nstore: ferretry\n`,
        );
        await enableReal(s.paths, 'one', s.stub[name], NO_ROOT, tool);
        await expect(enableReal(s.paths, ALL_LOGINS, s.stub[name], NO_ROOT, tool)).rejects.toThrow(
          /already on for login one/u,
        );
        await disableReal(s.paths, IDLE, { force: false }, tool);
        await enableReal(s.paths, ALL_LOGINS, s.stub[name], NO_ROOT, tool);
        await expect(enableReal(s.paths, 'one', s.stub[name], NO_ROOT, tool)).rejects.toThrow(
          /already on for every login/u,
        );
        await disableReal(s.paths, IDLE, { force: false }, tool);
        // a link as the credentials root
        const root = credentialsRootOf(s.paths.fyHome);
        await mkdir(join(root, '..'), { recursive: true });
        await symlink(s.root, root);
        await expect(enableReal(s.paths, ALL_LOGINS, s.stub[name], NO_ROOT, tool)).rejects.toThrow(/symbolic link/u);
      });
    });
  }

  test('per-login mode is unchanged: no all key in the record, the shim has no fy_login_dir, the status line names the login', async () => {
    await withScratch(false, async s => {
      await writeFile(join(s.paths.fyHome, 'config', 'logins', 'one.yaml'), 'harness: claude-code\nstore: ferretry\n');
      const { record } = await enableReal(s.paths, 'one', s.stub.claude, NO_ROOT);
      expect('all' in record).toBe(false);
      expect(await readFile(join(s.paths.v5Dir, 'real-claude.json'), 'utf8')).not.toContain('"all"');
      expect(await readFile(join(s.paths.harness, 'claude'), 'utf8')).not.toContain('fy_login_dir');
      expect(statusLine(record)).toBe(`real claude: on for login one (${s.stub.claude})`);
      const store = storePathOf(s.paths.fyHome, 'one');
      const shim = join(s.paths.harness, 'claude');
      expect(await run(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: store })).toBe(`REAL-CLAUDE dir=${store} hi`);
      expect(await run(shim, ['hi'], { CLAUDE_SECURESTORAGE_CONFIG_DIR: storePathOf(s.paths.fyHome, 'two') })).toBe(
        'FAKE-CLAUDE hi',
      );
    });
  });

  test('a record with all: true but a real login name is not an --all record', () => {
    const text = JSON.stringify({ login: 'x', store: '/s', binary: '/b', rootedAt: null, all: true });
    expect(parseRecord(text)?.all).toBeUndefined();
  });
});
