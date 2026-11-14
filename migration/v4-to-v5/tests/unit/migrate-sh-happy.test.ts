import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, baselineArgs, makeSandbox, type Sandbox, SECRET_VALUE } from './migrate-harness.ts';

setDefaultTimeout(60_000);

let sb: Sandbox;
beforeEach(async () => {
  sb = await makeSandbox();
});
afterEach(async () => {
  await sb.cleanup();
});

describe('migrate.sh happy path (Homebrew v4 cask, released v5.0.0)', () => {
  test('every phase exits 0, in order, and leaves its milestones', async () => {
    const codes: Record<string, number> = {};
    const steps: [string, readonly string[]][] = [
      ['preflight', ['--notes', sb.notes]],
      ['baseline', baselineArgs],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
      ['install', []],
      ['start', []],
      ['verify', []],
    ];
    for (const [phase, args] of steps) {
      const result = await sb.run(phase, args);
      codes[phase] = result.code;
      if (result.code !== 0) throw new Error(`${phase}: ${result.all}`);
    }
    expect(codes).toEqual({
      preflight: 0,
      baseline: 0,
      quiet: 0,
      backup: 0,
      convert: 0,
      install: 0,
      start: 0,
      verify: 0,
    });
    const notes = await sb.notesText();
    const milestones = notes.split('\n').filter(line => line.startsWith('# '));
    for (const wanted of [
      'preflighted',
      'baselined',
      'quiet',
      'backing-up',
      'backed-up',
      'dry-running',
      'converting',
      'converted',
      'installing-v5',
      'installed-v5',
      'starting-v5',
      'started-v5',
      'verified',
    ]) {
      expect(milestones).toContain(`# ${wanted}`);
    }
    // A milestone is written BEFORE the step acts: `backing-up` precedes `backed-up`, `starting-v5` precedes `started-v5`.
    expect(milestones.indexOf('# backing-up')).toBeLessThan(milestones.indexOf('# backed-up'));
    expect(milestones.indexOf('# starting-v5')).toBeLessThan(milestones.indexOf('# started-v5'));
    expect(await sb.unscripted()).toEqual([]);
  });

  test('preflight records the original PATH, FY_URL/FY_PORT presence and absolute v4 locations', async () => {
    const result = await sb.run('preflight', ['--notes', sb.notes], {
      FY_URL: 'http://127.0.0.1:7777',
      FY_PORT: '7777',
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`NOTES=${sb.notes}`);
    const notes = await sb.notesText();
    expect(notes).toMatch(/^ORIG_PATH=.+fakebin/m);
    expect(notes).toContain('FY_URL_STATE=set');
    expect(notes).toContain('FY_URL=http://127.0.0.1:7777');
    expect(notes).toContain('FY_PORT_STATE=set');
    expect(notes).toMatch(/^V4_FY=.+\/fakebin\/fy$/m);
    expect(notes).toMatch(/^V4_FYD=.+\/fakebin\/fyd$/m);
    expect(notes).toContain('KIND=homebrew');
    expect(notes).toContain('TAG=v5.0.0');
    expect(notes).toContain('V4_VERSION=4.291.12');
    expect(notes).not.toContain(SECRET_VALUE);
  });

  test('baseline keeps callsign AND title apart, parents, the pane map, board lanes, login and secret NAMES', async () => {
    await advance(sb, 'preflight');
    const result = await sb.run('baseline', baselineArgs);
    expect(result.code).toBe(0);
    const base = (await sb.notesText()).match(/^BASE=(.+)$/m)?.[1];
    expect(base).toBeDefined();
    const ferrets = JSON.parse(await readFile(join(base as string, 'ferrets.json'), 'utf8')) as Record<
      string,
      unknown
    >[];
    expect(ferrets).toEqual([
      { id: 'f1', callsign: 'ashlie', title: 'Review Migration Prompt Fixes', parent: null, status: 'working' },
      { id: 'f2', callsign: 'bob', title: 'Child task', parent: 'f1', status: 'stopped' },
    ]);
    expect(await readFile(join(base as string, 'panes.txt'), 'utf8')).toBe('fy-f1 %1\n');
    expect(await readFile(join(base as string, 'pane-owners.tsv'), 'utf8')).toBe('f1\tfy-f1\t%1\n');
    expect(JSON.parse(await readFile(join(base as string, 'board-open.json'), 'utf8'))).toEqual({
      truncated: false,
      cards: [{ id: 'C1', laneId: 'todo' }],
    });
    expect(await readFile(join(base as string, 'logins.txt'), 'utf8')).toBe('alpha\nbeta\n');
    expect(await readFile(join(base as string, 'secrets.txt'), 'utf8')).toBe('API_KEY\n');
    expect(((await stat(base as string)).mode & 0o777).toString(8)).toBe('700');
    expect(await readdir(base as string)).not.toContain('ps.raw.json');
  });

  test('the home is moved, never copied: B holds the v4 home, H is the converted home, backup mode is 700', async () => {
    await advance(sb, 'backup');
    const b = `${sb.v4home}-before-2026-11-13-1200`;
    expect(((await stat(b)).mode & 0o777).toString(8)).toBe('700');
    expect(await readFile(join(b, 'layout-version'), 'utf8')).toBe('2\n');
    await expect(stat(sb.v4home)).rejects.toThrow();
  });

  test('convert runs the dry run, then the real run, in that order, each with its exit code checked', async () => {
    await advance(sb, 'backup');
    const result = await sb.run('convert');
    expect(result.code).toBe(0);
    const calls = (await sb.calls()).filter(line => line.startsWith('bun src/main.ts'));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).toContain('--report');
    expect(calls[1]).not.toContain('--dry-run');
    expect(await readFile(join(sb.v4home, 'home.json'), 'utf8')).toContain('{}');
  });

  test('install (Homebrew v4 cask) swaps the cask and proves fy is 5.x matching the tag; the daemon is not started', async () => {
    await advance(sb, 'convert');
    const result = await sb.run('install');
    expect(result.code).toBe(0);
    expect(result.out).toContain('the daemon is NOT started');
    const calls = await sb.calls();
    expect(calls).toContain('brew uninstall --cask ferretry@4');
    expect(calls).toContain('brew install --cask kirinnee/ferretry/ferretry');
    expect(calls.filter(line => line.startsWith('fy daemon start'))).toEqual([]);
    expect(await sb.notesText()).toContain('PKG_BEFORE=cask:ferretry@4');
  });

  test('start writes starting-v5 before the launch, checks first, and proves the daemon answers', async () => {
    await advance(sb, 'install');
    const result = await sb.run('start');
    expect(result.code).toBe(0);
    const calls = await sb.calls();
    expect(calls.indexOf('fyd --check')).toBeLessThan(calls.indexOf('fy daemon start'));
    expect(calls.indexOf('fy config check')).toBeLessThan(calls.indexOf('fy daemon start'));
    // The checks that must not start a daemon ran with the dummy address pinned; the start did not.
    const env = await sb.envLog();
    expect(env.find(line => line.startsWith('fyd|--check'))).toContain('FY_URL=http://127.0.0.1:9');
    expect(env.find(line => line.startsWith('fy|daemon start'))).toContain('FY_URL=<unset>');
  });

  test('verify compares with the baseline and prints a table with an OK for every check', async () => {
    await advance(sb, 'start');
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    for (const label of [
      'ferret ids',
      'parents',
      'callsigns',
      'titles',
      'panes',
      'board open',
      'logins',
      'secret names',
      'asks',
      'fy doctor',
    ]) {
      expect(result.out).toContain(label);
    }
    expect(result.out).not.toMatch(/ {2,}FAIL {2,}/);
  });

  test('rollback after a complete run restores v4: homes, cask, daemon, ids restarted by name', async () => {
    await advance(sb, 'verify');
    const result = await sb.run('rollback', ['--owner-yes', '--restart']);
    expect(result.code).toBe(0);
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
    expect(await readFile(join(`${sb.v4home}-v5-failed-2026-11-13-1200`, 'home.json'), 'utf8')).toContain('{}');
    const calls = await sb.calls();
    expect(calls).toContain('brew uninstall --cask ferretry');
    expect(calls).toContain('brew install --cask kirinnee/ferretry/ferretry@4');
    expect(calls).toContain('fy restart f1');
    expect(calls).not.toContain('fy restart');
  });
});

test('no secret value reaches any output, note, baseline file or log (the fake store holds one)', async () => {
  const local = await makeSandbox();
  try {
    let all = '';
    for (const [phase, args] of [
      ['preflight', ['--notes', local.notes]],
      ['baseline', baselineArgs],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
      ['install', []],
      ['start', []],
      ['verify', []],
      ['rollback', ['--owner-yes', '--restart']],
    ] as const) {
      const result = await local.run(phase, args);
      all += result.all;
      expect(result.code).toBe(0);
    }
    expect(all).not.toContain(SECRET_VALUE);
    expect(await local.notesText()).not.toContain(SECRET_VALUE);
    // The only files holding the value are the two the fake home was seeded with, which the script never reads.
    const holders = (await local.everything())
      .split('\n')
      .filter(Boolean)
      .map(path => path.replace(local.home, ''));
    expect(holders.every(path => /\/state\/secrets\.(json|key)$/.test(path))).toBe(true);
  } finally {
    await local.cleanup();
  }
});
