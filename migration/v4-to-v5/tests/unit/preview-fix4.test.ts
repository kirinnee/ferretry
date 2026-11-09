import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileFileSchema, RuntimeFileSchema } from '@ferretry/plugin-runtimes/contract';
import { parse as parseYaml } from 'yaml';
import { prepare, REFUSED_DAEMON_VERBS, shimText, wrapperText } from '../../preview/driver.ts';
import { gateFiles, gatedFields } from '../../preview/gate.ts';
import { needlesFor } from '../../src/v4/homes.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { copySqlite, stage } from '../../preview/stage.ts';
import { startChecks, type Run } from '../../preview/start-checks.ts';
import { PREVIEW_SETTINGS_ITEM, previewShellEnv } from '../../src/v5/preview-env.ts';
import { fixture } from './ferret-fixture.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-fix4-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const V4 = '/nonexistent-v4/.ferretry';
const PATH = process.env.PATH ?? '/usr/bin:/bin';

describe('MAJOR-1 both harnesses get the guard environment in the converted home', () => {
  test('a converted home carries the guard, FY_HOME, FY_PORT and FY_URL for Claude Code', async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.from, 'config'), { recursive: true });
      await writeFile(join(f.from, 'layout-version'), '2\n');
      await writeFile(join(f.from, 'config/machine.yaml'), 'timeZone: UTC\n');
      const done = await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-09T00:00:00Z'),
        home: join(f.root, 'home'),
      });
      expect(done.report?.complete).toBe(true);
      const wanted = previewShellEnv(await realpath(f.to), PREVIEW.port);
      expect(wanted.__ETC_PROFILE_NIX_SOURCED).toBe('1');
      expect(wanted.FY_URL).toBe(`http://127.0.0.1:${PREVIEW.port}`);
      const claude = parseYaml(
        await readFile(join(f.to, `config/claude-code/settings/${PREVIEW_SETTINGS_ITEM}.yaml`), 'utf8'),
      );
      expect(claude.settings.env).toEqual(wanted);
      // Codex runtimes are held out of the preview (PREVIEW_CODEX_RUNTIMES is off), so no Codex item is written.
      expect(existsSync(join(f.to, `config/codex/settings/${PREVIEW_SETTINGS_ITEM}.yaml`))).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('why a settings item: 5.0 runtime and profile files are strict and refuse an env field', () => {
    expect(RuntimeFileSchema.safeParse({ login: 'a', profile: 'p' }).success).toBe(true);
    expect(RuntimeFileSchema.safeParse({ login: 'a', profile: 'p', env: { X: '1' } }).success).toBe(false);
    expect(ProfileFileSchema.safeParse({ contents: [] }).success).toBe(true);
    expect(ProfileFileSchema.safeParse({ contents: [], env: { X: '1' } }).success).toBe(false);
  });
});

describe('MAJOR-2 the shim and fy5 refuse the same verbs, from one generated block', () => {
  let home: string;
  beforeEach(async () => {
    home = join(root, 'v5');
    await mkdir(join(home, 'bin'), { recursive: true });
    await mkdir(join(home, 'libexec'));
    // Stands in for the 5.0 binary: prints its arguments, then every variable it received.
    await writeFile(join(home, 'libexec/fy'), '#!/bin/sh\nprintf "arg:%s\\n" "$@"\nenv\n', { mode: 0o755 });
    await writeFile(join(home, 'bin/fy5'), wrapperText(home, V4), { mode: 0o755 });
    await writeFile(join(home, 'bin/fy'), shimText(home, 'fy'), { mode: 0o755 });
  });
  const run = (program: 'fy5' | 'fy', args: string[], env: Record<string, string> = { PATH }) =>
    Bun.spawnSync([join(home, 'bin', program), ...args], { env });

  test('update through the shim is refused and reaches no binary', () => {
    for (const args of [['update'], ['update', '--to', '5.0.0'], ['-q', 'update']]) {
      const result = run('fy', args);
      expect(result.exitCode).toBe(64);
      expect(result.stdout.toString()).toBe('');
      expect(result.stderr.toString()).toContain('preview');
    }
  });

  test('daemon restart through the shim is refused and reaches no binary', () => {
    const result = run('fy', ['daemon', 'restart']);
    expect(result.exitCode).toBe(64);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('preview.sh');
  });

  test('daemon start through the shim is refused and says to use preview.sh start; fy5 still starts', () => {
    const shim = run('fy', ['daemon', 'start']);
    expect(shim.exitCode).toBe(64);
    expect(shim.stdout.toString()).toBe('');
    expect(shim.stderr.toString()).toContain('use preview.sh start');
    expect(run('fy5', ['daemon', 'start']).stdout.toString()).toContain('arg:start');
  });

  test('fy5 and the shim refuse exactly the same verb set', () => {
    const refusing = (program: 'fy5' | 'fy', args: string[]) => run(program, args).exitCode === 64;
    const cases = [
      ['update'],
      ['--as-owner', 'daemon', 'stop'],
      ...REFUSED_DAEMON_VERBS.map(verb => ['daemon', verb]),
      ['status'],
      ['pair'],
      ['daemon', 'status'],
      ['task', 'list'],
    ];
    for (const args of cases) expect([args, refusing('fy', args)]).toEqual([args, refusing('fy5', args)]);
    expect(cases.filter(args => refusing('fy', args)).length).toBe(REFUSED_DAEMON_VERBS.length + 2);
  });

  test("the shim passes a ferret's own session variables through and turns the update check off", () => {
    const out = run('fy', ['status'], { PATH, FY_TOKEN: 'ferret-session', HOME: '/h' }).stdout.toString();
    expect(out).toContain('arg:status');
    expect(out).toContain('FY_TOKEN=ferret-session');
    expect(out).toContain('FY_UPDATE_CHECK=off');
    expect(out).toContain(`FY_HOME=${home}`);
  });

  test('only the CLI shim carries the refusals', () => {
    expect(shimText(home, 'fyd')).not.toContain('daemon:');
    expect(shimText(home, 'fy')).toContain('daemon:restart');
  });
});

describe('Minor-1 the probe is also asked as the kernel runs it', () => {
  const callerEnv = { HOME: '/home/u', PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/real' };
  const answering =
    (manager: { kernel?: boolean; wrapper?: boolean }, seen: Array<Record<string, string>> = []): Run =>
    async (argv, env) => {
      if (argv[0] === 'systemctl') {
        seen.push({ ...env });
        return { code: manager.kernel === true ? 0 : 1, stdout: '' };
      }
      if (argv.includes('show-environment')) return { code: manager.wrapper === true ? 0 : 1, stdout: '' };
      if (argv[0] === 'bash' || argv[0] === 'zsh') return { code: 0, stdout: `${join(root, 'v5/bin/fy')}\n` };
      return { code: 0, stdout: `${join(root, 'v5', PREVIEW.xdgRunFolder)}|unset` };
    };

  test('with only {PATH, HOME}, the daemon PATH first: refuses when that probe reaches a manager', async () => {
    const seen: Array<Record<string, string>> = [];
    const refused = await startChecks({
      target: join(root, 'v5'),
      v4Home: V4,
      callerEnv,
      run: answering({ kernel: true }, seen),
    });
    expect(refused.ok).toBe(false);
    expect(refused.problems.join('\n')).toContain('{PATH, HOME}');
    expect(seen.length).toBe(1);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual(['HOME', 'PATH']);
    expect(seen[0]?.HOME).toBe('/home/u');
    expect(seen[0]?.PATH?.startsWith(`${join(root, 'v5', 'bin')}:`)).toBe(true);
  });

  test('refuses if either probe answers, passes when neither does', async () => {
    const target = join(root, 'v5');
    const base = { target, v4Home: V4, callerEnv };
    expect((await startChecks({ ...base, run: answering({ wrapper: true }) })).ok).toBe(false);
    expect((await startChecks({ ...base, run: answering({ kernel: true }) })).ok).toBe(false);
    expect((await startChecks({ ...base, run: answering({}) })).ok).toBe(true);
  });
});

describe('Minor-2 the strict gate is wired through gateFiles', () => {
  test('claude-code and codex settings are strict; the same document under state/ is not', async () => {
    const home = join(root, 'home');
    const v4 = join(home, '.ferretry');
    const target = join(root, 'converted');
    const put = async (path: string, text: string) => {
      await mkdir(join(target, path, '..'), { recursive: true });
      await writeFile(join(target, path), text);
    };
    await put('config/claude-code/settings/x.yaml', `settings:\n  apiKeyHelper: ${v4}/bin/helper.sh\n`);
    await put(
      'config/codex/settings/x.yaml',
      `settings:\n  projects:\n    "${v4}/work":\n      trust_level: trusted\n`,
    );
    await put('state/ferrets/f1/details.json', JSON.stringify({ whatever: { deep: `${v4}/x` } }));
    await put('config/claude-code/settings/y.yaml', `settings:\n  whatever:\n    deep: ${v4}/x\n`);
    const found = await gateFiles(target, v4, home);
    expect(found).toContain('config/claude-code/settings/x.yaml: settings.apiKeyHelper');
    expect(found).toContain('config/codex/settings/x.yaml: settings.projects.<path key>');
    expect(found).toContain('config/claude-code/settings/y.yaml: settings.whatever.deep');
    expect(found.some(line => line.startsWith('state/'))).toBe(false);
    expect(found.join('\n')).not.toContain('/work');
  });
});

describe('Nits 1-2 of the strict gate', () => {
  const needles = needlesFor('/home/u/.ferretry', '/home/u');
  const hits = (doc: unknown) => gatedFields(doc, needles, { strict: true });

  test('an env variable called NAME or PROMPT holding a v4 path is not skipped as free text', () => {
    expect(hits({ env: { NAME: '/home/u/.ferretry/x', PROMPT: '/home/u/.ferretry/y' } })).toEqual([
      'env.NAME',
      'env.PROMPT',
    ]);
    expect(hits({ name: '/home/u/.ferretry/x' })).toEqual([]);
  });

  test('a hit under a path key never prints that key', () => {
    const found = hits({ projects: { '/home/kirin/Workspace/x': { notify: ['/home/u/.ferretry/n.sh'] } } });
    expect(found).toEqual(['projects.<path key>.notify[0]']);
    expect(found.join('')).not.toContain('Workspace');
  });
});

describe('Minor-3 a SQLite file is never opened in v4', () => {
  const sha = async (path: string) =>
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex');

  test('a hot rollback journal is rolled back in the copy: v4 is unchanged (hash) and the staged file opens', async () => {
    const v4 = join(root, 'v4');
    const folder = join(v4, 'state/sessions/s1/agenda-versions');
    await mkdir(folder, { recursive: true });
    // A writer that is mid-transaction with a spilled cache leaves a hot journal: capture its files, then end it.
    const live = join(root, 'live.sqlite');
    const db = new Database(live);
    db.run('PRAGMA journal_mode = DELETE');
    db.run('CREATE TABLE t (n INTEGER, pad TEXT)');
    db.run("INSERT INTO t VALUES (1, 'committed')");
    db.run('PRAGMA cache_size = 5');
    db.run('BEGIN');
    for (let i = 0; i < 3000; i++) db.run('INSERT INTO t VALUES (?, ?)', [i + 2, 'y'.repeat(200)]);
    expect(existsSync(`${live}-journal`)).toBe(true);
    const original = join(folder, 'A1.sqlite');
    await copyFile(live, original);
    await copyFile(`${live}-journal`, `${original}-journal`);
    db.run('ROLLBACK');
    db.close();

    const before = [await sha(original), await sha(`${original}-journal`)];
    const staging = join(root, 'staging');
    await stage(v4, staging);
    expect([await sha(original), await sha(`${original}-journal`)]).toEqual(before);
    expect(existsSync(`${original}-journal`)).toBe(true);

    const copy = new Database(join(staging, 'state/sessions/s1/agenda-versions/A1.sqlite'), { readonly: true });
    try {
      expect(copy.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
    } finally {
      copy.close();
    }
    expect(existsSync(join(staging, 'state/sessions/s1/agenda-versions/A1.sqlite-journal'))).toBe(false);
  });

  test('a copy that fails integrity_check is retried, refused by name after 3 tries, and v4 is unchanged', async () => {
    const v4 = join(root, 'v4');
    const folder = join(v4, 'state/sessions/s1/agenda-versions');
    await mkdir(folder, { recursive: true });
    const original = join(folder, 'A1.sqlite');
    const db = new Database(original);
    db.run('CREATE TABLE t (n INTEGER, pad TEXT)');
    db.run('BEGIN');
    for (let i = 0; i < 500; i++) db.run('INSERT INTO t VALUES (?, ?)', [i, 'z'.repeat(100)]);
    db.run('COMMIT');
    db.run('DELETE FROM t WHERE n >= 100');
    db.close();
    // Tear it: the free-list trunk page (named in the header, bytes 32-35) overwritten with garbage, as a copy taken
    // mid-write can look. Only an integrity_check sees this one; VACUUM never reads the free list.
    const bytes = new Uint8Array(await readFile(original));
    const trunk = new DataView(bytes.buffer).getUint32(32);
    expect(trunk).toBeGreaterThan(0);
    bytes.fill(0xab, (trunk - 1) * 4096, trunk * 4096);
    await writeFile(original, bytes);
    const before = await sha(original);

    const attempts: number[] = [];
    await expect(copySqlite(original, join(root, 'out.sqlite'), { onAttempt: n => attempts.push(n) })).rejects.toThrow(
      'failed integrity_check on 3 copies',
    );
    expect(attempts).toEqual([1, 2, 3]);
    expect(existsSync(join(root, 'out.sqlite'))).toBe(false);

    await expect(stage(v4, join(root, 'staging'))).rejects.toThrow(
      'state/sessions/s1/agenda-versions/A1.sqlite was refused',
    );
    expect(await sha(original)).toBe(before);
    expect(existsSync(`${original}-journal`)).toBe(false);
  });
});
