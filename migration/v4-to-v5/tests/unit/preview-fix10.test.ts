import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ownerNote } from '../../preview/driver.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { convert } from '../../src/convert.ts';
import { acceptedConfigStep, previewAuthoredFiles } from '../../src/steps/accepted-config.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
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

/** A v4 file in effect as written: v4's record carries its exact text. */
const inEffect = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { etag: sha256(text), text }]));

/** A whole preview conversion (the plain pass included), restricted to the two steps these tests read. */
const run = async (owner: boolean) => {
  await put('layout-version', '2\n');
  const result = await convert({
    from: f.from,
    to: f.to,
    dryRun: false,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    host: { homeDirectory: f.root, env: {} },
    steps: [settingsStep, acceptedConfigStep],
    preview: true,
    previewV4Home: f.from,
    previewShellEnv: previewShellEnv(f.to, PREVIEW.port),
    ...(owner ? { previewOwner: true } : {}),
  });
  expect(result.kind).toBe('done');
  return result.kind === 'done' ? result.report : undefined;
};

const record = (name: string) =>
  readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName(name)}.json`), 'utf8').then(
    text => JSON.parse(text) as { text: string; plugin: string },
    () => undefined,
  );

/** A boot-style evaluate of the converted home's `limits.yaml` (the real kernel config service, in a subprocess). */
async function bootLimits(): Promise<{ state: string; agentControl: Record<string, boolean> | null }> {
  const script = join(f.root, 'boot-limits.ts');
  await writeFile(
    script,
    `
const [repo, home] = process.argv.slice(2);
const { config, state } = await import(repo + '/packages/core/kernel/host/index.ts');
const { fixedClock } = await import(repo + '/packages/core/kernel/testing/index.ts');
const manifest = (await import(repo + '/packages/core/ferrets/manifest.ts')).default;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } };
const def = manifest.data.config.find(item => item.file === 'limits.yaml');
const files = config.createConfigFiles({
  home, fs: state.createNodeHostFs(), clock: fixedClock('2026-11-09T09:00:00.000Z'), log: quiet, binary: 'fy',
  defs: [{ plugin: 'ferrets', def }], judge: () => false,
});
await files.reload();
const port = files.port('ferrets');
console.log(JSON.stringify({ state: port.fileState(def).state, agentControl: port.file(def)?.agentControl ?? null }));
`,
  );
  const child = Bun.spawn(['bun', script, REPO, f.to], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
  return JSON.parse(text) as { state: string; agentControl: Record<string, boolean> | null };
}

test('MAJOR-1 a held v4 agentControl loosening is NOT accepted by --owner: no limits.yaml record, neither switch on at boot', async () => {
  // v4 never enforced these: its record has no entry for machine.yaml (an edit it was holding).
  await put('config/machine.yaml', 'agentControl:\n  ferretrySettings: true\n  pageScripts: true\n');
  await put('state/config-accepted.json', JSON.stringify({}));
  const report = await run(true);
  expect(await record('limits.yaml')).toBeUndefined();
  // A pure preview file has no v4 source: it is still accepted with --owner.
  expect((await record('terminals.yaml'))?.plugin).toBe('terminals');
  expect((await record('claude-code/settings/fy-preview.yaml'))?.plugin).toBe('claude-code');
  // The converted text did carry the held loosening (the held record is what keeps it out of effect).
  expect(await readFile(join(f.to, 'config/limits.yaml'), 'utf8')).toContain('pageScripts: true');
  const boot = await bootLimits();
  expect(boot.agentControl?.ferretrySettings).not.toBe(true);
  expect(boot.agentControl?.pageScripts).not.toBe(true);
  // The report names the file and the remedy.
  const step = report?.steps.find(item => item.id === 'accepted-config');
  const said = step?.notCarried.find(item => item.what.startsWith('config/limits.yaml'));
  expect(said?.why).toContain('unconfirmed edit');
  expect(said?.why).toContain('preview.sh clean');
  expect(said?.why).toContain('preview.sh prepare --owner');
});

test('MAJOR-1 a v4 home with nothing held and --owner still records limits.yaml', async () => {
  await put('config/machine.yaml', 'timeZone: Europe/Berlin\n');
  await put('config/limits.yaml', 'enabled: true\n');
  await put(
    'state/config-accepted.json',
    JSON.stringify(inEffect({ 'machine.yaml': 'timeZone: Europe/Berlin\n', 'limits.yaml': 'enabled: true\n' })),
  );
  await run(true);
  expect((await record('limits.yaml'))?.plugin).toBe('ferrets');
  expect((await record('terminals.yaml'))?.plugin).toBe('terminals');
});

test('MAJOR-1 a held file the preview file does NOT come from does not hold it back', async () => {
  // limits.yaml came from limits.yaml and machine.yaml, both in effect; voice.yaml is held and unrelated.
  await put('config/machine.yaml', 'timeZone: Europe/Berlin\n');
  await put('config/limits.yaml', 'enabled: true\n');
  await put('config/voice.yaml', 'enabled: false\n');
  await put(
    'state/config-accepted.json',
    JSON.stringify(inEffect({ 'machine.yaml': 'timeZone: Europe/Berlin\n', 'limits.yaml': 'enabled: true\n' })),
  );
  await run(true);
  expect((await record('limits.yaml'))?.plugin).toBe('ferrets');
});

test('Nit ownerNote lists the computed set, runtimes.yaml included, from the report', async () => {
  await put('config/machine.yaml', 'autoResume: true\n');
  await put('state/config-accepted.json', JSON.stringify(inEffect({ 'machine.yaml': 'autoResume: true\n' })));
  const report = await run(false);
  const files = previewAuthoredFiles(report?.steps ?? []);
  expect(files).toContain('config/runtimes.yaml');
  expect(files).toContain('config/limits.yaml');
  expect(files).toContain('config/terminals.yaml');
  for (const file of files) {
    expect(ownerNote(false, files)).toContain(file);
    expect(ownerNote(true, files)).toContain(file);
  }
  expect(ownerNote(true, files)).toContain('unconfirmed edit');
});
