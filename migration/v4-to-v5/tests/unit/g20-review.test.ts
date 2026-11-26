import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, link, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settingsStep } from '../../src/steps/settings.ts';
import { hostLockProbe } from '../../src/preflight.ts';
import { releaseLease } from '../../src/cutover-lease.ts';
import { manifest, moveNoReplace, recoveryCopy, verifyManifests } from '../../src/recovery-copy.ts';
import { fixture } from './ferret-fixture.ts';
import { advance, DAEMON_UP_SH, makeSandbox, type Sandbox } from './migrate-harness.ts';

setDefaultTimeout(60_000);
let f: Awaited<ReturnType<typeof fixture>>;
let sb: Sandbox;
beforeEach(async () => {
  f = await fixture();
  sb = await makeSandbox();
});
afterEach(async () => {
  await sb.cleanup();
  await f.clean();
});

// Fixed synthetic provider shapes: one fixture for every KNOWN_SHAPES alternative, including each GitHub/Slack kind.
const SHAPES = [
  'sk-ant-' + 'a'.repeat(16),
  'sk-or-' + 'a'.repeat(16),
  'sk-' + 'a'.repeat(24),
  'sk-proj-' + 'a'.repeat(24),
  'AKIA' + 'A'.repeat(16),
  'ASIA' + 'A'.repeat(16),
  ...['p', 'o', 'u', 's', 'r'].map(k => `gh${k}_${'a'.repeat(24)}`),
  'github_pat_' + 'a'.repeat(24),
  ...['a', 'b', 'p', 'r', 's'].map(k => `xox${k}-${'a'.repeat(16)}`),
  'gsk_' + 'a'.repeat(24),
  'csk-' + 'a'.repeat(24),
  'AIza' + 'a'.repeat(32),
  'glpat-' + 'a'.repeat(20),
];
test.each(SHAPES)('MUST 3: settings report masks provider-shaped key %p', async key => {
  await mkdir(join(f.from, 'config/components/settings'), { recursive: true });
  await writeFile(
    join(f.from, 'config/components/settings/odd.yaml'),
    `harness: claude\nenv:\n  ${key}: \${secret:FAKE}\n`,
  );
  const said = JSON.stringify(await settingsStep.run(f.ctx()));
  expect(said).not.toContain(key);
  expect(said).toContain('<key>');
});

test('MUST 2: absolute-path profile dry run and moved real run both finish and write home.json', async () => {
  await writeFile(join(f.from, 'layout-version'), '2\n');
  await mkdir(join(f.from, 'fleet/assets'), { recursive: true });
  await writeFile(join(f.from, 'fleet/assets/claude.json'), '{"permissions":{"allow":[]}}');
  await mkdir(join(f.from, 'config/components/settings'), { recursive: true });
  await mkdir(join(f.from, 'config/profiles'), { recursive: true });
  await writeFile(
    join(f.from, 'config/components/settings/absolute.yaml'),
    `harness: claude\nfile: ${f.from}/fleet/assets/claude.json\n`,
  );
  await writeFile(join(f.from, 'config/profiles/main.yaml'), 'contents: [settings/absolute]\n');
  const lease = join(f.root, 'lease');
  const keeper = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../../src/cutover-lease.ts'), 'start', f.from, lease],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  expect(await keeper.exited).toBe(0);
  const run = async (source: string, dry: boolean) => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '../../src/main.ts'),
        '--from',
        source,
        '--to',
        f.to,
        '--original-home',
        f.from,
        '--cutover-lease',
        lease,
        '--report',
        join(f.root, dry ? 'dry.json' : 'real.json'),
        ...(dry ? ['--dry-run'] : []),
      ],
      {
        env: { ...process.env, HOME: f.root, FY_HOME: source },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, err, summary: out.split('\n').filter(line => /pending|failed/.test(line)) }).toEqual({
      code: 0,
      err: '',
      summary: [],
    });
  };
  try {
    await run(f.from, true);
    expect(
      await stat(f.to).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const moved = f.from + '-backup';
    await rename(f.from, moved);
    await run(moved, false);
    expect(
      await stat(join(f.to, 'home.json')).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  } finally {
    await releaseLease(lease);
  }
});

async function sqliteDaemon(path: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `import {Database} from 'bun:sqlite'; const db=new Database(process.argv[1],{create:true}); db.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); console.log('locked'); for await (const _ of Bun.stdin.stream()) {} db.close();`,
      path,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
  return {
    child,
    async stop() {
      child.stdin.end();
      await child.exited;
    },
  };
}

test('MUST 1: fake v4 daemon holding its actual SQLite lock refuses backup without moving home', async () => {
  await advance(sb, 'quiet');
  const daemon = await sqliteDaemon(join(sb.v4home, 'daemon.lock'));
  try {
    const result = await sb.run('backup', ['--owner-yes']);
    expect(result.code).not.toBe(0);
    expect(
      await stat(join(sb.v4home, 'layout-version')).then(
        () => true,
        () => false,
      ),
    ).toBe(true);
  } finally {
    await daemon.stop();
  }
});

test('MUST 1: backup keeps an independent verified recovery copy of every data file', async () => {
  await advance(sb, 'backup');
  const notes = await sb.notesText();
  const backup = notes.match(/^B=(.*)$/m)?.[1] ?? '';
  expect(await readFile(join(backup + '.recovery', 'state/secrets.json'), 'utf8')).toBe(
    await readFile(join(backup, 'state/secrets.json'), 'utf8'),
  );
  expect(await readFile(backup + '.recovery.manifest.json', 'utf8')).toContain('sha256');
  expect((await stat(join(backup, 'state/secrets.json'))).ino).not.toBe(
    (await stat(join(backup + '.recovery', 'state/secrets.json'))).ino,
  );
  expect((await stat(backup + '.recovery')).mode & 0o777).toBe(0o700);
});

test('MUST 1: a daemon opening a hard-link alias is detected by lock dev+inode', async () => {
  const lock = join(f.from, 'daemon.lock'),
    alias = join(f.root, 'alias');
  await writeFile(lock, '');
  await link(lock, alias);
  const daemon = await sqliteDaemon(alias);
  try {
    expect(await hostLockProbe().held(lock)).toBe(true);
  } finally {
    await daemon.stop();
  }
});

test('MUST 1: unreadable process information refuses to call the lock absent', async () => {
  const proc = join(f.root, 'proc'),
    fd = join(proc, '123/fd'),
    lock = join(f.from, 'daemon.lock');
  await writeFile(lock, '');
  await mkdir(fd, { recursive: true });
  await chmod(fd, 0);
  try {
    expect(await hostLockProbe(proc).held(lock)).toBeUndefined();
  } finally {
    await chmod(fd, 0o700);
  }
});

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const helperRules = [
  { match: 'install --frozen-lockfile' },
  { match: 'src/cutover-lease.ts*', run: `exec ${q(process.execPath)} "$@"` },
  { match: 'src/recovery-copy.ts*', run: `exec ${q(process.execPath)} "$@"` },
];

test('MUST 1: racing v4 restarts during dry and real passes cannot acquire the daemon lock', async () => {
  await advance(sb, 'quiet');
  const attempt = `import {Database} from 'bun:sqlite'; import {writeFileSync} from 'node:fs'; const db=new Database(process.argv[1],{create:true}); try {db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); writeFileSync(process.argv[2], 'acquired');} catch {writeFileSync(process.argv[2], 'blocked');} db.close();`;
  await sb.fake('bun', [
    ...helperRules,
    {
      match: 'src/main.ts*--dry-run*',
      run: `${q(process.execPath)} -e ${q(attempt)} "$FAKE_H/daemon.lock" "$D/restart-dry"`,
    },
    {
      match: 'src/main.ts*',
      run: `${q(process.execPath)} -e ${q(attempt)} "$3/daemon.lock" "$D/restart-real"; mkdir -p "$FAKE_H"; echo '{}' > "$FAKE_H/home.json"`,
    },
  ]);
  expect((await sb.run('backup', ['--owner-yes'])).code).toBe(0);
  expect((await sb.run('convert')).code).toBe(0);
  expect(await sb.readState('restart-dry')).toBe('blocked');
  expect(await sb.readState('restart-real')).toBe('blocked');
});

test('MUST 1: a destination planted during the dry run cannot nest or replace the home', async () => {
  await advance(sb, 'quiet');
  const backup = (await sb.notesText()).match(/^B=(.*)$/m)?.[1] ?? '';
  await sb.fake('bun', [
    ...helperRules,
    { match: 'src/main.ts*--dry-run*', run: `mkdir ${q(backup)}; echo planted > ${q(join(backup, 'sentinel'))}` },
  ]);
  const result = await sb.run('backup', ['--owner-yes']);
  expect(result.code).not.toBe(0);
  expect(
    await stat(join(sb.v4home, 'layout-version')).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
  expect(await readFile(join(backup, 'sentinel'), 'utf8')).toBe('planted\n');
  expect(
    await stat(join(backup, 'v4home')).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test('MUST 1: atomic no-replace move refuses a directory appearing at the last instant', async () => {
  await writeFile(join(f.from, 'kept'), 'session-data');
  await mkdir(f.to);
  await writeFile(join(f.to, 'sentinel'), 'existing');
  expect(() => moveNoReplace(f.from, f.to)).toThrow('without replacing');
  expect(await readFile(join(f.from, 'kept'), 'utf8')).toBe('session-data');
  expect(await readFile(join(f.to, 'sentinel'), 'utf8')).toBe('existing');
});

test('MUST 1: disk-space shortfall refuses before any copy or move', async () => {
  await writeFile(join(f.from, 'kept'), 'session-data');
  await expect(recoveryCopy(f.from, f.to, async () => ({ bsize: 4096, bavail: 0 }))).rejects.toThrow(
    'not enough disk space',
  );
  expect(await readFile(join(f.from, 'kept'), 'utf8')).toBe('session-data');
  expect(
    await stat(f.to).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test('MUST 1: equal counts and sizes with different contents fail hash verification', async () => {
  await mkdir(f.to);
  await writeFile(join(f.from, 'data'), 'before');
  await writeFile(join(f.to, 'data'), 'after!');
  const original = await manifest(f.from),
    damaged = await manifest(f.to);
  expect(original.map(e => e.size)).toEqual(damaged.map(e => e.size));
  expect(() => verifyManifests(original, damaged)).toThrow('content hashes');
});

test('MUST 1: a lost lease refuses the real conversion before creating a new home', async () => {
  await advance(sb, 'backup');
  const lease = (await sb.notesText()).match(/^LEASE=(.*)$/m)?.[1] ?? '';
  await releaseLease(lease);
  const result = await sb.run('convert');
  expect(result.code).not.toBe(0);
  expect(result.err).toContain('exclusion was lost');
  expect(
    await stat(sb.v4home).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test('MUST 1: a failed dry pass releases its lease so backup can be retried', async () => {
  await advance(sb, 'quiet');
  await sb.state('dry.code', '3');
  expect((await sb.run('backup', ['--owner-yes'])).code).toBe(3);
  await sb.state('dry.code', '0');
  expect((await sb.run('backup', ['--owner-yes'])).code).toBe(0);
});

test('SMALL 4: FOUND is not printed if the retry stop leaves a daemon alive', async () => {
  await advance(sb, 'baseline');
  await writeFile(join(sb.v4home, 'state/sessions/f1/agenda-history.jsonl.pending'), '{}');
  await sb.fake('fy', [{ match: 'daemon stop' }, { match: 'daemon start', run: DAEMON_UP_SH }]);
  const result = await sb.run('quiet', ['--owner-confirmed']);
  expect(result.code).not.toBe(0);
  expect(result.out).not.toContain('FOUND:');
  expect(result.err).toContain('retry could not prove v4 stopped');
});

test('SMALL 4: rollback restores the original home mode, and dry run says its report is written', async () => {
  await chmod(sb.v4home, 0o750);
  await advance(sb, 'quiet');
  const backup = await sb.run('backup', ['--owner-yes']);
  expect(backup.code).toBe(0);
  expect(backup.out).toContain('writes its report');
  expect((await sb.run('rollback', ['--owner-yes'])).code).toBe(0);
  expect((await stat(sb.v4home)).mode & 0o777).toBe(0o750);
});
