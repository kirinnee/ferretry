import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ownerNote } from '../../preview/driver.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { convert, dryConfigsOf } from '../../src/convert.ts';
import { acceptedConfigStep, previewAuthoredFiles, previewHeldFiles } from '../../src/steps/accepted-config.ts';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
import { CONFIG_TARGETS } from '../../src/v5/targets.ts';
import { fixture } from './ferret-fixture.ts';

const REPO = resolve(import.meta.dir, '../../../..');
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const put = async (path: string, text: string) => {
  await mkdir(join(f.from, path, '..'), { recursive: true });
  await writeFile(join(f.from, path), text);
};
const accept = async (files: Record<string, string>) =>
  put(
    'state/config-accepted.json',
    JSON.stringify(Object.fromEntries(Object.entries(files).map(([k, t]) => [k, { etag: sha256(t), text: t }]))),
  );

/** A whole conversion (the plain pass included), restricted to Settings and the accepted record. */
const run = async (owner: boolean, preview = true) => {
  await put('layout-version', '2\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps: [settingsStep, acceptedConfigStep],
    ...(preview
      ? {
          preview: true,
          previewV4Home: f.from,
          previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
          ...(owner ? { previewOwner: true } : {}),
        }
      : {}),
  });
  expect(result.kind).toBe('done');
  return result.kind === 'done' ? result.report : undefined;
};
const records = async () =>
  (await readdir(join(f.to, 'state/kernel/accepted-config')).catch(() => [] as string[])).sort();
const record = (name: string) =>
  readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName(name)}.json`), 'utf8').then(
    text => JSON.parse(text) as { text: string; plugin: string },
    () => undefined,
  );

interface Boot {
  readonly state: string;
  readonly enabled: boolean | undefined;
  readonly perFerret: unknown;
  readonly control: Record<string, boolean>;
}

/** A boot-style evaluate of the converted home's `limits.yaml` (the real kernel config service, in a subprocess). */
async function bootLimits(): Promise<Boot> {
  const script = join(f.root, 'boot-limits.ts');
  await writeFile(
    script,
    `
const [repo, home] = process.argv.slice(2);
const { config, state } = await import(repo + '/packages/core/kernel/host/index.ts');
const { fixedClock } = await import(repo + '/packages/core/kernel/testing/index.ts');
const { effectiveAgentControl } = await import(repo + '/packages/core/ferrets/contract/state.ts');
const manifest = (await import(repo + '/packages/core/ferrets/manifest.ts')).default;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const def = manifest.data.config.find(item => item.file === 'limits.yaml');
const files = config.createConfigFiles({
  home, fs: state.createNodeHostFs(), clock: fixedClock('2026-11-09T09:00:00.000Z'), log: quiet, binary: 'fy',
  defs: [{ plugin: 'ferrets', def }], judge: () => false,
});
await files.reload();
const port = files.port('ferrets');
const file = port.file(def);
console.log(JSON.stringify({ state: port.fileState(def).state, enabled: file?.enabled, perFerret: file?.perFerret ?? null, control: effectiveAgentControl(file) }));
`,
  );
  const child = Bun.spawn(['bun', script, REPO, f.to], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
  return JSON.parse(text) as Boot;
}

test('MAJOR-1 v4 enforced agents-off terminals and browsers, a held edit says on: both stay OFF (plain, preview, --owner)', async () => {
  await put('config/machine.yaml', 'agentControl:\n  terminals: true\n  browsers: true\n');
  await accept({ 'machine.yaml': 'agentControl:\n  terminals: false\n  browsers: false\n' });
  for (const [owner, preview] of [
    [true, true],
    [false, true],
    [false, false],
  ] as const) {
    await rm(f.to, { recursive: true, force: true });
    await run(owner, preview);
    const boot = await bootLimits();
    expect({ owner, preview, terminals: boot.control.terminals, browsers: boot.control.browsers }).toEqual({
      owner,
      preview,
      terminals: false,
      browsers: false,
    });
    // The v5 file still carries what v4 holds (the owner may confirm it); the record carries what v4 enforced.
    expect(await readFile(join(f.to, 'config/limits.yaml'), 'utf8')).toContain('terminals: true');
    expect((await record('limits.yaml'))?.text).toContain('terminals: false');
  }
});

test('MAJOR-1 a held DELETION of a machine.yaml that enforced terminals off: terminals stay OFF', async () => {
  await accept({ 'machine.yaml': 'agentControl:\n  terminals: false\n' });
  for (const [owner, preview] of [
    [true, true],
    [false, false],
  ] as const) {
    await rm(f.to, { recursive: true, force: true });
    await run(owner, preview);
    const boot = await bootLimits();
    expect({ owner, preview, terminals: boot.control.terminals, state: boot.state }).toMatchObject({
      terminals: false,
    });
    expect((await record('limits.yaml'))?.text).toContain('terminals: false');
  }
});

test('MAJOR-1 a file with no held edit is unchanged: recorded with its own text', async () => {
  const machine = 'agentControl:\n  terminals: false\n';
  await put('config/machine.yaml', machine);
  await accept({ 'machine.yaml': machine });
  await run(false, false);
  expect((await record('limits.yaml'))?.text).toBe(await readFile(join(f.to, 'config/limits.yaml'), 'utf8'));
});

test('MINOR-1 a held DELETION of limits.yaml is a held source: --owner records what v4 enforced, never the preview text', async () => {
  const machine = 'agentControl:\n  pageScripts: false\n';
  await put('config/machine.yaml', machine);
  await accept({ 'limits.yaml': 'enabled: true\nperFerret:\n  memoryMax: 1G\n', 'machine.yaml': machine });
  const report = await run(true);
  // The preview's own limits.yaml (it forces `enabled: false`) is not what is recorded.
  expect((await record('limits.yaml'))?.text).toContain('memoryMax: 1G');
  expect(await readFile(join(f.to, 'config/limits.yaml'), 'utf8')).not.toContain('memoryMax');
  const step = report?.steps.find(item => item.id === 'accepted-config');
  expect(step?.notCarried.some(item => item.what.startsWith('config/limits.yaml'))).toBe(true);
  expect(previewHeldFiles(report?.steps ?? [])).toContain('config/limits.yaml');
});

test('MINOR-2 a write that names no source counts as held whenever anything is held: no record, even with --owner', async () => {
  // v4 has a held limits.yaml on disk (never accepted) and an accepted machine.yaml.
  await put('config/limits.yaml', 'enabled: true\n');
  await put('config/machine.yaml', 'timeZone: Europe/Berlin\n');
  await accept({ 'machine.yaml': 'timeZone: Europe/Berlin\n' });
  const ctx = {
    ...f.ctx(),
    preview: true,
    previewOwner: true,
    plainConfigs: new Map<string, string>(),
    dryConfigs: dryConfigsOf(f.from, f.to, undefined, [settingsStep]),
  };
  await ctx.v5.config(CONFIG_TARGETS.RUNTIMES, undefined, 'autoResume: false\n');
  await ctx.v5.config(CONFIG_TARGETS.USAGE, undefined, 'timeZone: Europe/Berlin\n', ['config/machine.yaml']);
  await acceptedConfigStep.run(ctx);
  const names = await records();
  expect(names).not.toContain(`${acceptedName('runtimes.yaml')}.json`);
  // A source that is in effect still records.
  expect(names).toContain(`${acceptedName('usage.yaml')}.json`);
});

test('MINOR-3 and Nit 2 the printed note names every held file with its reason, no "EXCEPT one"', async () => {
  await put('config/machine.yaml', 'autoResume: true\nagentControl:\n  pageScripts: true\n');
  await accept({});
  const report = await run(true);
  const files = previewAuthoredFiles(report?.steps ?? []);
  const held = previewHeldFiles(report?.steps ?? []);
  expect(held.length).toBeGreaterThan(0);
  const note = ownerNote(true, files, held);
  for (const file of held) expect(note.split('NOT recorded')[1]).toContain(file);
  for (const file of files.filter(name => !held.includes(name))) expect(note.split('NOT recorded')[0]).toContain(file);
  expect(note).toContain('unconfirmed edit');
  expect(note).toContain('preview.sh prepare --owner');
  expect(note).not.toContain('EXCEPT one');
  expect(ownerNote(false, files)).not.toContain('except one');
});

test('Nit 1 the held reason for runtimes.yaml is truthful: it can loosen nothing, so it is in effect anyway', async () => {
  await put('config/machine.yaml', 'autoResume: true\nagentControl:\n  pageScripts: true\n');
  await accept({});
  const report = await run(true);
  const step = report?.steps.find(item => item.id === 'accepted-config');
  const said = step?.notCarried.find(item => item.what.startsWith('config/runtimes.yaml'));
  expect(said?.why).toContain('runtimes.yaml');
  expect(said?.why).toContain('in effect anyway');
  expect(said?.why).not.toContain('last good or default for it (for limits.yaml');
});

test('Nit 3 daemon-settings records ALL of a file’s v4 sources', async () => {
  await f.put('config/daemon.json', { grants: { terminal: { use: false, configure: false } } });
  await f.put('state/security.json', {
    schemaVersion: 1,
    settings: { unlockValidityHours: 1, stepUpOnActions: true, stepUpWindowMinutes: 0 },
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const ctx = f.ctx(true);
  await daemonSettingsStep.run(ctx);
  const sources = ctx.v5.writtenSources().get('config/gate.yaml');
  expect(sources?.size ?? 0).toBeGreaterThan(1);
});
