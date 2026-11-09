/**
 * Preview nits (round 13): the Packs and Lessons steps read a held file through the in-memory override, the enforced pass
 * reads no overridden file from disk, the failure note keeps the inner cause, the login sentence is accurate, and the
 * key digest is keyed per process. Every key here is made up, in a temp folder.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convert, dryConfigsOf } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { archiveSettingStep } from '../../src/steps/archive-setting.ts';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { STEPS as ALL } from '../../src/steps/index.ts';
import { lessonsStep } from '../../src/steps/lessons.ts';
import { LoginKeyHold, loginKeysStep } from '../../src/steps/login-keys.ts';
import { packsStep } from '../../src/steps/packs.ts';
import { vaultStep } from '../../src/steps/secrets.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await chmod(f.from, 0o700).catch(() => undefined);
  await f.clean();
});

const KEY = `sk-ant-${'NITS13KY'.repeat(5)}`;
const OLD_KEY = `sk-ant-${'NITS13OL'.repeat(5)}`;
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
const login = (key: string) => `harness: claude\nstore: environment\nenv:\n  ANTHROPIC_API_KEY: ${key}\n`;
const acceptedDir = () => join(f.to, 'state/kernel/accepted-config');
const recordText = async (name: string) =>
  (JSON.parse(await readFile(join(acceptedDir(), `${acceptedName(name)}.json`), 'utf8')) as { text: string }).text;
const STEPS = [
  lessonsStep,
  settingsStep,
  daemonSettingsStep,
  archiveSettingStep,
  packsStep,
  vaultStep,
  loginKeysStep,
  acceptedConfigStep,
];
const run = async (steps = STEPS) => {
  await put('layout-version', '2\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps,
  });
  if (result.kind !== 'done') throw new Error('refused');
  return result.report;
};
const accepted = (report: Awaited<ReturnType<typeof run>>) => report.steps.find(s => s.id === 'accepted-config');

test('a held pack.yaml and learning.yaml: the record carries the ACCEPTED text (Packs and Lessons honour the override)', async () => {
  await put('config/pack.yaml', 'enabled: true\n');
  await put('config/learning.yaml', 'enabled: true\n');
  await accept({ 'pack.yaml': 'enabled: false\n', 'learning.yaml': 'enabled: false\n' });
  await run();
  expect(await recordText('packs.yaml')).toContain('enabled: false');
  expect(await recordText('lessons.yaml')).toContain('enabled: false');
  expect(await readFile(join(f.to, 'config/packs.yaml'), 'utf8')).toContain('enabled: true');
  expect(await readFile(join(f.to, 'config/lessons.yaml'), 'utf8')).toContain('enabled: true');
});

test('the enforced pass alone reads no overridden file from disk (each is unreadable and broken, the target is missing)', async () => {
  for (const path of ['config/pack.yaml', 'config/learning.yaml', 'config/machine.yaml', 'config/logins/work.yaml']) {
    await put(path, 'bogus: [\n');
    await chmod(join(f.from, path), 0o000);
  }
  await put('config/components/instructions/lessons.yaml', 'file: instructions/lessons.md\n');
  await chmod(join(f.from, 'config/components/instructions/lessons.yaml'), 0o000);
  const overrides = new Map<string, string | null>([
    ['config/pack.yaml', 'enabled: false\n'],
    ['config/learning.yaml', 'enabled: false\n'],
    ['config/machine.yaml', 'agentControl:\n  terminals: false\n'],
    ['config/logins/work.yaml', login(KEY)],
    ['config/components/instructions/lessons.yaml', null],
  ]);
  const to = join(f.root, 'never', 'v5');
  const result = await dryConfigsOf(f.from, to, { homeDirectory: f.root, env: {} }, ALL)(overrides);
  expect(result.failed).toEqual([]);
  expect(result.failedWhy).toEqual([]);
  const work = result.configs.get('config/logins/work.yaml') ?? '';
  expect(work).toContain('${secret:');
  expect(work.includes(KEY)).toBe(false);
  expect((await readdir(f.root)).sort()).toEqual(['v4']);
});

test('the failure note keeps the inner cause: the failing step and its own note, not only the held files', async () => {
  await put('config/daemon.json', '{ not json');
  await put('config/machine.yaml', 'agentControl:\n  terminals: true\n');
  await accept({ 'machine.yaml': 'agentControl:\n  terminals: false\n' });
  const report = await run();
  const note = accepted(report)?.note ?? '';
  expect(accepted(report)?.status).toBe('failed');
  expect(note).toContain('daemon-settings:');
  expect(note).toContain('machine.yaml');
  expect(note).not.toContain('Fix or confirm the v4 file named');
  expect(report.complete).toBe(false);
});

test('a login held for another key says the enforced file would name a different secret, and no key leaks', async () => {
  await put('config/logins/work.yaml', login(KEY));
  await accept({ 'logins/work.yaml': login(OLD_KEY) });
  const report = await run();
  const item = accepted(report)?.notCarried.find(n => n.what.includes('config/logins/work.yaml'));
  expect(item?.why).toContain('a different value, a different name, or none');
  expect(JSON.stringify(report).includes(KEY) || JSON.stringify(report).includes(OLD_KEY)).toBe(false);
});

test('the login-key digest is in no report and no written file', async () => {
  await put('config/logins/work.yaml', login(KEY));
  await accept({ 'logins/work.yaml': login(OLD_KEY) });
  const report = await run();
  // The digest has the `NAME:<64 hex>` ledger shape; neither it nor any 64-hex run follows a name in the report.
  expect(JSON.stringify(report)).not.toMatch(/[:=][0-9a-f]{64}/u);
  const held = new LoginKeyHold();
  held.add({ login: 'work', variable: 'ANTHROPIC_API_KEY', name: 'LOGIN_WORK_ANTHROPIC_API_KEY' }, KEY);
  for (const entry of await readdir(f.to, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const body = await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '');
    expect(body.includes(held.fingerprint('work'))).toBe(false);
  }
});

test('the key digest is keyed: it is no plain SHA-256 of the key, and the same key digests the same within a run', () => {
  const a = new LoginKeyHold();
  const b = new LoginKeyHold();
  const item = { login: 'work', variable: 'ANTHROPIC_API_KEY', name: 'LOGIN_WORK_ANTHROPIC_API_KEY' };
  a.add(item, KEY);
  b.add(item, KEY);
  expect(a.fingerprint('work')).toBe(b.fingerprint('work'));
  expect(a.fingerprint('work')).not.toContain(sha256(KEY));
  expect(a.fingerprint('work').includes(KEY)).toBe(false);
});
