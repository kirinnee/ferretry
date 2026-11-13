import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox, writeV5Build } from './migrate-harness.ts';

setDefaultTimeout(60_000);

const made: Sandbox[] = [];
const box = async (options?: Parameters<typeof makeSandbox>[0]): Promise<Sandbox> => {
  const sb = await makeSandbox(options);
  made.push(sb);
  return sb;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );
const failedHome = (sb: Sandbox): string => `${sb.v4home}-v5-failed-2026-11-13-1200`;

describe('convert: exit codes are checked, in order', () => {
  test('a dry run that says exit 3 stops everything: the real run never starts and no home exists', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    await sb.state('dry.code', '3');
    const result = await sb.run('convert');
    expect(result.code).toBe(3);
    expect(
      (await sb.calls()).filter(line => line.startsWith('bun src/main.ts') && !line.includes('--dry-run')),
    ).toEqual([]);
    expect(await exists(sb.v4home)).toBe(false);
    expect(await sb.notesText()).not.toContain('# converting');
  });

  test('a refusal (exit 2) is passed through; a failed real run (exit 3) leaves no `converted` milestone', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    await sb.state('dry.code', '2');
    expect((await sb.run('convert')).code).toBe(2);
    await sb.state('dry.code', '0');
    await sb.state('real.code', '3');
    const result = await sb.run('convert');
    expect(result.code).toBe(3);
    const notes = await sb.notesText();
    expect(notes).toContain('# converting');
    expect(notes).not.toContain('# converted');
  });

  test('a converter checkout with local changes, or moved off the recorded commit, is refused before anything runs', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    await writeFile(join(sb.repo, 'stray.txt'), 'x');
    const result = await sb.run('convert');
    expect(result.code).toBe(1);
    expect(result.err).toContain('local changes');
    expect((await sb.calls()).filter(line => line.startsWith('bun src/main.ts'))).toEqual([]);
  });

  test('backup refuses without the owner, before quiet, and over an existing backup', async () => {
    const sb = await box();
    await advance(sb, 'baseline');
    expect((await sb.run('backup', ['--owner-yes'])).err).toContain('run quiet first');
    await advance(sb, 'quiet').catch(() => undefined);
    await sb.run('quiet', ['--owner-confirmed']);
    expect((await sb.run('backup', [])).code).toBe(1);
    await Bun.spawn(['mkdir', `${sb.v4home}-before-2026-11-13-1200`]).exited;
    const clash = await sb.run('backup', ['--owner-yes']);
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('refusing to overwrite');
  });
});

describe('start: a failed or interrupted start is not proof that no v5 daemon ran', () => {
  const failingStart = async (sb: Sandbox): Promise<void> => {
    await advance(sb, 'install');
    // The launcher spawns a detached fyd and then fails to hear from it: the process stays.
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'config check', out: 'ok' },
      { match: 'daemon start', run: 'echo /opt/ferretry/fyd > "$D/ps.out"', code: 1 },
      { match: 'daemon stop', run: ': > "$D/ps.out"' },
      { match: 'restart *' },
    ]);
  };

  test('R2.4: starting-v5 is written BEFORE the launch, and the failure says a fyd process is still live', async () => {
    const sb = await box();
    await failingStart(sb);
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(await sb.notesText()).toContain('# starting-v5');
    expect(await sb.notesText()).not.toContain('# started-v5');
    expect(result.err).toContain('fyd process is still running');
  });

  test('a failed start with NO fyd process proves "no v5 daemon owns H" from the process list', async () => {
    const sb = await box();
    await failingStart(sb);
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'config check', out: 'ok' },
      { match: 'daemon start', code: 1 },
    ]);
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(result.out).toContain('proven: no fyd process is running');
  });

  test('R2.4: rollback after a failed start + a live fake fyd STOPS it before moving the home', async () => {
    const sb = await box();
    await failingStart(sb);
    expect((await sb.run('start')).code).toBe(1);
    expect(await sb.readState('ps.out')).toContain('fyd');
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'daemon stop', run: ': > "$D/ps.out"' },
      { match: 'daemon start', run: 'echo /opt/ferretry/fyd > "$D/ps.out"' },
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    const calls = await sb.calls();
    expect(calls.lastIndexOf('fy daemon stop')).toBeGreaterThan(calls.indexOf('fy daemon start'));
    expect(await exists(failedHome(sb))).toBe(true);
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
  });

  test('R2.4: a v5 daemon that will not stop is exit 1 and NOTHING is moved', async () => {
    const sb = await box();
    await failingStart(sb);
    expect((await sb.run('start')).code).toBe(1);
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'daemon stop' }, // succeeds but the process stays
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot be proven');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await exists(join(sb.v4home, 'home.json'))).toBe(true);
  });

  test('start refuses a pending credential repair silently: it is named, marked, and the start goes on', async () => {
    const sb = await box();
    await advance(sb, 'install');
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      { match: 'config check', err: 'logins/a.yaml KEY X holds a literal credential: use fy secret set NAME', code: 1 },
      { match: 'daemon start', run: 'echo /opt/ferretry/fyd > "$D/ps.out"' },
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
    ]);
    const result = await sb.run('start');
    expect(result.code).toBe(0);
    expect(result.out).toContain('literal credential');
    expect(await sb.notesText()).toContain('# credential-repair-pending');
  });

  test('any other config check failure stops the start; fyd --check exit 78 and 69 are named stops', async () => {
    const sb = await box();
    await advance(sb, 'install');
    await sb.fake('fy', [{ match: 'config check', err: 'schema error', code: 1 }]);
    expect((await sb.run('start')).code).toBe(1);
    await sb.fake('fyd', [
      { match: '--version', run: 'cat "$D/fyd.version"' },
      { match: '--check', code: 78 },
    ]);
    expect((await sb.run('start')).err).toContain('exit 78');
    await sb.fake('fyd', [
      { match: '--version', run: 'cat "$D/fyd.version"' },
      { match: '--check', code: 69 },
    ]);
    expect((await sb.run('start')).err).toContain('exit 69');
    expect((await sb.calls()).filter(line => line === 'fy daemon start')).toEqual([]);
  });
});

describe('rollback: by recorded state', () => {
  test('requires the owner (and says what it costs)', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    const result = await sb.run('rollback');
    expect(result.code).toBe(1);
    expect(result.err).toContain('stays whole');
  });

  test('right after the backup (no H, no install): B goes back, no package is touched, v4 daemon starts', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
    expect(
      (await sb.calls()).filter(line => line.startsWith('brew uninstall') || line.startsWith('brew install')),
    ).toEqual([]);
    expect(await sb.calls()).toContain('fy daemon start');
  });

  test('after a dry run exit 3 (no H ever created) the guarded move still works', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    await sb.state('dry.code', '3');
    expect((await sb.run('convert')).code).toBe(3);
    expect((await sb.run('rollback', ['--owner-yes'])).code).toBe(0);
    expect(await exists(failedHome(sb))).toBe(false);
  });

  test('nothing was moved (no backup folder): H still is the v4 home and is left alone', async () => {
    const sb = await box();
    await advance(sb, 'baseline');
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
    expect(await exists(failedHome(sb))).toBe(false);
  });

  test('R2.6: Homebrew half-install (v4 cask removed, v5 install failed, NEITHER cask installed) installs ferretry@4 directly', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.fake('brew', [
      { match: 'list --cask', run: 'cat "$D/brew.casks"' },
      { match: 'uninstall --cask *', run: ': > "$D/brew.casks"' },
      {
        match: 'install --cask kirinnee/ferretry/ferretry@4',
        run: 'echo ferretry@4 > "$D/brew.casks"; echo 4.291.12 > "$D/fy.version"; echo 4.291.12 > "$D/fyd.version"',
      },
      { match: 'install --cask kirinnee/ferretry/ferretry', code: 1 },
    ]);
    expect((await sb.run('install')).code).toBe(1);
    expect(await sb.readState('brew.casks')).toBe('');
    await sb.fake('brew', [
      { match: 'list --cask', run: 'cat "$D/brew.casks"' },
      {
        match: 'install --cask kirinnee/ferretry/ferretry@4',
        run: 'echo ferretry@4 > "$D/brew.casks"; echo 4.291.12 > "$D/fy.version"; echo 4.291.12 > "$D/fyd.version"',
      },
    ]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    const calls = (await sb.calls()).slice((await sb.calls()).lastIndexOf('brew list --cask') - 1);
    expect(calls).toContain('brew install --cask kirinnee/ferretry/ferretry@4');
    expect(calls).not.toContain('brew uninstall --cask ferretry');
  });

  test('R2.6: nix profile with NO element left (remove worked, add failed) installs the v4 tag, no remove', async () => {
    const sb = await box({ casks: '' });
    await sb.state('nix.profile', 'Name: ferretry\nOriginal flake URL: github:kirinnee/ferretry/v4.291.12\n');
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'convert');
    await sb.fake('nix', [
      { match: 'profile list', run: 'cat "$D/nix.profile"' },
      { match: 'flake metadata *' },
      { match: 'profile add --help' },
      { match: 'profile remove *', run: ': > "$D/nix.profile"' },
      { match: 'profile add github:kirinnee/ferretry/v5*', code: 1 },
      {
        match: 'profile add github:kirinnee/ferretry/v4*',
        run: 'printf "Name: ferretry\\nOriginal flake URL: github:kirinnee/ferretry/v4.291.12\\n" > "$D/nix.profile"; echo 4.291.12 > "$D/fy.version"; echo 4.291.12 > "$D/fyd.version"',
      },
    ]);
    expect((await sb.run('install')).code).toBe(1);
    const before = (await sb.calls()).length;
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    const after = (await sb.calls()).slice(before);
    expect(after).toContain('nix profile add github:kirinnee/ferretry/v4.291.12');
    expect(after.filter(line => line.startsWith('nix profile remove'))).toEqual([]);
  });

  test('a v5 element is removed first, then the v4 tag installed', async () => {
    const sb = await box({ casks: '' });
    await sb.state('nix.profile', 'Name: ferretry\nOriginal flake URL: github:kirinnee/ferretry/v4.291.12\n');
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'install');
    expect(await sb.readState('nix.profile')).toContain('v5.0.0');
    const before = (await sb.calls()).length;
    expect((await sb.run('rollback', ['--owner-yes'])).code).toBe(0);
    const after = (await sb.calls()).slice(before);
    expect(after.indexOf('nix profile remove ferretry')).toBeLessThan(
      after.indexOf('nix profile add github:kirinnee/ferretry/v4.291.12'),
    );
  });

  test('standalone: the saved v4 programs are copied back over the v5 ones, to their recorded paths', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'convert');
    // The fake updater replaces the fy program on disk with a "v5" one, like the real `fy daemon update --major`.
    await sb.fake('fy', [
      { match: '--version', out: '4.291.12' },
      {
        match: 'daemon update *',
        run: 'printf "#!/usr/bin/env bash\\necho 5.0.0\\n" > "$0"; echo 5.0.0 > "$D/fyd.version"',
      },
      { match: 'daemon start' },
    ]);
    const original = await readFile(join(sb.root, 'fakebin', 'fy'), 'utf8');
    expect((await sb.run('install')).code).toBe(0);
    expect(await readFile(join(sb.root, 'fakebin', 'fy'), 'utf8')).not.toBe(original);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await readFile(join(sb.root, 'fakebin', 'fy'), 'utf8')).toBe(original);
  });

  test('manual kind: homes are restored, then the run stops and says to restore the programs by hand', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'preflight');
    const notes = (await sb.notesText()).replace('KIND=standalone', 'KIND=manual');
    await writeFile(sb.notes, notes);
    for (const [phase, args] of [
      ['baseline', ['--asks-open', '0']],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
    ] as const) {
      expect((await sb.run(phase, args)).code).toBe(0);
    }
    await sb.state('fy.version', '5.0.0\n');
    await sb.state('fyd.version', '5.0.0\n');
    expect((await sb.run('install')).code).toBe(0);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('by hand');
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
  });

  test('R2.5: restart names the recorded ferret ids, never bare `fy restart`; without --restart it only prints the command', async () => {
    const sb = await box();
    await advance(sb, 'start');
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('fy restart f1');
    expect((await sb.calls()).filter(line => line.startsWith('fy restart'))).toEqual([]);
  });

  test('R2.5: an empty fleet restarts nothing', async () => {
    const sb = await box({ panes: false });
    await advance(sb, 'start');
    const result = await sb.run('rollback', ['--owner-yes', '--restart']);
    expect(result.code).toBe(0);
    expect((await sb.calls()).filter(line => line.startsWith('fy restart'))).toEqual([]);
  });

  test('a live fyd when the notes record NO v5 launch is the v4 daemon: left alone, after the quiet check', async () => {
    const sb = await box();
    await advance(sb, 'backup');
    await sb.state('ps.out', '/opt/ferretry/fyd\n');
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('it is the v4 daemon, left alone');
    expect(result.out).toContain('quiet before');
    expect((await sb.calls()).filter(line => line === 'fy daemon stop').length).toBe(1); // only the quiet phase's own stop
  });
});

describe('rollback restores the ORIGINAL environment, not the shell it is run from', () => {
  test('R2.3: PATH and FY_URL seen by fy are the recorded ones (here: FY_URL was unset), whatever the caller exported', async () => {
    const sb = await box();
    await advance(sb, 'start');
    const notesPath = (await sb.notesText()).match(/^ORIG_PATH=(.+)$/m)?.[1] as string;
    const result = await sb.run('rollback', ['--owner-yes'], {
      PATH: `/not/the/original:${notesPath}`,
      FY_URL: 'http://127.0.0.1:9',
    });
    expect(result.code).toBe(0);
    const started = (await sb.envLog()).filter(line => line.startsWith('fy|daemon start')).at(-1) as string;
    expect(started).toContain(`PATH=${notesPath}|`);
    expect(started).toContain('FY_URL=<unset>');
    const version = (await sb.envLog()).filter(line => line.startsWith('fy|--version')).at(-1) as string;
    expect(version).toContain(`PATH=${notesPath}|`);
    expect(version).toContain('FY_URL=<unset>');
  });

  test('R2.3: when FY_URL WAS set at preflight, that exact value comes back', async () => {
    const sb = await box();
    expect((await sb.run('preflight', ['--notes', sb.notes], { FY_URL: 'http://127.0.0.1:7777' })).code).toBe(0);
    for (const [phase, args] of [
      ['baseline', ['--asks-open', '0']],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
    ] as const) {
      expect((await sb.run(phase, args)).code).toBe(0);
    }
    const result = await sb.run('rollback', ['--owner-yes'], { FY_URL: 'http://127.0.0.1:9' });
    expect(result.code).toBe(0);
    const started = (await sb.envLog()).filter(line => line.startsWith('fy|daemon start')).at(-1) as string;
    expect(started).toContain('FY_URL=http://127.0.0.1:7777');
  });

  test('R2.3: a pre-release (rehearsal) rollback never leaves the build folder on the PATH fy runs with', async () => {
    const sb = await box({ tag: null });
    await writeV5Build(sb);
    const env = { MIGRATE_REHEARSAL: '1' };
    expect((await sb.run('preflight', ['--notes', sb.notes], env)).code).toBe(0);
    for (const [phase, args] of [
      ['baseline', ['--asks-open', '0']],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
    ] as const) {
      expect((await sb.run(phase, args, env)).code).toBe(0);
    }
    expect((await sb.run('install', ['--rehearsal-build', sb.v5bin], env)).code).toBe(0);
    expect((await sb.run('start', [], env)).code).toBe(0);
    const result = await sb.run('rollback', ['--owner-yes'], {
      ...env,
      PATH: `${sb.v5bin}:${join(sb.root, 'fakebin')}:${process.env.PATH ?? ''}`,
    });
    expect(result.code).toBe(0);
    const last = (await sb.envLog()).filter(line => line.startsWith('fy|daemon start')).at(-1) as string;
    expect(last).not.toContain(sb.v5bin);
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
  });

  test('the pinned dummy FY_URL of the pre-start checks never reaches the daemon start or the notes', async () => {
    const sb = await box();
    await advance(sb, 'start');
    expect(await sb.notesText()).not.toContain('127.0.0.1:9');
    const env = await sb.envLog();
    expect(env.filter(line => line.startsWith('fy|daemon start')).every(line => line.includes('FY_URL=<unset>'))).toBe(
      true,
    );
    expect(
      env.filter(line => line.startsWith('fy|config check')).every(line => line.includes('FY_URL=http://127.0.0.1:9')),
    ).toBe(true);
  });
});

test('no unscripted call happened anywhere in a rollback run', async () => {
  const sb = await box();
  await advance(sb, 'start');
  expect((await sb.run('rollback', ['--owner-yes', '--restart'])).code).toBe(0);
  expect(await sb.unscripted()).toEqual([]);
});
