/**
 * Fix round 12: the enforced-text pass writes no copy of any v4 file (an in-memory override), keeps a plain key out of
 * every accepted record, and fails closed when it cannot run. Every key here is made up, in a temp folder.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_STEPS, convert } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { STEPS as ALL_STEPS } from '../../src/steps/index.ts';
import { LoginKeyHold, loginKeysStep } from '../../src/steps/login-keys.ts';
import { vaultStep } from '../../src/steps/secrets.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { listV4Config, readV4Yaml } from '../../src/v4/config.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const KEY = `sk-ant-${'FAKE0123'.repeat(5)}`;
const OLD_KEY = `sk-ant-${'OLDKEY99'.repeat(5)}`;
const HOME_KEY = `sk-ant-${'HOMEKEY1'.repeat(5)}`;
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text, { mode: 0o600 });
};
const accept = async (files: Record<string, string>) =>
  put(
    'state/config-accepted.json',
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, t]) => [k, { etag: sha256(t), text: t }]))),
  );
const login = (key: string, extra = '') =>
  `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${key}\n${extra}`;
const LOWER = 'budget:\n  daily:\n    hard: 5\n';
const RAISED = 'budget:\n  daily:\n    hard: 10\n';
const acceptedDir = () => join(f.to, 'state/kernel/accepted-config');
const records = async () => (await readdir(acceptedDir()).catch(() => [] as string[])).sort();
const recordText = async (name: string) =>
  (JSON.parse(await readFile(join(acceptedDir(), `${acceptedName(name)}.json`), 'utf8')) as { text: string }).text;

const run = async (steps: Parameters<typeof convert>[0]['steps']) => {
  await put('layout-version', '2\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    ...(steps === undefined ? {} : { steps }),
  });
  expect(result.kind).toBe('done');
  if (result.kind !== 'done') throw new Error('refused');
  return result.report;
};

/** Every file under `root`, as `[path, text]`. */
async function walk(root: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else out.push([path, await readFile(path, 'utf8').catch(() => '')]);
  }
  return out;
}

/** Runs `body` with a temp root nobody can write to: a pass that copies a v4 file there cannot. */
async function withUnwritableTemp<T>(body: () => Promise<T>): Promise<{ result: T; root: string }> {
  const root = join(f.root, 'locked-tmp');
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o500);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return { result: await body(), root };
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    await chmod(root, 0o700);
  }
}

const STEPS = [settingsStep, vaultStep, loginKeysStep, acceptedConfigStep];

test('MAJOR-1 the enforced pass writes no copy of a v4 file: a plain key in a held and an unheld login is found nowhere on disk', async () => {
  // held: v4 enforced the older text (a budget RAISED waits for the owner; a key or flag edit alone is applied at once)
  await put('config/logins/work.yaml', login(KEY, `  EXTRA_FLAG: 'on'\n${RAISED}`));
  await put('config/logins/home.yaml', login(HOME_KEY)); // unheld
  await put('config/pack.yaml', 'x: 2\n'); // held, never accepted
  await accept({ 'logins/work.yaml': login(KEY, LOWER), 'logins/home.yaml': login(HOME_KEY) });
  const before = new Set(await readdir(tmpdir()));
  const { result: report, root } = await withUnwritableTemp(() => run(STEPS));
  // The pass ran (an unwritable temp root would have failed a copy and, failing closed, left no record).
  expect(report.steps.find(step => step.id === 'accepted-config')?.status).toBe('converted');
  expect(await readdir(root)).toEqual([]);
  expect((await readdir(tmpdir())).filter(name => name.startsWith('fy-enforced-') && !before.has(name))).toEqual([]);
  for (const [path, text] of [...(await walk(f.to)), ...(await walk(root))]) {
    expect({ path, key: text.includes(KEY) || text.includes(HOME_KEY) || text.includes(OLD_KEY) }).toEqual({
      path,
      key: false,
    });
  }
  // The unheld login: the record is the live file (a reference, never the key).
  expect(await recordText('logins/home.yaml')).toBe(await readFile(join(f.to, 'config/logins/home.yaml'), 'utf8'));
  // The held login whose enforced key is the live key: carried with the SAME secret name the live file got.
  const live = await readFile(join(f.to, 'config/logins/work.yaml'), 'utf8');
  const enforced = await recordText('logins/work.yaml');
  const name = /\$\{secret:([A-Z0-9_]+)\}/u.exec(live)?.[1];
  expect(name).toBeDefined();
  expect(enforced).toContain(`\${secret:${name ?? ''}}`);
  expect(enforced).not.toContain('EXTRA_FLAG');
  expect(live).toContain('EXTRA_FLAG');
});

test('MAJOR-1 a held login whose enforced key differs from the live one gets no record: held, said in the report', async () => {
  await put('config/logins/work.yaml', login(KEY, RAISED));
  await accept({ 'logins/work.yaml': login(OLD_KEY, LOWER) });
  const report = await run(STEPS);
  expect(await records()).toEqual([]);
  const step = report.steps.find(item => item.id === 'accepted-config');
  expect(step?.notCarried.map(item => item.what).join('\n')).toContain('config/logins/work.yaml');
  for (const [, text] of await walk(f.to)) expect(text.includes(KEY) || text.includes(OLD_KEY)).toBe(false);
  expect(JSON.stringify(report)).not.toContain(OLD_KEY);
});

test('MINOR-1 the enforced pass fails in a step: no record for any file, the step fails, the conversion is incomplete', async () => {
  const MACHINE = 'timeZone: Europe/Berlin\nagentControl:\n  terminals: false\n';
  await put('config/machine.yaml', 'agentControl:\n  terminals: true\n');
  await put('config/warden.yaml', 'enabled: true\n');
  // v4 enforced a machine.yaml the converter refuses (an unknown key): the enforced conversion fails in Settings.
  await accept({ 'machine.yaml': `${MACHINE}bogusKey: 1\n`, 'warden.yaml': 'enabled: true\n' });
  const report = await run([settingsStep, acceptedConfigStep]);
  const step = report.steps.find(item => item.id === 'accepted-config');
  expect(step?.status).toBe('failed');
  expect(step?.note).toContain('settings');
  expect(step?.note).toContain('no accepted record was written');
  // Never the current text instead: not even the unheld warden.yaml is recorded.
  expect(await records()).toEqual([]);
  expect(report.complete).toBe(false);
  expect(await readFile(join(f.to, 'home.json'), 'utf8').catch(() => undefined)).toBeUndefined();
});

test('MINOR-1 a held file and the conversion not available at all: the step fails closed too', async () => {
  await put('config/warden.yaml', 'enabled: true\n');
  await accept({ 'warden.yaml': 'enabled: false\n' });
  const ctx = { ...f.ctx(false) };
  const report = await acceptedConfigStep.run(ctx);
  expect(report.status).toBe('failed');
  expect(await records()).toEqual([]);
});

test('the dry pass runs exactly the steps that write config (behavioural: any writer, aliased or not)', async () => {
  // Every step runs once on a fixture that gives each config writer something to write; a spy on the writer's `config`
  // records which step called it, however the step reached the writer (an alias, a helper module).
  // Known limits (accepted): it only sees a step whose fixture triggers a config write (a step that writes config only
  // under a condition this fixture lacks escapes), and a step that builds its own writer instead of using `ctx.v5`.
  await put('layout-version', '2\n');
  await put('config/machine.yaml', 'timeZone: Europe/Berlin\n');
  await put('config/pack.yaml', 'enabled: true\n');
  await put('config/learning.yaml', 'enabled: true\n');
  await put('config/daemon.json', '{"port": 4321}');
  const plain = f.ctx(true);
  const called = new Set<string>();
  for (const step of ALL_STEPS) {
    const v5 = new Proxy(plain.v5, {
      get(target, property) {
        if (property === 'config')
          return (...args: Parameters<typeof target.config>) => {
            called.add(step.id);
            return target.config(...args);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const host = { homeDirectory: f.root, env: { FYD_SESSION_ARCHIVE_AFTER_HOURS: '24' } };
    await step.run({ ...plain, v5, loginKeys: new LoginKeyHold(), host }).catch(() => undefined);
  }
  expect([...called].sort()).toEqual([...CONFIG_STEPS].sort());
});

test('config overrides read in memory: replace, remove and restore a file; every other file is the disk', async () => {
  await put('config/machine.yaml', 'timeZone: Europe/Berlin\n');
  await put('config/warden.yaml', 'enabled: true\n');
  await put('config/limits.yaml', 'enabled: true\n');
  const overrides = new Map<string, string | null>([
    ['config/machine.yaml', 'timeZone: UTC\n'],
    ['config/warden.yaml', null],
    ['config/voice.yaml', 'x: 1\n'], // a file the disk lacks (a held deletion's accepted text)
  ]);
  const listing = await listV4Config(f.from, overrides);
  expect(listing.files.map(file => file.label)).toEqual([
    'config/limits.yaml',
    'config/machine.yaml',
    'config/voice.yaml',
  ]);
  const machine = listing.files.find(file => file.label === 'config/machine.yaml');
  expect((await readV4Yaml(machine as never)).toJS()).toEqual({ timeZone: 'UTC' });
  const voice = listing.files.find(file => file.label === 'config/voice.yaml');
  expect((await readV4Yaml(voice as never)).toJS()).toEqual({ x: 1 });
  expect(await readFile(join(f.from, 'config/machine.yaml'), 'utf8')).toBe('timeZone: Europe/Berlin\n');
});
