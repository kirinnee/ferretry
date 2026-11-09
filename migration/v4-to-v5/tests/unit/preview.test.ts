import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { statSync } from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, FAKE_HASH, RUNTIME } from './ferret-fixture.ts';
import { STEPS } from '../../src/steps/index.ts';
import { cleanPreview, dryRun, prepare, proofNow, shimText, stagingFor, wrapperText } from '../../preview/driver.ts';
import { gateFiles } from '../../preview/gate.ts';
import { guardTarget, hasMarker, PREVIEW_MARKER } from '../../preview/paths.ts';
import { decide, PREVIEW, SKIPPED_STEPS, stepPlan } from '../../preview/plan.ts';
import { claimPaths, compare, PROOF_FOLDER, proofPathFor, snapshot } from '../../preview/proof.ts';
import { stage, walk } from '../../preview/stage.ts';
import { stopPreview } from '../../preview/stop.ts';

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
    ['config/logins', true],
    ['config/logins/work.yaml', false],
    ['fleet/assets/skills/x/.env', false],
    ['fleet/assets/skills/x/.env.local', false],
    ['fleet/assets/skills/x/key.pem', false],
    ['fleet/assets/skills/x/id_ed25519', false],
    ['fleet/assets/skills/x/auth.json', false],
    ['fleet/assets/components/m/.credentials.json', false],
    ['fleet/assets/skills/x/github-token.txt', false],
    ['fleet/assets/skills/x/.netrc', false],
    ['fleet/assets/skills/x/.npmrc', false],
    ['fleet/assets/skills/x/store.p12', false],
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
    expect(done.proof).toEqual({ unchanged: true, changed: [], v4Wrote: [] });
    expect(done.gate).toEqual([]);
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
    const text = wrapperText('/h/.ferretry-v5', '/h/.ferretry');
    expect(text).toContain('FY_HOME="/h/.ferretry-v5"');
    expect(text).toContain(`FY_PORT="${PREVIEW.port}"`);
    expect(text).toContain(`FY_URL="http://127.0.0.1:${PREVIEW.port}"`);
    expect(text).not.toContain('7457');
    expect(text).not.toMatch(/systemctl|launchctl/u);
    expect(text).toContain('exec env -i');
    expect(text).toContain('FY_UPDATE_CHECK=off');
  });
});

/** A live-looking v4 ferret whose files hold REAL absolute paths into v4's home, as a running v4 writes them. */
async function liveFerretWithV4Paths(): Promise<void> {
  const wrapper = join(v4, 'fleet/bin/claude-work');
  await put('layout-version', '2\n');
  await put('config/machine.yaml', 'timeZone: UTC\nautoResume: true\n');
  await fixtureOf.session('live1', {
    harness: 'claude',
    agent: wrapper,
    command: [wrapper, '--resume', 'resume1'],
    tmuxSession: 'fy-live1',
    sessionCapabilityHash: FAKE_HASH,
    transcript: {
      v: 1,
      identity: 'minted',
      home: join(v4, 'fleet/homes', RUNTIME),
      file: join(v4, 'fleet/shared/claude/projects/p/resume1.jsonl'),
      harnessSessionId: 'resume1',
    },
    conversion: {
      v: 1,
      converter: 1,
      fromHarness: 'codex',
      fromConversation: 'thread-fake',
      fromFile: join(v4, 'fleet/shared/codex/sessions/2026/11/01/rollout-fake.jsonl'),
      toHarness: 'claude',
      toConversation: 'resume1',
      at: '2026-11-01T00:00:00.000Z',
      keptTurns: 2,
      omittedTurns: 0,
    },
  });
  await fixtureOf.put('state/sessions/live1/state.json', {
    id: 'live1',
    status: 'thinking',
    turn: 1,
    pid: 4242,
    promptReady: true,
    lastActivityAt: '2026-11-08T00:00:00.000Z',
  });
  await fixtureOf.put('state/worktrees.json', { version: 1, worktrees: [], intents: [] });
  await fixtureOf.pane('live1');
}

describe('the preview is a clean copy (C1, M1, M2, M3)', () => {
  const lock = { held: async () => false };
  const now = () => new Date('2026-11-09T00:00:00Z');

  test('C1 every converted ferret is stopped with no command, handle, transcript path, hash or worktree ledger', async () => {
    await liveFerretWithV4Paths();
    const target = fixtureOf.to;
    const done = await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    expect(done.report?.complete).toBe(true);
    expect(done.gate).toEqual([]);
    const folder = join(target, 'state/ferrets/live1');
    const record = JSON.parse(await readFile(join(folder, 'ferret.json'), 'utf8'));
    expect(record.state).toBe('stopped');
    expect(record.handle).toBeUndefined();
    expect(record.transcript).toBeUndefined();
    expect(record.harnessConversation).toBeUndefined();
    const config = JSON.parse(await readFile(join(folder, 'config.json'), 'utf8'));
    expect(config.command).toBeUndefined();
    expect(config.tmuxSession).toBeUndefined();
    expect(config.capabilityHash).toBeUndefined();
    expect(config.conversion).toBeUndefined();
    expect(config.transcript).toBeUndefined();
    expect(config.agent).not.toContain('/');
    const state = JSON.parse(await readFile(join(folder, 'state.json'), 'utf8'));
    expect(state.status).toBe('stopped');
    expect(state.pid).toBeUndefined();
    const written = await everyFile(target);
    expect(written.some(file => file.endsWith('tokens.json'))).toBe(false);
    expect(written.some(file => file.endsWith('worktrees.json'))).toBe(false);
    for (const file of written) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(`${v4}/`);
      expect(text).not.toContain(FAKE_HASH);
    }
  });

  test('M2 the runtimes config switches auto-resume off, whatever v4 said', async () => {
    await liveFerretWithV4Paths();
    const target = fixtureOf.to;
    await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    const runtimes = (await everyFile(join(target, 'config'))).filter(file => /runtimes\.ya?ml$/u.test(file));
    expect(runtimes.length).toBe(1);
    const text = await readFile(runtimes[0] as string, 'utf8');
    expect(text).toMatch(/autoResume: false/u);
    expect(text).not.toMatch(/autoResume: true/u);
  });

  test('M2 without a preview flag the converter still carries v4 as it was (normal behaviour unchanged)', async () => {
    await liveFerretWithV4Paths();
    const { convert } = await import('../../src/convert.ts');
    const result = await convert({
      from: v4,
      to: fixtureOf.to,
      dryRun: false,
      lock,
      now,
      host: { homeDirectory: root, env: {} },
      steps: stepPlan().run,
    });
    expect(result.kind).toBe('done');
    const record = JSON.parse(await readFile(join(fixtureOf.to, 'state/ferrets/live1/ferret.json'), 'utf8'));
    expect(record.state).toBe('working');
    expect((await everyFile(fixtureOf.to)).some(file => file.endsWith('tokens.json'))).toBe(true);
  });

  test('M3 logins are left out entirely: config/logins is not copied and the dry run says so', async () => {
    await liveFerretWithV4Paths();
    await put('config/logins/work.yaml', 'store: host\n');
    const target = fixtureOf.to;
    expect((await walk(v4)).files.some(file => file.path.startsWith('config/logins'))).toBe(false);
    expect(await dryRun(v4, target)).toContain('LOGINS ARE LEFT OUT ENTIRELY');
    const done = await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    expect(done.report?.complete).toBe(true);
    expect((await everyFile(target)).some(file => file.includes('/logins/'))).toBe(false);
  });

  test('MAJOR-3 free text that names a v4 path does not refuse the home, and is not redacted', async () => {
    await liveFerretWithV4Paths();
    await fixtureOf.session('talk1', {
      harness: 'claude',
      prompt: `read ${v4}/fleet/notes.md and ${join(root, 'home')}/.claude/settings.json`,
    });
    const target = fixtureOf.to;
    const done = await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    expect(done.gate).toEqual([]);
    expect(done.report?.complete).toBe(true);
    const config = JSON.parse(await readFile(join(target, 'state/ferrets/talk1/config.json'), 'utf8'));
    expect(config.prompt).toContain(`${v4}/fleet/notes.md`);
  });

  test('MAJOR-3 a ferret env, folder or flag, or an MCP or runtime command, that names v4 or a harness home is refused by file and field', async () => {
    await liveFerretWithV4Paths();
    await fixtureOf.session('hit1', {
      harness: 'claude',
      harnessFlags: ['--settings', '/home/example/.claude/settings.json'],
    });
    await fixtureOf.session('hit2', { harness: 'claude', harnessFlags: [`--add-dir=${v4}/fleet`] });
    const target = fixtureOf.to;
    const done = await prepare({ v4Home: v4, target, lock, now, home: '/home/example' });
    expect(done.gate).toEqual([
      'state/ferrets/hit1/config.json: harnessFlags[1]',
      'state/ferrets/hit1/details.json: options.harnessFlags[1]',
      'state/ferrets/hit2/config.json: harnessFlags[0]',
      'state/ferrets/hit2/details.json: options.harnessFlags[0]',
    ]);
    expect(done.summary).toContain('refused');
    expect(done.summary).not.toContain(SENTINEL);
    expect(await stat(target).catch(() => undefined)).toBeUndefined();
  });

  test('MAJOR-3 gateFiles names file and field only; every spelling of v4 and the harness homes is caught; a sibling is not v4', async () => {
    const target = join(root, 'g');
    const home = '/home/example';
    await mkdir(join(target, 'config/components/mcp'), { recursive: true });
    await mkdir(join(target, 'state/ferrets/f1'), { recursive: true });
    const spellings: Record<string, string> = {
      plain: `${v4}/fleet`,
      tilde: '~/.ferretry/fleet',
      dollar: '$HOME/.ferretry/x',
      braces: '${HOME}/.ferretry/x',
      worktrees: `${v4}-worktrees/a`,
      claude: `${home}/.claude-work/x`,
      codex: '~/.codex',
      encoded: encodeURIComponent(`${v4}/fleet`),
    };
    await writeFile(
      join(target, 'config/components/mcp/a.json'),
      JSON.stringify({
        command: 'run',
        args: Object.values(spellings),
        env: { A: `${v4}-v5/fleet`, B: `${v4}.staging` },
        description: `${v4}/free text`,
      }),
    );
    await writeFile(
      join(target, 'state/ferrets/f1/ferret.json'),
      JSON.stringify({ folder: `${v4}`, name: `${v4}/not gated` }),
    );
    const hits = await gateFiles(target, v4, home);
    expect(hits.filter(line => line.startsWith('config/')).length).toBe(Object.keys(spellings).length);
    expect(hits).toContain('state/ferrets/f1/ferret.json: folder');
    expect(hits.some(line => line.includes('description') || line.includes('.env.') || line.includes('name'))).toBe(
      false,
    );
    expect(hits.join('\n')).not.toContain(SENTINEL);
  });

  test('MAJOR-3 an unreadable config file cannot be proven clean and refuses the home', async () => {
    const target = join(root, 'g2');
    await mkdir(join(target, 'config'), { recursive: true });
    await writeFile(join(target, 'config/x.yaml'), 'a: [unclosed');
    expect((await gateFiles(target, v4, '/home/example'))[0]).toContain('unreadable');
  });

  test('MAJOR-3 the dry run names the files and fields the gate would hit, never their content', async () => {
    await liveFerretWithV4Paths();
    await put('config/runtimes/r.yaml', `command: ${v4}/fleet/bin/x\nnote: ${SENTINEL}\n`);
    const text = await dryRun(v4, fixtureOf.to, '/home/example');
    expect(text).toContain('GATE FORECAST: 1 field(s)');
    expect(text).toContain('config/runtimes/r.yaml: command');
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain('KNOWN GAPS');
    expect(text).toContain('limits.yaml is NOT read for launches');
    expect(text).toContain('RESOURCE LIMITS: limits.yaml is NOT read');
  });

  test('MAJOR-2 the runtimes limits config says enabled: false, whatever v4 said', async () => {
    await liveFerretWithV4Paths();
    await put('config/limits.yaml', 'enabled: true\nionice: true\n');
    const target = fixtureOf.to;
    await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    const limits = (await everyFile(join(target, 'config'))).filter(file => /limits\.ya?ml$/u.test(file));
    expect(limits.length).toBe(1);
    const text = await readFile(limits[0] as string, 'utf8');
    expect(text).toMatch(/enabled: false/u);
    expect(text).not.toMatch(/enabled: true/u);
  });

  test('MAJOR-2 with no limits.yaml in v4 the preview still writes enabled: false', async () => {
    await liveFerretWithV4Paths();
    const target = fixtureOf.to;
    await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    const limits = (await everyFile(join(target, 'config'))).filter(file => /limits\.ya?ml$/u.test(file));
    expect(await readFile(limits[0] as string, 'utf8')).toMatch(/enabled: false/u);
  });

  test('m3 a ferret whose folder is inside v4 or its worktree folder gets the preview workspace; others keep theirs', async () => {
    await liveFerretWithV4Paths();
    await fixtureOf.session('wt1', { harness: 'claude', cwd: `${v4}-worktrees/job` });
    await fixtureOf.session('elsewhere1', { harness: 'claude', cwd: '/srv/project' });
    const target = fixtureOf.to;
    const done = await prepare({ v4Home: v4, target, lock, now, home: join(root, 'home') });
    expect(done.gate).toEqual([]);
    const folderOf = async (id: string) =>
      JSON.parse(await readFile(join(target, `state/ferrets/${id}/ferret.json`), 'utf8')).folder;
    expect(await folderOf('wt1')).toBe(join(await realpath(target), 'workspace'));
    expect(await folderOf('live1')).toBe('/work/project');
    expect(await folderOf('elsewhere1')).toBe('/srv/project');
    expect((await stat(join(target, 'workspace'))).isDirectory()).toBe(true);
  });
});

describe('where the preview may write and remove (C3)', () => {
  let home: string;
  let v4Home: string;
  beforeEach(async () => {
    home = join(root, 'home');
    v4Home = join(home, '.ferretry');
    await mkdir(v4Home, { recursive: true });
  });

  test.each([
    ['the v4 home itself', () => v4Home],
    ['the v4 home with a trailing slash', () => `${v4Home}/`],
    ['the v4 home with doubled slashes', () => `${home}//.ferretry//`],
    ['a folder inside the v4 home', () => join(v4Home, 'x')],
    ['a nested folder inside the v4 home', () => join(v4Home, 'a/b/c')],
    ['a path with ..', () => `${home}/other/../.ferretry`],
    ['the user home', () => home],
    ['the user home with a trailing slash', () => `${home}/`],
    ['the root of the disk', () => '/'],
    ['a folder that holds the user home', () => root],
    ['an empty name', () => ' '],
  ])('refuses %s', (_name, target) => {
    expect(() => guardTarget(v4Home, target(), home)).toThrow();
  });

  test('refuses a symlink that points at the v4 home, and one that points inside it', async () => {
    await symlink(v4Home, join(home, 'link-to-v4'));
    await mkdir(join(v4Home, 'inner'));
    await symlink(join(v4Home, 'inner'), join(home, 'link-inside'));
    expect(() => guardTarget(v4Home, join(home, 'link-to-v4'), home)).toThrow('v4');
    expect(() => guardTarget(v4Home, join(home, 'link-inside'), home)).toThrow('v4');
    expect(() => guardTarget(v4Home, join(home, 'link-to-v4', 'new'), home)).toThrow('v4');
  });

  test('m2 a dangling link, a link loop and a link whose target does not exist yet are refused', async () => {
    await symlink(join(v4Home, 'not-yet'), join(home, 'dangling'));
    await symlink(join(home, 'loop-b'), join(home, 'loop-a'));
    await symlink(join(home, 'loop-a'), join(home, 'loop-b'));
    expect(() => guardTarget(v4Home, join(home, 'dangling'), home)).toThrow('does not resolve');
    expect(() => guardTarget(v4Home, join(home, 'dangling', 'x'), home)).toThrow('does not resolve');
    expect(() => guardTarget(v4Home, join(home, 'loop-a'), home)).toThrow('does not resolve');
    expect(() => guardTarget(join(home, 'loop-b'), join(home, 'fine'), home)).toThrow('does not resolve');
  });

  test('m2 the default v4 home and its worktree folder stay protected whatever --v4 says', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    expect(() => guardTarget(elsewhere, join(home, '.ferretry', 'x'), home)).toThrow('v4');
    expect(() => guardTarget(elsewhere, join(home, '.ferretry-worktrees'), home)).toThrow('v4');
    expect(() => guardTarget(elsewhere, join(home, '.ferretry-worktrees', 'job'), home)).toThrow('v4');
    expect(() => guardTarget(v4Home, `${v4Home}-worktrees`, home)).toThrow('v4');
    expect(() => guardTarget(elsewhere, join(root, 'ok-target'), home)).not.toThrow();
  });

  test('m2 a relative or quoted-tilde target is refused, not resolved against the tool folder', () => {
    for (const target of ['~/.ferretry', '~', '.ferretry-v5', 'rel/dir', '../x'])
      expect(() => guardTarget(v4Home, target, home)).toThrow();
    expect(() => guardTarget('relative-v4', join(home, '.ferretry-v5'), home)).toThrow('absolute');
  });

  test('refuses a v4 home reached through a link too (both spellings resolve before they are compared)', async () => {
    await symlink(v4Home, join(home, 'alias'));
    expect(() => guardTarget(join(home, 'alias'), v4Home, home)).toThrow();
  });

  test('accepts a plain sibling folder, resolved, with and without a trailing slash', async () => {
    const wanted = join(home, '.ferretry-v5');
    expect(guardTarget(v4Home, wanted, home).target).toBe(wanted);
    expect(guardTarget(v4Home, `${wanted}/`, home).target).toBe(wanted);
    expect(guardTarget(v4Home, wanted, home).staging).toBe(`${wanted}.staging`);
  });

  test('clean refuses a folder without the marker, and removes a marked one and its staging copy', async () => {
    const wanted = join(home, '.ferretry-v5');
    await mkdir(wanted);
    await writeFile(join(wanted, 'keep.txt'), 'x');
    await expect(cleanPreview(v4Home, wanted, home)).rejects.toThrow('no .fy-preview marker');
    expect(await readdir(wanted)).toEqual(['keep.txt']);
    await writeFile(join(wanted, PREVIEW_MARKER), 'not the marker text');
    await expect(cleanPreview(v4Home, wanted, home)).rejects.toThrow('marker');
    await rm(join(wanted, PREVIEW_MARKER));
    await mkdir(`${wanted}.staging`);
    // A real prepare writes the marker; here only its text matters.
    await writeFile(
      join(wanted, PREVIEW_MARKER),
      'ferretry-v5-preview: made by migration/v4-to-v5/preview; safe to remove with preview.sh clean\n',
    );
    expect(hasMarker(wanted)).toBe(true);
    expect(await cleanPreview(v4Home, wanted, home)).toContain('removed');
    expect(await stat(wanted).catch(() => undefined)).toBeUndefined();
    expect(await stat(`${wanted}.staging`).catch(() => undefined)).toBeUndefined();
    expect(await stat(v4Home)).toBeDefined();
  });

  test('clean never removes the v4 home, marker or not, however it is spelled', async () => {
    await writeFile(join(v4Home, 'api-token'), SENTINEL);
    await writeFile(join(v4Home, PREVIEW_MARKER), 'x');
    for (const spelling of [v4Home, `${v4Home}/`, `${home}/x/../.ferretry`, join(v4Home, 'sub')])
      await expect(cleanPreview(v4Home, spelling, home)).rejects.toThrow();
    expect(await readFile(join(v4Home, 'api-token'), 'utf8')).toBe(SENTINEL);
  });

  test('prepare itself refuses a target inside the v4 home before it opens anything', async () => {
    await expect(
      prepare({ v4Home, target: join(v4Home, 'x'), lock: { held: async () => false }, now: () => new Date(), home }),
    ).rejects.toThrow('v4');
    expect(await readdir(v4Home)).toEqual([]);
  });

  test('preview.sh stops at the guard for every spelling, by path, and leaves v4 as it was', async () => {
    await writeFile(join(v4Home, 'api-token'), SENTINEL);
    const script = join(import.meta.dir, '../../preview/preview.sh');
    expect(statSync(script).mode & 0o111).not.toBe(0);
    for (const target of [v4Home, `${v4Home}/`, home, '/', join(v4Home, 'x'), `${home}/z/../.ferretry`]) {
      const result = Bun.spawnSync([script, 'clean', '--v4', v4Home, '--target', target], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
      });
      expect(result.exitCode).toBe(64);
    }
    expect(await readFile(join(v4Home, 'api-token'), 'utf8')).toBe(SENTINEL);
  });
});

describe('build refuses anything but a clean rebuild/5.0 checkout (m3)', () => {
  const script = join(import.meta.dir, '../../preview/preview.sh');
  const run = async (setup: (repo: string) => void) => {
    const home = join(root, 'home');
    const repo = join(root, 'src');
    await mkdir(repo, { recursive: true });
    setup(repo);
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args]);
    return { git, repo, home };
  };
  const build = (repo: string, home: string) =>
    Bun.spawnSync(
      [script, 'build', '--v4', join(home, '.ferretry'), '--target', join(home, '.ferretry-v5'), '--source', repo],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } },
    );

  test('a branch that is not rebuild/5.0, a detached HEAD and a dirty tree are each refused with a sentence', async () => {
    const { git, repo, home } = await run(() => {});
    git('init', '-q', '-b', 'rebuild/preview-v5');
    let result = build(repo, home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing to build from 'rebuild/preview-v5'");

    git('checkout', '-q', '-b', 'rebuild/5.0');
    await writeFile(join(repo, 'stray.txt'), 'x');
    result = build(repo, home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('uncommitted changes');

    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'c');
    git('checkout', '-q', '--detach');
    result = build(repo, home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('detached');
  });
});

const V4_OF_WRAPPER = '/nonexistent-v4/.ferretry';

describe('build needs the preview signing key (m6)', () => {
  test('a clean rebuild/5.0 checkout without release-signing-key.preview.pub is refused with the owner step', async () => {
    const script = join(import.meta.dir, '../../preview/preview.sh');
    const repo = join(root, 'src');
    await mkdir(repo, { recursive: true });
    const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, ...args]);
    git('init', '-q', '-b', 'rebuild/5.0');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'c');
    const home = join(root, 'home');
    const result = Bun.spawnSync(
      [script, 'build', '--v4', join(home, '.ferretry'), '--target', join(home, '.ferretry-v5'), '--source', repo],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('release-signing-key.preview.pub is missing');
    expect(result.stderr.toString()).toContain('Owner step');
  });
});

describe('the fy5 wrapper (M1, M4)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'fy5-'));
    await mkdir(join(home, 'bin'));
    await mkdir(join(home, 'libexec'));
    // Stands in for the 5.0 binary: prints its arguments, then every variable it received.
    await writeFile(join(home, 'libexec/fy'), '#!/bin/sh\nprintf "arg:%s\\n" "$@"\nenv\n', { mode: 0o755 });
    await writeFile(join(home, 'bin/fy5'), wrapperText(home, V4_OF_WRAPPER), { mode: 0o755 });
    await writeFile(join(home, 'bin/fy'), shimText(home, 'fy'), { mode: 0o755 });
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string>) => Bun.spawnSync([join(home, 'bin/fy5'), ...args], { env });

  test('M1 FY_*, CLAUDE_*, CODEX_* and the rest of the caller environment never reach the binary', () => {
    const result = run(['status', 'a b'], {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: '/home/u',
      USER: 'u',
      LANG: 'C',
      LC_ALL: 'C',
      TERM: 'xterm',
      FY_TOKEN: 'v4-ferret-token',
      FY_SESSION_TOKEN: 'v4-session-token',
      FY_SESSION_ID: 'abc',
      FY_DAEMON_BIN: '/v4/fyd',
      FY_HOME: '/home/u/.ferretry',
      FY_PORT: '7457',
      FY_URL: 'http://127.0.0.1:7457',
      CLAUDE_CONFIG_DIR: '/v4/homes/h',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/v4/creds',
      CODEX_HOME: '/v4/homes/c',
      TMUX: '/tmp/tmux-1/default,1,0',
      TMUX_PANE: '%3',
      SECRET_THING: 'x',
    });
    expect(result.exitCode).toBe(0);
    const out = result.stdout.toString();
    const names = out
      .split('\n')
      .filter(line => !line.startsWith('arg:') && line.includes('='))
      .map(line => line.slice(0, line.indexOf('=')));
    expect(out).toContain('arg:status');
    expect(out).toContain('arg:a b');
    expect(out).toContain('FY_HOME=' + home);
    expect(out).toContain(`FY_PORT=${PREVIEW.port}`);
    expect(out).toContain(`FY_URL=http://127.0.0.1:${PREVIEW.port}`);
    expect(out).not.toMatch(/v4-ferret-token|v4-session-token|\/v4\/|7457|\.ferretry\b/u);
    expect(names.filter(name => /^(CLAUDE|CODEX)_/u.test(name))).toEqual([]);
    expect(names.filter(name => name.startsWith('FY_')).sort()).toEqual([
      'FY_HOME',
      'FY_PORT',
      'FY_UPDATE_CHECK',
      'FY_URL',
    ]);
    expect(out).toContain('FY_UPDATE_CHECK=off');
    for (const name of ['TMUX', 'TMUX_PANE', 'SECRET_THING']) expect(names).not.toContain(name);
    for (const name of ['HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'PATH']) expect(names).toContain(name);
  });

  test.each(['stop', 'restart', 'update', 'install', 'uninstall', 'reset', 'which', 'logs'])(
    'M4 daemon %s is refused with a sentence that points at preview.sh',
    verb => {
      const result = run(['daemon', verb], { PATH: process.env.PATH ?? '/usr/bin:/bin' });
      expect(result.exitCode).toBe(64);
      expect(result.stderr.toString()).toContain('preview.sh');
      expect(result.stdout.toString()).toBe('');
    },
  );

  test('m1 a top-level update is refused, and a leading flag does not hide the verb', () => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    for (const args of [
      ['update'],
      ['update', '--to', '5.0.0'],
      ['--as-owner', 'daemon', 'stop'],
      ['-q', 'update'],
      ['--json', 'daemon', 'logs'],
    ]) {
      const result = run(args, env);
      expect(result.exitCode).toBe(64);
      expect(result.stdout.toString()).toBe('');
    }
  });

  test('MAJOR-1 PATH starts with the preview bin, drops v4 entries, and a bare fy there names the preview home', async () => {
    const v4Bin = await mkdtemp(join(tmpdir(), 'v4bin-'));
    const wt = `${v4Bin}-worktrees`;
    await mkdir(wt, { recursive: true });
    await writeFile(join(v4Bin, 'fy'), '#!/bin/sh\necho V4-FY\n', { mode: 0o755 });
    // A wrapper made for THIS v4 home, so its entries are the ones dropped.
    await writeFile(join(home, 'bin/fy5'), wrapperText(home, v4Bin), { mode: 0o755 });
    const probe = join(home, 'libexec/fy');
    await writeFile(probe, '#!/bin/sh\nprintf "path:%s\\n" "$PATH"\ncommand -v fy\n', { mode: 0o755 });
    const out = run(['x'], { PATH: `${v4Bin}:/usr/bin:${wt}/sub:/bin`, HOME: '/h' }).stdout.toString();
    const path = /^path:(.*)$/mu.exec(out)?.[1] ?? '';
    expect(path.split(':')[0]).toBe(`${home}/bin`);
    expect(path).not.toContain(v4Bin);
    expect(path).not.toContain(wt);
    expect(path).toContain('/usr/bin');
    expect(out).toContain(`${home}/bin/fy`);
    expect(shimText(home, 'fy')).toContain(`FY_HOME="${home}"`);
    expect(shimText(home, 'fyd')).toContain(`${home}/libexec/fyd`);
    expect(shimText(home, 'fy')).toContain(`FY_URL="http://127.0.0.1:${PREVIEW.port}"`);
    await rm(v4Bin, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  });

  test('daemon start and status are passed through', () => {
    for (const verb of ['start', 'status'])
      expect(run(['daemon', verb], { PATH: process.env.PATH ?? '/usr/bin:/bin' }).stdout.toString()).toContain(
        `arg:${verb}`,
      );
  });

  test('a preview home with a quote, dollar, backtick, backslash or newline is refused (n3)', () => {
    for (const bad of ['/h/"x', '/h/$x', '/h/`x`', '/h/a\\b', '/h/a\nb'])
      expect(() => wrapperText(bad, '/v4')).toThrow();
  });
});

describe('stopping the preview by pid proven to hold its lock (M4)', () => {
  test('SIGTERMs the proven holder, waits for the lock to be let go and says so', async () => {
    const sent: number[] = [];
    let held: number[] = [321];
    const done = await stopPreview('/h/.ferretry-v5', {
      holders: async lock => {
        expect(lock).toBe('/h/.ferretry-v5/run/daemon.lock');
        return held;
      },
      kill: pid => {
        sent.push(pid);
        held = [];
      },
      sleep: async () => {},
    });
    expect(sent).toEqual([321]);
    expect(done.stopped).toBe(true);
    expect(done.said).toContain('321');
  });

  test('no holder: nothing is signalled', async () => {
    const sent: number[] = [];
    const done = await stopPreview('/h/p', {
      holders: async () => [],
      kill: pid => void sent.push(pid),
      sleep: async () => {},
    });
    expect(sent).toEqual([]);
    expect(done.said).toContain('not running');
  });

  test('a holder that stays is reported, not killed harder', async () => {
    const sent: string[] = [];
    const done = await stopPreview('/h/p', {
      holders: async () => [9],
      kill: (pid, signal) => void sent.push(`${signal}:${pid}`),
      sleep: async () => {},
      attempts: 2,
    });
    expect(sent).toEqual(['SIGTERM:9']);
    expect(done.stopped).toBe(false);
  });
});

describe('the copy refuses what a plan did not name (m2, n2) and the proof does not cry wolf (m1, m6)', () => {
  test('a hard-linked file is refused by name, not copied', async () => {
    await put('layout-version', '2\n');
    await put('state/projects.json', '[]');
    await link(join(v4, 'state/projects.json'), join(root, 'elsewhere.json'));
    await expect(stage(v4, join(root, 'staging'))).rejects.toThrow('state/projects.json');
  });

  test('a folder v4 grew into is not damage, and a credential file v4 rewrote is named apart', async () => {
    await plantedHome();
    const before = await snapshot(v4, join(root, 'nohome'));
    await put('fleet/homes/h2/new.txt', SENTINEL);
    await put('state/devices.json', `${SENTINEL}-seen`);
    const verdict = compare(before, await snapshot(v4, join(root, 'nohome')));
    expect(verdict.unchanged).toBe(true);
    expect(verdict.v4Wrote).toEqual(['state/devices.json']);
    await rename(join(v4, 'fleet/homes'), join(v4, 'fleet/homes-aside'));
    await mkdir(join(v4, 'fleet/homes'));
    expect(compare(before, await snapshot(v4, join(root, 'nohome'))).changed).toContain('fleet/homes');
  });

  test('config/components is hashed, and v4 host paths are compared when a home is given', async () => {
    await plantedHome();
    await put('config/components/mcp/a.yaml', 'x: 1\n');
    await mkdir(join(root, 'uh/.local/state/ferretry'), { recursive: true });
    const before = await snapshot(v4, join(root, 'uh'));
    expect(Object.keys(before.hashes).some(key => key.startsWith('config/components'))).toBe(false);
    await put('config/components/a.yaml', 'x: 1\n');
    expect(Object.keys((await snapshot(v4, join(root, 'uh'))).hashes)).toContain('config/components/a.yaml');
    await rm(join(root, 'uh/.local/state/ferretry'), { recursive: true });
    expect(compare(before, await snapshot(v4, join(root, 'uh'))).changed).toContain('.local/state/ferretry');
  });
});

describe('the proof after a start and a stop (m4)', () => {
  test('config/logins is stat only: its files are never hashed, and a new login is not damage', async () => {
    await plantedHome();
    await put('config/logins/work.yaml', SENTINEL);
    const before = await snapshot(v4);
    expect(Object.keys(before.hashes).some(key => key.includes('logins'))).toBe(false);
    expect(JSON.stringify(before)).not.toContain(SENTINEL);
    await put('config/logins/other.yaml', 'x');
    expect(compare(before, await snapshot(v4)).unchanged).toBe(true);
  });

  test("the lifecycle claim files layout.ts derives are stat'ed by name, and a new one is named", async () => {
    const userHome = join(root, 'uh');
    const runtimeDir = join(root, 'run');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(join(userHome, '.config/systemd/user'), { recursive: true });
    const facts = { userHome, runtimeDir, uid: 1000 };
    const paths = claimPaths(join(userHome, '.ferretry'), facts);
    expect(paths['claim:unit-target']).toBe(join(runtimeDir, '.1000.systemd.fyd.service.target.lifecycle.lock'));
    expect(paths['claim:unit-definition']).toBe(
      join(userHome, '.config/systemd/user/.11-fyd.service.10-definition.lifecycle.lock'),
    );
    expect(paths['claim:update-artifacts']).toBe(
      join(userHome, '.local/state/ferretry/updates/.3-fyd.7-updates.lifecycle.lock'),
    );
    expect(paths['claim:direct-daemon']).toBe(join(userHome, '.9-.ferretry.10-fyd.direct.lifecycle.lock'));
    await plantedHome();
    const before = await snapshot(v4, facts);
    await writeFile(paths['claim:unit-definition'] as string, '');
    expect(compare(before, await snapshot(v4, facts)).changed).toContain('claim:unit-definition');
  });

  test('prepare persists the before snapshot and proof compares it after a stop', async () => {
    await plantedHome();
    const home = join(root, 'home');
    await mkdir(home, { recursive: true });
    const target = fixtureOf.to;
    const done = await prepare({
      v4Home: v4,
      target,
      lock: { held: async () => false },
      now: () => new Date('2026-11-09T00:00:00Z'),
      home,
    });
    expect(done.report?.complete).toBe(true);
    const saved = await readFile(proofPathFor(home, await realpath(target)), 'utf8');
    expect(proofPathFor(home, await realpath(target)).startsWith(join(home, PROOF_FOLDER))).toBe(true);
    expect(await readdir(target)).not.toContain('proof.json');
    expect(saved).not.toContain(SENTINEL);
    expect((await proofNow(v4, target, home)).unchanged).toBe(true);
    await put('config/machine.yaml', 'timeZone: Asia/Tokyo\n');
    expect((await proofNow(v4, target, home)).changed).toContain('config/machine.yaml');
  });

  test('proof refuses a folder that is not a preview home', async () => {
    await mkdir(fixtureOf.to, { recursive: true });
    await expect(proofNow(v4, fixtureOf.to, join(root, 'home'))).rejects.toThrow('not a preview home');
  });
});

describe('one spelling of the preview origin (n1)', () => {
  test('the workflow, the setup script and the plan all spell the same origin', async () => {
    const repository = join(import.meta.dir, '../../../..');
    const workflow = await readFile(join(repository, '.github/workflows/pwa-pages-v5.yaml'), 'utf8');
    expect(workflow).toContain(`FY_HOSTED_APP_ORIGIN: ${PREVIEW.appOrigin}\n`);
    const setup = await readFile(join(repository, 'scripts/local/setup-pwa-release-v5.sh'), 'utf8');
    for (const match of setup.matchAll(/https:\/\/ferretry-v5[^\s)"']*/gu))
      expect(match[0].replace(/[.,]$/u, '')).toBe(PREVIEW.appOrigin);
  });
});
