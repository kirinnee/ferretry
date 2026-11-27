import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifest, recoveryCopy } from '../../src/recovery-copy.ts';
import { advance, makeSandbox, type Sandbox } from './migrate-harness.ts';

setDefaultTimeout(60_000);
let sb: Sandbox;
let root: string;
let helper: string;
let lease: string;
let backup: string;
beforeEach(async () => {
  sb = await makeSandbox();
  root = await mkdtemp(join(tmpdir(), 'g20-cutover-'));
  helper = join(root, 'src/cutover-lease.ts');
  lease = join(dirname(sb.v4home), 'test-lease');
  backup = sb.v4home + '-backup';
  await mkdir(dirname(helper));
  for (const name of ['cutover-lease.ts', 'cutover-home.ts', 'recovery-copy.ts'])
    await cp(join(import.meta.dir, '../../src', name), join(dirname(helper), name));
});
afterEach(async () => {
  await run('release', lease);
  await sb.cleanup();
  await rm(root, { recursive: true, force: true });
});
async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, helper, ...args], {
    env: { ...process.env, HOME: root, FY_HOME: sb.v4home },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}
async function inject(file: string, before: string, inserted: string) {
  const path = join(dirname(helper), file);
  const source = await readFile(path, 'utf8');
  expect(source).toContain(before);
  await writeFile(path, source.replace(before, inserted + '\n' + before));
}
// This fake uses v4's actual SQLite lock and its absent-home bootstrap, never a real daemon or port.
const restart = `import {Database} from 'bun:sqlite'; import {mkdirSync,writeFileSync} from 'node:fs';
let db; try { mkdirSync(process.argv[1],{recursive:true}); db=new Database(process.argv[1]+'/daemon.lock',{create:true});
db.exec('PRAGMA journal_mode=MEMORY; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); writeFileSync(process.argv[2],'locked'); }
catch { writeFileSync(process.argv[2],'blocked'); } finally { db?.close(); }`;

test('A: a v4 home displaced after the last check is preserved and reported through release', async () => {
  await inject(
    'cutover-lease.ts',
    'exchangePaths(staged, home);',
    `
    const fs = await import('node:fs');
    fs.renameSync(home, home+'.saved-placeholder');
    fs.mkdirSync(home+'/state/sessions/only-session', {recursive:true});
    fs.writeFileSync(home+'/state/sessions/only-session/history', 'irreplaceable');
    const fake = Bun.spawnSync([process.execPath, '-e', ${JSON.stringify(restart)}, home, home+'.restart']);
    if (fake.exitCode !== 0) throw new Error('fake v4 failed');
  `,
  );
  expect((await run('start', sb.v4home, lease)).code).toBe(0);
  expect((await run('move', lease, backup, join(root, 'notes'))).code).toBe(0);
  const prepared = await run('prepare', lease, backup);
  const released = await run('release', lease);
  const displaced = join(lease, 'new-home');
  expect(await readFile(sb.v4home + '.restart', 'utf8')).toBe('locked');
  expect(prepared.code).not.toBe(0);
  expect(prepared.err + released.err + released.out).toContain(displaced);
  expect(await readFile(join(displaced, 'state/sessions/only-session/history'), 'utf8')).toBe('irreplaceable');
});

test('A: release never recursively deletes an unrecognised entry in a private lease', async () => {
  expect((await run('start', sb.v4home, lease)).code).toBe(0);
  await mkdir(join(lease, 'unexpected-session'));
  await writeFile(join(lease, 'unexpected-session/history'), 'only copy');
  const result = await run('release', lease);
  expect(await readFile(join(lease, 'unexpected-session/history'), 'utf8')).toBe('only copy');
  expect(result.out + result.err).toContain(lease);
});

test('B: fake v4 cannot bootstrap between any backup rename and the placeholder', async () => {
  const path = join(dirname(helper), 'recovery-copy.ts');
  let source = await readFile(path, 'utf8');
  const probe = `\nif (from === ${JSON.stringify(sb.v4home)} || to === ${JSON.stringify(sb.v4home)}) {
    Bun.spawnSync([process.execPath, '-e', ${JSON.stringify(restart)}, ${JSON.stringify(sb.v4home)}, ${JSON.stringify(join(root, 'restart'))}]);
  }`;
  source = source
    .replace('renamePaths(from, to, false);', 'renamePaths(from, to, false);' + probe)
    .replace('renamePaths(from, to, true);', 'renamePaths(from, to, true);' + probe);
  await writeFile(path, source);
  expect((await run('start', sb.v4home, lease)).code).toBe(0);
  const result = await run('move', lease, backup, join(root, 'notes'));
  expect(await readFile(join(root, 'restart'), 'utf8')).toBe('blocked');
  expect(result.code).toBe(0);
  expect((await lstat(sb.v4home)).isFile()).toBe(true);
  expect(await readFile(join(backup, 'state/sessions/f1/terminal-pane.json'), 'utf8')).toContain('f1');
});

test('C: notes on another filesystem do not determine the exchange staging filesystem', async () => {
  if (process.platform !== 'linux') return;
  const notesDir = await mkdtemp('/dev/shm/g20-notes-');
  try {
    expect((await lstat(notesDir)).dev).not.toBe((await lstat(sb.v4home)).dev);
    await advance(sb, 'quiet');
    const notes = join(notesDir, 'run.notes');
    await copyFile(sb.notes, notes);
    expect((await sb.run('backup', ['--owner-yes', '--notes', notes])).code).toBe(0);
    const recorded = (await readFile(notes, 'utf8')).match(/^LEASE=(.*)$/m)?.[1] ?? '';
    const result = await sb.run('convert', ['--notes', notes]);
    expect(result.code).toBe(0);
    expect(dirname(recorded)).toBe(dirname(sb.v4home));
    expect((await lstat(join(sb.v4home, 'home.json'))).isFile()).toBe(true);
  } finally {
    // Also release an old implementation's cross-filesystem keeper on a failing red run.
    const recorded = await readFile(join(notesDir, 'run.notes'), 'utf8').catch(() => '');
    const oldLease = recorded.match(/^LEASE=(.*)$/m)?.[1];
    if (oldLease !== undefined) await run('release', oldLease);
    await rm(notesDir, { recursive: true, force: true });
  }
});

test('D: release between backup and conversion keeps the proof needed for rollback', async () => {
  await advance(sb, 'backup');
  lease = (await sb.notesText()).match(/^LEASE=(.*)$/m)?.[1] ?? '';
  expect((await run('release', lease)).code).toBe(0);
  const result = await sb.run('rollback', ['--owner-yes']);
  expect({ code: result.code, err: result.err }).toEqual({ code: 0, err: '' });
  expect(await readFile(join(sb.v4home, 'state/sessions/f1/terminal-pane.json'), 'utf8')).toContain('f1');
});

test('E: the published private recovery root matches its verified mode manifest', async () => {
  await chmod(sb.v4home, 0o750);
  const copied = join(root, 'recovery');
  await recoveryCopy(sb.v4home, copied);
  expect(await manifest(copied)).toEqual(JSON.parse(await readFile(copied + '.manifest.json', 'utf8')));
  expect((await lstat(copied)).mode & 0o777).toBe(0o700);
  expect((await lstat(sb.v4home)).mode & 0o777).toBe(0o750);
});
