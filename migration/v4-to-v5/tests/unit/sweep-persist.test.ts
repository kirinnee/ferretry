import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCodexAuthText } from '../../fixtures/sweep/fake-codex-auth.ts';
import {
  AFTER_FAILED_PERSIST,
  LINK_SCRIPT,
  addStoreRoots,
  daemonUnitText,
  defaultPersistDir,
  execLine,
  execWord,
  persistTargetProblem,
  pointerDir,
  pointerFile,
  restartTerminals,
  revertFailedPersist,
  setting,
  storePathsIn,
  storeRootOf,
  terminalsUnitText,
  unitMarker,
} from '../../fixtures/sweep/persist.ts';

const HOME = '/home/someone';
const ROOT = '/tmp/claude-1000/sweep';

describe('systemd escaping', () => {
  test('% and $ are doubled in an exec word, quoted or not', () => {
    expect(execWord('/p/100%')).toBe('/p/100%%');
    expect(execWord('/p/$HOME')).toBe('/p/$$HOME');
    expect(execWord('/p/a b%c$d')).toBe('"/p/a b%%c$$d"');
  });
  test('a word with spaces, quotes or backslashes is double-quoted and escaped', () => {
    expect(execWord('a b')).toBe('"a b"');
    expect(execWord('say "hi"')).toBe('"say \\"hi\\""');
    expect(execWord('c:\\dir x')).toBe('"c:\\\\dir x"');
  });
  test('a plain word stays bare; a lone ; is escaped so it does not end the command', () => {
    expect(execWord('--port')).toBe('--port');
    expect(execWord('/home/u/.local/share/fy-sweep/slot6/fyd')).toBe('/home/u/.local/share/fy-sweep/slot6/fyd');
    expect(execWord(';')).toBe('\\;');
    expect(execWord('a;b')).toBe('"a;b"');
  });
  test('a line break or NUL is refused, in an exec word and in a setting', () => {
    expect(() => execWord('a\nb')).toThrow();
    expect(() => execWord('a\0b')).toThrow();
    expect(() => setting('a\rb')).toThrow();
  });
  test('% is doubled in a setting (a description, a path)', () => {
    expect(setting('/data/50%/x')).toBe('/data/50%%/x');
  });
  test('execLine needs an absolute program that no ExecStart prefix could swallow', () => {
    expect(execLine(['/bin/sh', '/a b/x.sh'])).toBe('/bin/sh "/a b/x.sh"');
    expect(() => execLine(['sh', 'x'])).toThrow();
    expect(() => execLine(['-/bin/sh'])).toThrow();
    expect(() => execLine([])).toThrow();
  });
});

describe('unit text', () => {
  const daemon = daemonUnitText({
    slot: 6,
    side: 'v5',
    name: 'fy5-slot6.service',
    terminalsName: 'fy5-slot6-terminals.service',
    execStartPre: ['/bin/sh', '/p/100%/link-slot.sh', '/p/100%', '/tmp/s/slot6'],
    execStart: [
      '/bin/sh',
      '/p/fyd-exec.sh',
      '/usr/bin/env',
      '/p/fyd.env',
      '/p/bin/fyd',
      '--host',
      '127.0.0.1',
      '--port',
      '7613',
    ],
    workingDirectory: '/p/100%/v5/user',
    logFile: '/p/100%/v5/fyd.log',
  });
  test('the daemon unit restarts on failure, never kills a tmux server, is enabled at boot, and names its marker first', () => {
    expect(daemon.split('\n')[0]).toBe(unitMarker(6, 'fy5-slot6.service'));
    for (const line of [
      'Restart=on-failure',
      'RestartSec=2s',
      'KillMode=process',
      'WantedBy=default.target',
      'Wants=fy5-slot6-terminals.service',
      'After=fy5-slot6-terminals.service',
    ])
      expect(daemon).toContain(`${line}\n`);
  });
  test('every path is escaped: no lone % survives', () => {
    expect(daemon).toContain('WorkingDirectory=/p/100%%/v5/user\n');
    expect(daemon).toContain('StandardOutput=append:/p/100%%/v5/fyd.log\n');
    expect(daemon).toContain('ExecStartPre=/bin/sh /p/100%%/link-slot.sh /p/100%% /tmp/s/slot6\n');
    expect(daemon.replaceAll('%%', '')).not.toContain('%');
  });
  test('the daemon unit names no /tmp path except the link it recreates', () => {
    const lines = daemon.split('\n').filter(line => line.includes('/tmp/'));
    expect(lines).toEqual(['ExecStartPre=/bin/sh /p/100%%/link-slot.sh /p/100%% /tmp/s/slot6']);
  });
  test('the terminals unit is a oneshot that remains, whose stop kills only its own tmux server, and ; is escaped', () => {
    const text = terminalsUnitText({
      slot: 6,
      side: 'v5',
      name: 'fy5-slot6-terminals.service',
      execStartPre: ['/bin/sh', '/p/link-slot.sh', '/p', '/tmp/s/slot6'],
      execStart: [
        '/bin/sh',
        '/p/fyd-exec.sh',
        '/usr/bin/env',
        '/p/fyd.env',
        '/usr/bin/tmux',
        '-u',
        '-S',
        '/s/tmux.sock',
        'start-server',
        ';',
        'set-option',
        '-s',
        'exit-empty',
        'off',
      ],
      execStop: [
        '/bin/sh',
        '/p/fyd-exec.sh',
        '/usr/bin/env',
        '/p/fyd.env',
        '/usr/bin/tmux',
        '-u',
        '-S',
        '/s/tmux.sock',
        'kill-server',
      ],
    });
    expect(text).toContain('Type=oneshot\nRemainAfterExit=yes\nKillMode=process\n');
    expect(text).toContain('start-server \\; set-option -s exit-empty off\n');
    expect(text).toContain('ExecStop=-/bin/sh');
    expect(text).toContain('WantedBy=default.target');
  });
});

describe('persist target', () => {
  test('the default is under ~/.local/share/fy-sweep and is accepted', () => {
    const target = defaultPersistDir(6, HOME);
    expect(target).toBe('/home/someone/.local/share/fy-sweep/slot6');
    expect(persistTargetProblem({ target, sweepRoot: ROOT, home: HOME })).toBeUndefined();
    expect(pointerFile(6, HOME)).toBe('/home/someone/.local/share/fy-sweep/pointers/slot6.json');
  });
  test.each([
    ['inside the sweep root', `${ROOT}/slot6-keep`],
    ['inside /tmp', '/tmp/elsewhere/slot6'],
    ['inside /var/tmp', '/var/tmp/slot6'],
    ['inside /run', '/run/user/1000/slot6'],
    ["inside the owner's v4 home", `${HOME}/.ferretry/slot6`],
    ["inside the owner's v5 home", `${HOME}/.ferretry-v5/x`],
    ['the v4 home itself', `${HOME}/.ferretry`],
    ['inside a claude home', `${HOME}/.claude/slot`],
    ['inside a codex home', `${HOME}/.codex/x`],
    ['inside a second codex home (prefix .codex)', `${HOME}/.codex-work/x`],
    ['inside a second claude home (prefix .claude)', `${HOME}/.claude-llm2/x`],
    ['inside a sibling of the v4 home (prefix .ferretry)', `${HOME}/.ferretry-sweep/slot6`],
    ['inside the secrets folder', `${HOME}/.secrets/x`],
    ['inside the unit folder', `${HOME}/.config/systemd/user/x`],
    ['the home itself', HOME],
    ['not absolute', 'relative/slot6'],
    ['not normalized', `${HOME}/a/../b`],
    ['a trailing slash', `${HOME}/data/slot6/`],
  ])('refuses a folder %s', (_why, target) => {
    expect(persistTargetProblem({ target, sweepRoot: ROOT, home: HOME })).toBeString();
  });
  test('an ordinary folder under the home is fine, and a name that only shares a prefix with a forbidden one is not mistaken for it', () => {
    expect(persistTargetProblem({ target: `${HOME}/data/slot6`, sweepRoot: ROOT, home: HOME })).toBeUndefined();
    expect(persistTargetProblem({ target: `${HOME}/.secretsfoo/slot6`, sweepRoot: ROOT, home: HOME })).toBeUndefined();
    expect(persistTargetProblem({ target: `${HOME}/data/.claude/slot6`, sweepRoot: ROOT, home: HOME })).toBeUndefined();
    expect(persistTargetProblem({ target: '/tmpfoo/slot6', sweepRoot: ROOT, home: HOME })).toBeUndefined();
  });
});

describe('link-slot.sh', () => {
  const run = async (args: string[]): Promise<{ code: number; err: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'link-slot-'));
    const script = join(dir, 'link-slot.sh');
    await writeFile(script, LINK_SCRIPT, { mode: 0o700 });
    await chmod(script, 0o700);
    const ran = Bun.spawn(['/bin/sh', script, ...args.map(arg => arg.replaceAll('<dir>', dir))], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [err, code] = await Promise.all([new Response(ran.stderr).text(), ran.exited]);
    return { code, err, ...{} } as { code: number; err: string };
  };

  test('creates the link (and its parent folder) when it is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'link-slot-'));
    const target = join(dir, 'persistent');
    await Bun.write(join(target, 'x'), 'x');
    const link = join(dir, 'tmp', 'sweep', 'slot6');
    const script = join(dir, 'link-slot.sh');
    await writeFile(script, LINK_SCRIPT, { mode: 0o700 });
    const ran = Bun.spawn(['/bin/sh', script, target, link], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await ran.exited).toBe(0);
    expect(await readlink(link)).toBe(target);
    // Run again: already the right link, still fine.
    const again = Bun.spawn(['/bin/sh', script, target, link], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await again.exited).toBe(0);
    // A link to somewhere else, and a real folder in the way, are refused with 78 and left as they were.
    await rm(link);
    await symlink('/nonexistent-elsewhere', link);
    const wrong = Bun.spawn(['/bin/sh', script, target, link], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await wrong.exited).toBe(78);
    expect(await readlink(link)).toBe('/nonexistent-elsewhere');
    await rm(link);
    await Bun.write(join(link, 'file'), 'real folder');
    const real = Bun.spawn(['/bin/sh', script, target, link], {
      env: { PATH: '/usr/bin:/bin' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await real.exited).toBe(78);
    expect((await lstat(link)).isDirectory()).toBe(true);
    await rm(dir, { recursive: true });
  });

  test('many units racing to make the same link all succeed, and nothing is put INSIDE the persistent folder', async () => {
    for (let round = 0; round < 5; round += 1) {
      const dir = await mkdtemp(join(tmpdir(), 'link-slot-race-'));
      const target = join(dir, 'persistent');
      await mkdir(target);
      await writeFile(join(target, 'x'), 'x');
      const script = join(dir, 'link-slot.sh');
      await writeFile(script, LINK_SCRIPT, { mode: 0o700 });
      const link = join(dir, 'tmp', 'sweep', 'slot6'); // the parent does not exist yet: every runner creates it
      const runs = Array.from({ length: 16 }, () =>
        Bun.spawn(['/bin/sh', script, target, link], {
          env: { PATH: '/usr/bin:/bin' },
          stdout: 'pipe',
          stderr: 'pipe',
        }),
      );
      const codes = await Promise.all(runs.map(async proc => await proc.exited));
      expect(codes).toEqual(codes.map(() => 0));
      expect(await readlink(link)).toBe(target);
      expect(await readdir(target)).toEqual(['x']);
      await rm(dir, { recursive: true });
    }
  });

  test('refuses (78) a persistent folder that is missing or is itself a link', async () => {
    const missing = await run(['<dir>/nope', '<dir>/l']);
    expect(missing.code).toBe(78);
    const bad = await run(['<dir>/a b']);
    expect(bad.code).toBe(78);
  });
});

describe('the fake Codex sign-in', () => {
  const at = new Date('2026-11-17T00:00:00.000Z');
  const parsed = JSON.parse(fakeCodexAuthText(at)) as {
    tokens: { id_token: string; access_token: string; refresh_token: string };
    last_refresh: string;
  };
  const claims = (jwt: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

  test('has the shape the daemon reads as signed in: tokens, a refresh token, last_refresh', () => {
    expect(parsed.tokens.access_token.split('.')).toHaveLength(3);
    expect(parsed.tokens.id_token.split('.')).toHaveLength(3);
    expect(parsed.tokens.refresh_token.length).toBeGreaterThan(0);
    expect(parsed.last_refresh).toBe('2026-11-17T00:00:00.000Z');
  });
  test('the access token is good for years, so the login is never "Refresh due"', () => {
    const exp = Number(claims(parsed.tokens.access_token).exp);
    expect(exp * 1000 - at.getTime()).toBeGreaterThan(5 * 365 * 24 * 3600 * 1000);
  });
  test('the id token carries a display email and plan, all made up', () => {
    const id = claims(parsed.tokens.id_token);
    expect(id.email).toBe('fixture@example.invalid');
    expect((id['https://api.openai.com/auth'] as { chatgpt_plan_type: string }).chatgpt_plan_type).toBe('plus');
  });
  test('every value is a marker, never a real-looking secret', () => {
    const text = fakeCodexAuthText(at);
    expect(text).toContain('fixture-unverifiable-signature');
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}/u);
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}/u);
  });
});

describe('the pointer file is believed only as far as a persist target', () => {
  const read = (dir: unknown, slot: unknown = 6): ReturnType<typeof pointerDir> =>
    pointerDir({ document: { slot, dir }, slot: 6, sweepRoot: ROOT, home: HOME });
  test('the default persistent folder is accepted', () => {
    expect(read(defaultPersistDir(6, HOME))).toEqual({ dir: defaultPersistDir(6, HOME) });
  });
  test.each([
    ['the home itself', HOME],
    ['the owner v4 home', `${HOME}/.ferretry`],
    ['inside the owner v5 home', `${HOME}/.ferretry-v5/x`],
    ['a claude login folder', `${HOME}/.claude-llm2`],
    ['a folder under /tmp', '/tmp/x/slot6'],
    ['not normalized', `${HOME}/a/../.ferretry`],
    ['the root', '/'],
  ])('refuses a pointer that names %s', (_why, dir) => {
    const found = read(dir);
    expect(found.dir).toBeUndefined();
    expect(found.problem).toBeString();
  });
  test("a document that is not this slot's, or has no dir, is simply no pointer", () => {
    expect(read(defaultPersistDir(6, HOME), 7)).toEqual({});
    expect(read(undefined)).toEqual({});
    expect(read(5)).toEqual({});
    expect(pointerDir({ document: null, slot: 6, sweepRoot: ROOT, home: HOME })).toEqual({});
    expect(pointerDir({ document: 'x', slot: 6, sweepRoot: ROOT, home: HOME })).toEqual({});
  });
});

describe("restarting a persisted side's tmux server", () => {
  test('uses restart (a RemainAfterExit oneshot that is still active ignores start) and returns the new server pid', async () => {
    const calls: string[][] = [];
    const found = await restartTerminals(
      {
        serverPid: async () => 4242,
        systemctl: async args => {
          calls.push([...args]);
          return { code: 0, out: '', err: '' };
        },
      },
      'fy5-slot6-terminals.service',
    );
    expect(found).toEqual({ pid: 4242 });
    expect(calls).toEqual([['restart', 'fy5-slot6-terminals.service']]);
  });
  test('says why when systemd refuses, or when no server answers afterwards', async () => {
    const refused = await restartTerminals(
      { serverPid: async () => undefined, systemctl: async () => ({ code: 5, out: '', err: 'Unit not found' }) },
      'u.service',
    );
    expect(refused).toEqual({ why: 'exit 5: Unit not found' });
    const silent = await restartTerminals(
      { serverPid: async () => undefined, systemctl: async () => ({ code: 0, out: '', err: '' }) },
      'u.service',
    );
    expect('why' in silent).toBe(true);
  });
});

describe('a persist that failed half way', () => {
  const ports = (log: string[], opts: { revertFails?: boolean; restartFails?: boolean } = {}) => ({
    revert: async () => {
      log.push('revert');
      if (opts.revertFails === true) throw new Error('disk full');
    },
    restart: async () => {
      log.push('restart');
      if (opts.restartFails === true) throw new Error('no systemd');
    },
    say: (line: string) => log.push(`say: ${line.trim()}`),
  });
  test('puts the folder back, then starts both daemons again; the warning is said before either', async () => {
    const log: string[] = [];
    expect(await revertFailedPersist(ports(log), 6)).toBe('restarted');
    expect(log.map(entry => entry.split(':')[0])).toEqual(['say', 'say', 'revert', 'restart']);
    expect(log[1]).toBe(`say: ${AFTER_FAILED_PERSIST}`);
    expect(AFTER_FAILED_PERSIST).toContain('do NOT run up');
    expect(AFTER_FAILED_PERSIST).toContain('wipes');
  });
  test('a revert that fails starts nothing and says so', async () => {
    const log: string[] = [];
    expect(await revertFailedPersist(ports(log, { revertFails: true }), 6)).toBe('not-reverted');
    expect(log).not.toContain('restart');
    expect(log.at(-1)).toContain('disk full');
  });
  test('a restart that fails after the warning surfaces to the caller, which reports it', async () => {
    const log: string[] = [];
    await expect(revertFailedPersist(ports(log, { restartFails: true }), 6)).rejects.toThrow('no systemd');
    expect(log[1]).toBe(`say: ${AFTER_FAILED_PERSIST}`);
  });
});

describe('GC roots for the nix store paths a slot bakes', () => {
  const HASH = 'a'.repeat(32);
  const OTHER = 'b'.repeat(32);
  test('finds each store path once, whatever surrounds it (PATH lists, Exec words, wrapper scripts)', () => {
    const text = [
      `PATH=/nix/store/${HASH}-coreutils-9.5/bin:/usr/bin:/nix/store/${OTHER}-tmux-3.5a/bin`,
      `FY_FIXTURE_BUN=/nix/store/${HASH}-coreutils-9.5/bin/env`,
      `exec "/nix/store/${OTHER}-fyd-4.9.1/bin/.fyd-wrapped" "$@"`,
      '/nix/store/short-name /nix/store/ not-a-store-path',
    ].join('\n');
    expect(storePathsIn(text)).toEqual([
      `/nix/store/${HASH}-coreutils-9.5`,
      `/nix/store/${OTHER}-fyd-4.9.1`,
      `/nix/store/${OTHER}-tmux-3.5a`,
    ]);
  });
  test('the store path a program lives in; nothing outside the store has one', () => {
    expect(storeRootOf(`/nix/store/${HASH}-fyd-4.9.1/bin/fyd`)).toBe(`/nix/store/${HASH}-fyd-4.9.1`);
    expect(storeRootOf('/usr/bin/env')).toBeUndefined();
  });
  test('roots each path once under the folder, by its own name, with --indirect', async () => {
    const calls: string[][] = [];
    const found = await addStoreRoots(
      {
        nixStore: async args => {
          calls.push([...args]);
          return { code: 0, out: '', err: '' };
        },
      },
      '/data/slot6/gcroots',
      [`/nix/store/${OTHER}-b`, `/nix/store/${HASH}-a`, `/nix/store/${HASH}-a`],
    );
    expect(found.failed).toEqual([]);
    expect(found.rooted).toEqual([`/nix/store/${HASH}-a`, `/nix/store/${OTHER}-b`]);
    expect(calls[0]).toEqual([
      '--add-root',
      `/data/slot6/gcroots/${HASH}-a`,
      '--indirect',
      '--realise',
      `/nix/store/${HASH}-a`,
    ]);
    expect(calls).toHaveLength(2);
  });
  test('a path that could not be rooted is reported with the reason, never skipped silently', async () => {
    const failing = await addStoreRoots(
      { nixStore: async () => ({ code: 1, out: '', err: 'path is not valid' }) },
      '/d',
      [`/nix/store/${HASH}-a`],
    );
    expect(failing).toEqual({ rooted: [], failed: [{ path: `/nix/store/${HASH}-a`, why: 'path is not valid' }] });
    const missing = await addStoreRoots({ nixStore: undefined }, '/d', [`/nix/store/${HASH}-a`]);
    expect(missing.failed[0]?.why).toContain('nix-store is not on PATH');
  });
});
