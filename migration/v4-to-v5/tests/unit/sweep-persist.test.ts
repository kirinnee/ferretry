import { describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCodexAuthText } from '../../fixtures/sweep/fake-codex-auth.ts';
import {
  LINK_SCRIPT,
  daemonUnitText,
  defaultPersistDir,
  execLine,
  execWord,
  persistTargetProblem,
  pointerFile,
  setting,
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
    ['inside a codex home', `${HOME}/.codex-work/x`.replace('.codex-work', '.codex')],
    ['inside the secrets folder', `${HOME}/.secrets/x`],
    ['inside the unit folder', `${HOME}/.config/systemd/user/x`],
    ['the home itself', HOME],
    ['not absolute', 'relative/slot6'],
    ['not normalized', `${HOME}/a/../b`],
    ['a trailing slash', `${HOME}/data/slot6/`],
  ])('refuses a folder %s', (_why, target) => {
    expect(persistTargetProblem({ target, sweepRoot: ROOT, home: HOME })).toBeString();
  });
  test('an ordinary folder under the home is fine, and a sibling that only shares a prefix is not mistaken for a forbidden one', () => {
    expect(persistTargetProblem({ target: `${HOME}/data/slot6`, sweepRoot: ROOT, home: HOME })).toBeUndefined();
    expect(
      persistTargetProblem({ target: `${HOME}/.ferretry-sweep/slot6`, sweepRoot: ROOT, home: HOME }),
    ).toBeUndefined();
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
