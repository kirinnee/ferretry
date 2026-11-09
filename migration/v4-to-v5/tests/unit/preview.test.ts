import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './ferret-fixture.ts';
import { STEPS } from '../../src/steps/index.ts';
import { dryRun, prepare, stagingFor, wrapperText } from '../../preview/driver.ts';
import { decide, PREVIEW, SKIPPED_STEPS, stepPlan } from '../../preview/plan.ts';
import { compare, snapshot } from '../../preview/proof.ts';
import { stage, walk } from '../../preview/stage.ts';

/** A value no real file holds: if it is found in a copy, a credential path was copied. */
const SENTINEL = 'SENTINEL-NOT-A-REAL-CREDENTIAL';

let root: string;
let v4: string;
let fixtureOf: Awaited<ReturnType<typeof fixture>>;

async function put(relative: string, text: string): Promise<void> {
  const path = join(v4, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
}

async function everyFile(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) out.push(...(await everyFile(path)));
    else out.push(path);
  }
  return out;
}

async function plantedHome(): Promise<void> {
  await put('layout-version', '2\n');
  await put('config/machine.yaml', 'timeZone: UTC\n');
  await put('config/daemon.json', `{"port":7457,"note":"${SENTINEL}"}`);
  await put('api-token', SENTINEL);
  await put('api-warden-token', SENTINEL);
  await put('fleet/credentials/work/.credentials.json', SENTINEL);
  await put('fleet/homes/h1/.claude/auth.json', SENTINEL);
  await put('state/secrets.key', SENTINEL);
  await put('state/secrets.json', SENTINEL);
  await put('state/daemon-identity.json', SENTINEL);
  await put('state/devices.json', SENTINEL);
  await put('state/passkeys.json', SENTINEL);
  await put('state/session-message-token.key', SENTINEL);
  await put('state/catalogs/link-keys.json', SENTINEL);
  await put('state/mcp-oauth-secrets.json', SENTINEL);
  await put('state/login-secrets.json', SENTINEL);
  await put('state/sessions/s1/environment.json', SENTINEL);
  await put('state/sessions/s1/terminal-pane.json', SENTINEL);
  await put('state/sessions/s1/last-snapshot.txt', SENTINEL);
  await put('state/sessions/s1/media/x.png', SENTINEL);
  await put('state/projects.json', '[]');
  await fixtureOf.session('s1');
  await fixtureOf.put('state/sessions/s1/state.json', {
    id: 's1',
    status: 'completed',
    turn: 0,
    finishedAt: '2026-11-01T00:00:00.000Z',
  });
  await symlink('/etc/hostname', join(v4, 'config', 'machine-link.yaml'));
}

beforeEach(async () => {
  fixtureOf = await fixture();
  root = fixtureOf.root;
  v4 = fixtureOf.from;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the plan', () => {
  test('every skipped step id names a real step, and the terminals step is among them', () => {
    expect(stepPlan().unknown).toEqual([]);
    expect(SKIPPED_STEPS.map(step => step.id)).toContain('terminals');
    expect(stepPlan().run.map(step => step.id)).not.toContain('terminals');
    expect(stepPlan().run.length + stepPlan().skipped.length).toBe(STEPS.length);
  });

  test('a step that no longer exists is reported, not ignored', () => {
    expect(stepPlan(STEPS.filter(step => step.id !== 'gate')).unknown).toEqual(['gate']);
  });

  test.each([
    ['api-token', false],
    ['fleet/credentials', true],
    ['fleet/homes', true],
    ['fleet/credentials/x/.credentials.json', false],
    ['state/secrets.key', false],
    ['state/daemon-identity.json', false],
    ['config/daemon.json', false],
    ['config/daemon.json.pre-carriers.2026', false],
    ['state/sessions/s1/environment.json', false],
    ['state/sessions/s1/terminal-pane.json', false],
    ['state/sessions/s1/last-snapshot.txt', false],
    ['state/sessions/s1/media', true],
    ['state/catalogs', true],
    ['state/unknown-new-file.json', false],
  ])('%s is left behind', (path, folder) => {
    expect(decide(path, folder).verdict).toBe('leave');
  });

  test.each([
    ['layout-version', false, 'copy'],
    ['config/machine.yaml', false, 'copy'],
    ['config/runtimes/a.yaml', false, 'copy'],
    ['state/sessions', true, 'descend'],
    ['state/sessions/s1', true, 'descend'],
    ['state/sessions/s1/config.json', false, 'copy'],
    ['state/sessions/s1/turns', true, 'descend'],
    ['state/sessions/s1/turns/turn-001.md', false, 'copy'],
    ['state/attachments/d/s/a/manifest.json', false, 'copy'],
    ['state/attachments/d/s/a/original.bin', false, 'leave'],
  ] as const)('%s is %s', (path, folder, verdict) => {
    expect(decide(path, folder).verdict).toBe(verdict);
  });
});

describe('the copy', () => {
  test('copies the allowed files and no credential, and never lists a refused folder', async () => {
    await plantedHome();
    await put('state/sessions/s1/config.json', '{}');
    await put('state/sessions/s1/channel/queue.jsonl', '');
    const walked = await walk(v4);
    const paths = walked.files.map(file => file.path);
    expect(paths).toContain('state/sessions/s1/config.json');
    expect(paths).toContain('state/sessions/s1/channel/queue.jsonl');
    expect(paths.some(path => path.includes('credentials') || path.includes('homes'))).toBe(false);
    expect(walked.left.some(row => row.path === 'fleet/credentials' && row.folder)).toBe(true);
    expect(walked.left.some(row => row.path.startsWith('fleet/credentials/'))).toBe(false);
    expect(walked.left.find(row => row.path === 'config/machine-link.yaml')?.why).toContain('link');

    const staging = join(root, 'staging');
    const report = await stage(v4, staging);
    expect(report.copied).toBe(paths.length);
    for (const file of await everyFile(staging)) expect(await readFile(file, 'utf8')).not.toContain(SENTINEL);
  });

  test('copies a SQLite file through the engine, WAL content included', async () => {
    await put('layout-version', '2\n');
    await put('state/sessions/s1/config.json', '{}');
    const path = join(v4, 'state/sessions/s1/agenda-versions/A1.sqlite');
    await mkdir(join(path, '..'), { recursive: true });
    const db = new Database(path);
    db.run('PRAGMA journal_mode = WAL');
    db.run('CREATE TABLE t (n INTEGER)');
    db.run('INSERT INTO t VALUES (7)');
    // The db stays open: its newest row is still in the -wal file, as with a live v4.
    const staging = join(root, 'staging');
    await stage(v4, staging);
    db.close();
    const copy = new Database(join(staging, 'state/sessions/s1/agenda-versions/A1.sqlite'), { readonly: true });
    expect(copy.query('SELECT n FROM t').get()).toEqual({ n: 7 });
    copy.close();
    expect((await everyFile(staging)).some(file => file.endsWith('-wal'))).toBe(false);
  });
});

describe('prepare', () => {
  const lock = { held: async () => false };
  const now = () => new Date('2026-11-09T00:00:00Z');

  test('makes a complete home with no credential in it, removes the staging copy and leaves v4 unchanged', async () => {
    await plantedHome();
    const target = fixtureOf.to;
    const done = await prepare({ v4Home: v4, target, lock, now });
    expect(done.summary).not.toContain(SENTINEL);
    expect(done.report?.complete).toBe(true);
    expect(done.report?.steps.map(step => step.id)).not.toContain('terminals');
    expect(done.proof).toEqual({ unchanged: true, changed: [] });
    expect(await readdir(root)).not.toContain(`${'v5'}.staging`);
    const files = await everyFile(target);
    expect(files.some(file => file.endsWith('home.json'))).toBe(true);
    for (const file of files) expect(await readFile(file, 'utf8')).not.toContain(SENTINEL);
    expect(files.some(file => /secrets|identity|credentials|api-token/u.test(file))).toBe(false);
  });

  test('refuses a target that already holds files', async () => {
    await plantedHome();
    const target = fixtureOf.to;
    await mkdir(target);
    await writeFile(join(target, 'x'), '');
    await expect(prepare({ v4Home: v4, target, lock, now })).rejects.toThrow('not empty');
  });

  test('asks the lock probe about the staging copy (which holds no lock) and removes it', async () => {
    await plantedHome();
    // preflight probes only a lock file the staging copy has; v4's own lock is the shell entry's check.
    const target = fixtureOf.to;
    const done = await prepare({ v4Home: v4, target, lock: { held: async () => true }, now });
    expect(done.report?.complete).toBe(true);
    expect(await readdir(root)).not.toContain('v5.staging');
  });
});

describe('the proof', () => {
  test('sees a changed config file and a changed credential stat, by path and never by value', async () => {
    await plantedHome();
    const before = await snapshot(v4);
    await put('config/machine.yaml', 'timeZone: Asia/Singapore\n');
    await put('api-token', `${SENTINEL}-grew`);
    const verdict = compare(before, await snapshot(v4));
    expect(verdict.unchanged).toBe(false);
    expect(verdict.changed).toContain('config/machine.yaml');
    expect(verdict.changed).toContain('api-token');
    expect(JSON.stringify(verdict)).not.toContain(SENTINEL);
  });

  test('reads no credential: snapshot holds hashes of config files and stat lines only', async () => {
    await plantedHome();
    const shot = await snapshot(v4);
    expect(JSON.stringify(shot)).not.toContain(SENTINEL);
    expect(Object.keys(shot.hashes)).not.toContain('config/daemon.json');
    expect(shot.stats['config/daemon.json']).toContain('size=');
  });
});

describe('the dry run and the wrapper', () => {
  test('a dry run writes nothing and says what it would do', async () => {
    await plantedHome();
    const target = fixtureOf.to;
    const text = await dryRun(v4, target);
    expect(text).toContain('DRY RUN');
    expect(text).toContain('terminals');
    expect(text).not.toContain(SENTINEL);
    expect(await readdir(root)).toEqual(['v4']);
    expect(stagingFor(target)).toBe(`${target}.staging`);
  });

  test('the wrapper pins the preview home and port, never v4 numbers, and starts no service', () => {
    const text = wrapperText('/h/.ferretry-v5');
    expect(text).toContain('FY_HOME="/h/.ferretry-v5"');
    expect(text).toContain(`FY_PORT="${PREVIEW.port}"`);
    expect(text).toContain(`FY_URL="http://127.0.0.1:${PREVIEW.port}"`);
    expect(text).not.toContain('7457');
    expect(text).not.toMatch(/systemctl|launchctl|install/u);
    expect(text).toContain('unset FY_TOKEN TMUX');
  });
});
