import { afterEach, beforeEach, expect, test } from 'bun:test';
import { link, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convert } from '../../src/convert.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

/**
 * The owner's hooks component names files under v4's fleet/assets by absolute path (PreCompact `cat <v4 home>/…`,
 * SessionStart `sh <v4 home>/…`). Every path and value here is FAKE; nothing touches a real home.
 */
const REAL = '/fake-real-home/.ferretry';
const USER_HOME = '/fake-real-home';
const BEFORE = 'components/hooks/compact-before.txt';
const AFTER = 'components/hooks/compact-after.sh';
const FAKE_KEY = 'sk-ant-FAKEFAKEFAKEFAKEFAKE0123';
// The owner's script reaches its home through $FY_HOME, never a literal v4 path: that must carry.
const SCRIPT = '#!/bin/sh\necho compacted\ncat "$FY_HOME/state/compact-notes.txt"\n';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const put = async (path: string, content: string | Buffer, mode = 0o600) => {
  const target = join(f.from, path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode });
};

const hooksJson = (before: string, after: string) =>
  JSON.stringify({
    hooks: {
      PreCompact: [{ hooks: [{ type: 'command', command: before }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: after }] }],
    },
  });

/** The component + a profile layering it, then the preview conversion of the settings step. */
const run = async (before: string, after: string) => {
  await put('layout-version', '2\n');
  await put('config/components/hooks/claude-hooks.yaml', 'harness: claude\nfile: components/hooks/claude-hooks.json\n');
  await put('fleet/assets/components/hooks/claude-hooks.json', hooksJson(before, after));
  await put('config/profiles/default.yaml', 'contents:\n  - hooks/claude-hooks\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: USER_HOME, env: {} },
    steps: [settingsStep],
    preview: true,
    previewV4Home: REAL,
    previewUserHome: USER_HOME,
  });
  if (result.kind !== 'done') throw new Error('expected a run');
  const step = result.report.steps.find(item => item.id === 'settings');
  if (step === undefined) throw new Error('no settings step');
  return { report: result.report, step };
};

const cat = (rel = BEFORE) => `cat ${REAL}/fleet/assets/${rel}`;
const sh = (rel = AFTER) => `sh ${REAL}/fleet/assets/${rel}`;
const hooksYaml = () => readFile(join(f.to, 'config/claude-code/hooks/claude-hooks.yaml'), 'utf8');
const everyFile = async (root: string) =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name));

test("the owner's shape: both files are carried byte for byte, the script stays executable, the commands name the v5 copies", async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE compact notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const { report, step } = await run(cat(), sh());
  expect(step.status).toBe('converted');
  expect(report.complete).toBe(true);
  expect(await readFile(join(f.to, 'fleet/assets', BEFORE), 'utf8')).toBe('FAKE compact notes\n');
  expect(await readFile(join(f.to, 'fleet/assets', AFTER), 'utf8')).toBe(SCRIPT);
  expect((await stat(join(f.to, 'fleet/assets', AFTER))).mode & 0o777).toBe(0o700);
  expect((await stat(join(f.to, 'fleet/assets', BEFORE))).mode & 0o777).toBe(0o600);
  const text = await hooksYaml();
  expect(text).toContain(`cat ${f.to}/fleet/assets/${BEFORE}`);
  expect(text).toContain(`sh ${f.to}/fleet/assets/${AFTER}`);
  for (const file of await everyFile(f.to)) expect((await readFile(file, 'utf8')).includes(REAL)).toBe(false);
  // The report names each carried file by its fleet/assets path, nothing else.
  expect(step.kept.map(item => item.what)).toContain(`component file fleet/assets/${BEFORE}`);
  expect(step.kept.map(item => item.what)).toContain(`component file fleet/assets/${AFTER}`);
  expect(JSON.stringify(report)).not.toContain(REAL);
});

const refusedCases: readonly (readonly [string, () => Promise<void>])[] = [
  ['a link', async () => symlink('/etc/hostname', join(f.from, 'fleet/assets', BEFORE))],
  [
    'a hard link',
    async () => {
      await put('state/elsewhere.txt', 'FAKE other file\n');
      await link(join(f.from, 'state/elsewhere.txt'), join(f.from, 'fleet/assets', BEFORE));
    },
  ],
  ['a file over 1 MiB', async () => put(`fleet/assets/${BEFORE}`, Buffer.alloc(1024 * 1024 + 1, 'a'))],
  ['a file holding a secret', async () => put(`fleet/assets/${BEFORE}`, `token ${FAKE_KEY}\n`)],
  ['a file whose content names the v4 home', async () => put(`fleet/assets/${BEFORE}`, `cat ${REAL}/state/x\n`)],
  [
    'a file whose content names the v4 home as ~/.ferretry',
    async () => put(`fleet/assets/${BEFORE}`, 'cat ~/.ferretry/x\n'),
  ],
  [
    'a file whose content names the v4 home as $HOME/.ferretry',
    async () => put(`fleet/assets/${BEFORE}`, 'cat $HOME/.ferretry/state/x\n'),
  ],
  ['a missing file', async () => undefined],
];

for (const [name, arrange] of refusedCases)
  test(`${name} that a hook points at is not carried; the component is named by reason, never the command`, async () => {
    await mkdir(join(f.from, 'fleet/assets/components/hooks'), { recursive: true, mode: 0o700 });
    await arrange();
    await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
    const { step } = await run(cat(), sh());
    expect(step.status).toBe('pending');
    expect(
      await readFile(join(f.to, 'config/claude-code/hooks/claude-hooks.yaml')).catch(() => undefined),
    ).toBeUndefined();
    expect(await stat(join(f.to, 'fleet/assets', BEFORE)).catch(() => undefined)).toBeUndefined();
    const named = JSON.stringify(step);
    expect(named).toContain('config/components/hooks/claude-hooks.yaml');
    expect(named).toContain('copy the file under fleet/assets in v4, or remove the hook');
    expect(named).not.toContain(`cat ${REAL}`);
    expect(named).not.toContain(REAL);
    expect(named).not.toContain(FAKE_KEY);
  });

test('a command naming a v4 path outside fleet/assets is not carried; the report names the component, not the command', async () => {
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  await put('state/secret-notes.txt', 'FAKE\n');
  const { step } = await run(`cat ${REAL}/state/OUTSIDE-CMD-MARKER.txt`, sh());
  expect(step.status).toBe('pending');
  const named = JSON.stringify(step);
  expect(named).toContain('config/components/hooks/claude-hooks.yaml');
  expect(named).toContain('outside a plain file under its fleet/assets');
  expect(named).not.toContain('OUTSIDE-CMD-MARKER');
  expect(await stat(join(f.to, 'fleet/assets', AFTER)).catch(() => undefined)).toBeUndefined();
});

test('a longer path that only starts with the v4 home is neither rewritten nor refused', async () => {
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const other = `cat ${REAL}-old/fleet/assets/${BEFORE}`;
  const { step } = await run(other, sh());
  expect(step.status).toBe('converted');
  const text = await hooksYaml();
  expect(text).toContain(other);
  expect(text).toContain(`sh ${f.to}/fleet/assets/${AFTER}`);
  expect(await stat(join(f.to, 'fleet/assets', BEFORE)).catch(() => undefined)).toBeUndefined();
});

test('a home-relative spelling that resolves to the v4 home is carried and rewritten as a whole token', async () => {
  await put(`fleet/assets/${BEFORE}`, 'FAKE notes\n');
  await put(`fleet/assets/${AFTER}`, SCRIPT, 0o700);
  const { step } = await run(`cat "~/.ferretry/fleet/assets/${BEFORE}"`, `sh $HOME/.ferretry/fleet/assets/${AFTER}`);
  expect(step.status).toBe('converted');
  const text = await hooksYaml();
  expect(text).toContain(`${f.to}/fleet/assets/${BEFORE}`);
  expect(text).not.toContain('.ferretry');
});
