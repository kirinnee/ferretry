import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, DAEMON_UP_SH, makeSandbox, SECRET_VALUE, type Sandbox } from './migrate-harness.ts';

/**
 * Round-1 review of migrate.sh, one named test per finding (P1 #1 to #8, then the P2s that were fixed). Every test here
 * failed on the script as it was at 2510384ddb (see the fix report) and passes now.
 */

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
const baselineFolder = (sb: Sandbox): string => join(sb.home, 'v4-baseline-2026-11-13-1200');
/** Files under HOME that hold a value, apart from the two sealed-store files the sandbox seeds on purpose. */
const leaks = async (sb: Sandbox, value: string): Promise<string[]> => {
  const proc = Bun.spawn(['grep', '-rl', value, sb.home], { stdout: 'pipe', stderr: 'ignore' });
  const hits = (await new Response(proc.stdout).text()).split('\n').filter(Boolean);
  await proc.exited;
  return hits.filter(path => !path.endsWith('/state/secrets.json') && !path.endsWith('/state/secrets.key'));
};
const tmuxReads = async (sb: Sandbox): Promise<string[]> =>
  (await sb.calls()).filter(line => line.startsWith('tmux ') && line.includes('list-panes'));

describe('P1-1: rollback proves the panes quiet whatever the daemon state, and never guesses a live daemon is v4', () => {
  test('P1-1a: NO live daemon but a pane that cannot be proven quiet (tmux fails): exit 2 and the v5 home is NOT moved', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await sb.daemonDown(); // the daemon crashed; the harness panes still run in tmux
    await sb.fake('tmux', [{ match: '*', code: 42 }]);
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(2);
    expect(result.err).toContain('nothing was moved');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await exists(join(sb.v4home, 'home.json'))).toBe(true);
    expect((await tmuxReads(sb)).length).toBeGreaterThan(0);
  });

  test('P1-1a: NO live daemon and quiet panes: the quiet window is still established BEFORE the home moves', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await sb.daemonDown();
    const before = (await tmuxReads(sb)).length;
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect((await tmuxReads(sb)).length - before).toBeGreaterThanOrEqual(2);
    expect(result.out).toContain('quiet before');
    expect(await exists(failedHome(sb))).toBe(true);
  });

  test('P1-1b: a live fyd the notes say is v5, while the installed fy is already v4: refused, nothing moved, no stop attempted', async () => {
    const sb = await box();
    await advance(sb, 'start');
    expect(await exists(join(sb.v4home, 'run', 'daemon.json'))).toBe(true);
    await sb.state('fy.version', '4.291.12\n'); // a partly restored machine: v4 fy on PATH, the v5 process still running
    await sb.state('fyd.version', '4.291.12\n');
    const stopsBefore = (await sb.calls()).filter(line => line === 'fy daemon stop').length;
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('cannot be stopped safely');
    expect(await exists(failedHome(sb))).toBe(false);
    expect(await exists(join(sb.v4home, 'home.json'))).toBe(true);
    expect((await sb.calls()).filter(line => line === 'fy daemon stop').length).toBe(stopsBefore);
  });

  test('P1-1b: the same live v5 fyd with NO fy on the PATH at all is refused too', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await rm(join(sb.root, 'fakebin', 'fy'));
    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(1);
    expect(await exists(failedHome(sb))).toBe(false);
  });

  test('P1-1: the process list is never read at all (no name, no executable, no arguments): the daemon is found by its record', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await sb.run('rollback', ['--owner-yes']);
    expect((await sb.calls()).filter(line => line.startsWith('ps '))).toEqual([]);
  });
});

describe('P1-2: every phase runs fy and fyd with the RECORDED home and port, whatever the caller exports now', () => {
  test('P1-2: a baseline run in a shell with FY_HOME unset, then changed, still gives fy the recorded home; FY_PORT likewise', async () => {
    const sb = await box();
    expect((await sb.run('preflight', ['--notes', sb.notes], { FY_PORT: '7777' })).code).toBe(0);
    expect(await sb.notesText()).toContain('FY_PORT=7777');
    const baseline = await sb.run('baseline', ['--asks-open', '0'], { FY_HOME: undefined, FY_PORT: '8888' });
    expect(baseline.code).toBe(0);
    const lines = (await sb.envLog()).filter(line => line.startsWith('fy|'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain(`FY_HOME=${sb.v4home}|`);
      expect(line).toContain('FY_PORT=7777');
    }
    const elsewhere = await sb.run('quiet', ['--owner-confirmed'], { FY_HOME: '/somewhere/else' });
    expect(elsewhere.code).toBe(0);
    const stop = (await sb.envLog()).filter(line => line.startsWith('fy|daemon stop')).at(-1) as string;
    expect(stop).toContain(`FY_HOME=${sb.v4home}|`);
  });

  test('P1-2: FY_PORT that was UNSET at preflight stays unset for every later call', async () => {
    const sb = await box();
    expect((await sb.run('preflight', ['--notes', sb.notes])).code).toBe(0);
    expect((await sb.run('baseline', ['--asks-open', '0'], { FY_PORT: '5' })).code).toBe(0);
    for (const line of (await sb.envLog()).filter(entry => entry.startsWith('fy|')))
      expect(line).toContain('FY_PORT=<unset>');
  });

  test('P1-2: start, verify and rollback pin the recorded home on the v5 and v4 programs too', async () => {
    const sb = await box();
    await advance(sb, 'start');
    const env = { FY_HOME: '/not/the/home', FY_PORT: '1234' };
    expect((await sb.run('verify', [], env)).code).toBe(0);
    expect((await sb.run('rollback', ['--owner-yes'], env)).code).toBe(0);
    for (const line of (await sb.envLog()).filter(entry => /^(fy|fyd)\|/.test(entry))) {
      expect(line).toContain(`FY_HOME=${sb.v4home}|`);
      expect(line).toContain('FY_PORT=<unset>');
    }
  });

  test('P1-2: an FY_URL that is not this machine (a remote or forwarded address) is refused before anything is recorded', async () => {
    const sb = await box();
    const result = await sb.run('preflight', ['--notes', sb.notes], { FY_URL: 'https://fy.example.com:7777' });
    expect(result.code).toBe(1);
    expect(result.err).toContain('not this machine');
    expect(await exists(sb.notes)).toBe(false);
  });
});

describe('P1-3: any config-check error other than the one credential diagnostic stops before the daemon starts', () => {
  test('P1-3: a credential error AND a schema error in one report: exit 1, no daemon start', async () => {
    const sb = await box();
    await advance(sb, 'install');
    await sb.fake('fy', [
      { match: '--version', run: 'cat "$D/fy.version"' },
      {
        match: 'config check',
        err: 'logins/a.yaml KEY X holds a literal credential: use fy secret set NAME\nlimits.yaml: invalid schema',
        code: 1,
      },
      { match: 'daemon start', run: DAEMON_UP_SH },
    ]);
    const result = await sb.run('start');
    expect(result.code).toBe(1);
    expect(result.err).toContain('other than only a literal credential');
    expect((await sb.calls()).filter(line => line === 'fy daemon start')).toEqual([]);
    expect(await sb.notesText()).not.toContain('# starting-v5');
  });
});

describe('P1-4: a manual-install rollback finishes after the owner restored v4', () => {
  test('P1-4: refusal, owner restores the v4 programs, rerun: the second run completes and restarts v4', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'preflight');
    await writeFile(sb.notes, (await sb.notesText()).replace('KIND=standalone', 'KIND=manual'));
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

    const first = await sb.run('rollback', ['--owner-yes']);
    expect(first.code).toBe(1);
    expect(first.err).toContain('by hand');
    expect(await sb.notesText()).not.toContain('# rolled-back');

    await sb.state('fy.version', '4.291.12\n'); // the owner restored the v4 programs, as told
    await sb.state('fyd.version', '4.291.12\n');
    const second = await sb.run('rollback', ['--owner-yes']);
    expect(second.code).toBe(0);
    expect(second.out).toContain('the v4 programs are back');
    expect(await sb.notesText()).toContain('# rolled-back');
    expect(await sb.calls()).toContain('fy daemon start');
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
  });

  test('P1-4: a rerun while only fy (not fyd) is back is still refused', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'preflight');
    await writeFile(sb.notes, (await sb.notesText()).replace('KIND=standalone', 'KIND=manual'));
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
    expect((await sb.run('rollback', ['--owner-yes'])).code).toBe(1);
    await sb.state('fy.version', '4.291.12\n');
    expect((await sb.run('rollback', ['--owner-yes'])).code).toBe(1);
  });
});

describe('P1-5: the saved v4 programs are written once and never overwritten by a retry', () => {
  test('P1-5: install is swapped but fails, install is run again: the backup keeps the ORIGINAL bytes and rollback restores them', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'convert');
    // The updater swaps fy for a v5 program and THEN fails (an interrupted or failed update).
    await sb.fake('fy', [
      { match: '--version', out: '4.291.12' },
      {
        match: 'daemon update *',
        run: 'printf "#!/usr/bin/env bash\\necho 5.0.0\\n" > "$0"; echo 5.0.0 > "$D/fyd.version"',
        code: 1,
      },
      { match: 'daemon start' },
    ]);
    const v4Bytes = await readFile(join(sb.root, 'fakebin', 'fy'), 'utf8'); // the program before any update
    expect((await sb.run('install')).code).toBe(1);
    const aside = `${sb.v4home}-before-2026-11-13-1200-bin`;
    const saved = await readFile(join(aside, 'fy'), 'utf8');
    expect(saved).toBe(v4Bytes);
    expect(await readFile(join(sb.root, 'fakebin', 'fy'), 'utf8')).not.toBe(saved);

    const retry = await sb.run('install'); // fy now prints 5.0.0 and fyd is 5.0.0: the swap happened
    expect(await readFile(join(aside, 'fy'), 'utf8')).toBe(saved); // NEVER overwritten with v5
    expect(retry.code).toBe(0);
    expect(retry.out).toContain('already happened');
    expect((await sb.calls()).filter(line => line.startsWith('fy daemon update'))).toHaveLength(1);

    const result = await sb.run('rollback', ['--owner-yes']);
    expect(result.code).toBe(0);
    expect(await readFile(join(sb.root, 'fakebin', 'fy'), 'utf8')).toBe(saved);
  });

  test('P1-5: a retry whose programs differ from the backup and are not the target release refuses with a sentence', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'convert');
    await sb.fake('fy', [
      { match: '--version', out: '4.291.12' },
      { match: 'daemon update *', code: 1 },
    ]);
    expect((await sb.run('install')).code).toBe(1);
    const aside = `${sb.v4home}-before-2026-11-13-1200-bin`;
    const saved = await readFile(join(aside, 'fy'), 'utf8');
    await writeFile(join(sb.root, 'fakebin', 'fy'), '#!/usr/bin/env bash\necho 4.999.0\n', { mode: 0o755 });
    const retry = await sb.run('install');
    expect(retry.code).toBe(1);
    expect(retry.err).toContain('will not overwrite that backup');
    expect(await readFile(join(aside, 'fy'), 'utf8')).toBe(saved);
  });
});

describe('P1-6: FY_URL credentials are never copied, printed or kept', () => {
  const cases: [string, string][] = [
    ['a query-string token', `http://127.0.0.1:7777?token=${SECRET_VALUE}`],
    ['a query after a path', `http://127.0.0.1:7777/x?token=${SECRET_VALUE}`],
    ['a fragment', `http://127.0.0.1:7777#${SECRET_VALUE}`],
    ['an encoded query', `http://127.0.0.1:7777/?%74oken=${SECRET_VALUE}`],
  ];
  for (const [name, url] of cases) {
    test(`P1-6: FY_URL with ${name} is recorded as scheme://host:port only, "query present", and the value appears nowhere`, async () => {
      const sb = await box();
      const result = await sb.run('preflight', ['--notes', sb.notes], { FY_URL: url });
      expect(result.code).toBe(0);
      const notes = await sb.notesText();
      expect(notes).toContain('FY_URL=http://127.0.0.1:7777\n');
      expect(notes).toContain('FY_URL_EXTRA=present');
      expect(notes).not.toContain(SECRET_VALUE);
      expect(result.all).not.toContain(SECRET_VALUE);
      expect(await leaks(sb, SECRET_VALUE)).toEqual([]);
      // The recorded address is what v4 is later called with: no query.
      const earlier = (await sb.envLog()).length; // preflight's own --version call sees the caller's shell
      expect((await sb.run('baseline', ['--asks-open', '0'])).code).toBe(0);
      const later = (await sb.envLog()).slice(earlier).filter(entry => entry.startsWith('fy|'));
      expect(later.length).toBeGreaterThan(0);
      for (const line of later) expect(line).toContain('FY_URL=http://127.0.0.1:7777|');
      expect((await sb.envLog()).slice(earlier).join('\n')).not.toContain(SECRET_VALUE);
    });
  }

  test('P1-6: credentials before the host (user:pass@) are refused with a name-only remedy and nothing is written', async () => {
    const sb = await box();
    const result = await sb.run('preflight', ['--notes', sb.notes], {
      FY_URL: `http://user:${SECRET_VALUE}@127.0.0.1:7777`,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('carries credentials');
    expect(result.all).not.toContain(SECRET_VALUE);
    expect(await exists(sb.notes)).toBe(false);
    expect(await leaks(sb, SECRET_VALUE)).toEqual([]);
  });

  test('P1-6: a plain loopback address is recorded as it is', async () => {
    const sb = await box();
    expect((await sb.run('preflight', ['--notes', sb.notes], { FY_URL: 'http://127.0.0.1:7777' })).code).toBe(0);
    expect(await sb.notesText()).toContain('FY_URL_EXTRA=none');
  });
});

describe('P1-7: a rehearsal refuses the default home in PREFLIGHT, before anything is stopped, moved or converted', () => {
  const rehearsal = { MIGRATE_REHEARSAL: '1' };

  test('P1-7: MIGRATE_REHEARSAL=1 with the default home: preflight exit 1, no notes, no program called, the home untouched', async () => {
    const sb = await box({ homeName: '.ferretry', tag: null });
    const result = await sb.run('preflight', ['--notes', sb.notes], rehearsal);
    expect(result.code).toBe(1);
    expect(result.err).toContain('never for a real home');
    expect(await exists(sb.notes)).toBe(false);
    expect(await sb.calls()).toEqual([]); // no fy, fyd, tmux, bun: nothing stopped, moved or converted
    expect(await exists(`${sb.v4home}-before-2026-11-13-1200`)).toBe(false);
    expect(await readFile(join(sb.v4home, 'layout-version'), 'utf8')).toBe('2\n');
    expect(await exists(join(sb.v4home, 'home.json'))).toBe(false);
  });

  test('P1-7: the default home reached through a symlink is refused in preflight, too', async () => {
    const sb = await box({ homeName: 'real-home', tag: null });
    await symlink(sb.v4home, join(sb.home, '.ferretry'));
    const result = await sb.run('preflight', ['--notes', sb.notes], rehearsal);
    expect(result.code).toBe(1);
    expect(result.err).toContain('never for a real home');
    expect(await sb.calls()).toEqual([]);
    expect(await exists(join(sb.v4home, 'layout-version'))).toBe(true);
  });

  test('P1-7: a tagged checkout with MIGRATE_REHEARSAL=1 on the default home is refused as well', async () => {
    const sb = await box({ homeName: '.ferretry' });
    expect((await sb.run('preflight', ['--notes', sb.notes], rehearsal)).code).toBe(1);
  });

  test('P1-7: defense in depth: notes that say rehearsal on the default home are refused again by quiet, before any stop', async () => {
    const sb = await box({ homeName: '.ferretry' });
    await advance(sb, 'baseline');
    await writeFile(sb.notes, (await sb.notesText()).replace('REHEARSAL=0', 'REHEARSAL=1'));
    const stopsBefore = (await sb.calls()).filter(line => line === 'fy daemon stop').length;
    const result = await sb.run('quiet', ['--owner-confirmed']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('never for a real home');
    expect((await sb.calls()).filter(line => line === 'fy daemon stop').length).toBe(stopsBefore);
  });

  test('P1-7: a rehearsal in a fake sandbox home is still accepted', async () => {
    const sb = await box({ tag: null });
    expect((await sb.run('preflight', ['--notes', sb.notes], rehearsal)).code).toBe(0);
  });
});

describe('P1-8: a damaged or unreadable v5 secret store is a FAIL, even when the baseline had no names', () => {
  const verifyAgainst = async (sb: Sandbox, secretLs: { out?: string; code?: number }): Promise<string> => {
    await advance(sb, 'start');
    await writeFile(join(baselineFolder(sb), 'secrets.txt'), ''); // a v4 with NO named secrets
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
      { match: 'board --project all --state open*', run: 'cat "$D/board-open.json"' },
      { match: 'board *', run: 'cat "$D/board-closed.json"' },
      { match: 'secret ls --json', ...secretLs },
      { match: 'ask', out: 'no asks are waiting' },
      { match: 'doctor' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(1);
    expect(await sb.notesText()).not.toContain('# verified');
    return result.out;
  };

  test('P1-8: baseline with zero names, v5 answers health "damaged" and no names: FAIL, never OK', async () => {
    const sb = await box();
    const out = await verifyAgainst(sb, { out: '{"v":1,"health":"damaged","secrets":[]}' });
    expect(out).toMatch(/secret names .* FAIL/);
    expect(out).not.toMatch(/secret names .* OK/);
  });

  test('P1-8: empty stdout from a successful call is FAIL', async () => {
    const out = await verifyAgainst(await box(), {});
    expect(out).toMatch(/secret names .* FAIL/);
  });

  test('P1-8: a listing with no health field is FAIL (only "ready" is a readable vault)', async () => {
    const out = await verifyAgainst(await box(), { out: '{"secrets":[]}' });
    expect(out).toMatch(/secret names .* FAIL/);
  });

  test('P1-8: a healthy empty listing against a zero-name baseline is OK', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await writeFile(join(baselineFolder(sb), 'secrets.txt'), '');
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
      { match: 'board --project all --state open*', run: 'cat "$D/board-open.json"' },
      { match: 'board *', run: 'cat "$D/board-closed.json"' },
      { match: 'secret ls --json', out: '{"v":1,"health":"ready","secrets":[]}' },
      { match: 'ask', out: 'no asks are waiting' },
      { match: 'doctor' },
    ]);
    const result = await sb.run('verify');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/secret names .* OK/);
  });
});

describe('P2: exact fyd tag, the ask parser, and no secret value ever on disk', () => {
  test('P2 exact fyd tag: fy is the tag but fyd is another 5.x: install refuses', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.fake('brew', [
      { match: 'list --cask', out: 'ferretry@4' },
      { match: 'uninstall --cask *' },
      { match: 'install --cask *', run: 'echo 5.0.0 > "$D/fy.version"; echo 5.0.1 > "$D/fyd.version"' },
    ]);
    const result = await sb.run('install');
    expect(result.code).toBe(1);
    expect(result.err).toContain('fy and fyd must both be the selected release');
  });

  test('P2 ask parser: a real ask whose title says "no asks are waiting" is counted, not read as an empty list', async () => {
    const sb = await box();
    await advance(sb, 'start');
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v5.json"' },
      { match: 'board --project all --state open*', run: 'cat "$D/board-open.json"' },
      { match: 'board *', run: 'cat "$D/board-closed.json"' },
      { match: 'secret ls --json', out: '{"health":"ready","secrets":[{"name":"API_KEY"}]}' },
      { match: 'ask', out: 'ASK  FROM  ASKING\na1  f1  no asks are waiting here' },
      { match: 'doctor' },
    ]);
    const result = await sb.run('verify');
    expect(result.out).toMatch(/asks .* REVIEW .*v5 lists 1, the owner counted 0/);
  });

  test('P2 transient secret: a baseline that dies right after the secret listing leaves no secret value on disk', async () => {
    const sb = await box();
    await advance(sb, 'preflight');
    await sb.fake('fy', [
      { match: 'ps -a --json', run: 'cat "$D/ps.v4.json"' },
      { match: 'board *', run: 'echo \'{"cards":[],"nextCursor":null}\'' },
      {
        match: 'secret ls --json',
        // The names file is made un-writable, so the script stops right after the producer returned its value.
        run: `mkdir "${join(baselineFolder(sb), 'secrets.txt')}"`,
        out: JSON.stringify({ health: 'ready', secrets: [{ name: 'API_KEY', value: SECRET_VALUE }] }),
      },
    ]);
    const result = await sb.run('baseline', ['--asks-open', '0']);
    expect(result.code).not.toBe(0);
    expect(await leaks(sb, SECRET_VALUE)).toEqual([]);
  });
});
