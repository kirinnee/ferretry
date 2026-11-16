import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { CONFIG_TARGETS, configOwner } from '../../src/v5/targets.ts';
import { configPath } from '../../src/v5/write.ts';
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

/** Runs a script in a subprocess that imports nothing from this tool (the converter is outside the workspace). */
async function runScript(name: string, source: string, args: readonly string[]): Promise<unknown> {
  const script = join(f.root, name);
  await writeFile(script, source);
  const child = Bun.spawn(['bun', script, REPO, ...args], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  const [text, error] = [await new Response(child.stdout).text(), await new Response(child.stderr).text()];
  expect({ code: await child.exited, error }).toEqual({ code: 0, error: '' });
  return JSON.parse(text);
}

test('Minor-1 a carried accepted v4 file that loosens against the defaults is in effect at a boot-style evaluate', async () => {
  // `enabled: false` switches limits off: against the defaults that is a loosening, held unless v5 has it ACCEPTED.
  const text = 'enabled: false\n';
  await mkdir(join(f.from, 'config'), { recursive: true });
  await writeFile(join(f.from, 'config/limits.yaml'), text);
  await f.put('state/config-accepted.json', { 'limits.yaml': { etag: sha256(text), text } });
  const ctx = f.ctx();
  expect((await settingsStep.run(ctx)).status).toBe('converted');
  await acceptedConfigStep.run(ctx);

  const record = JSON.parse(
    await readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName('limits.yaml')}.json`), 'utf8'),
  ) as { plugin?: string; text: string };
  expect(record.plugin).toBe('ferrets');
  expect(record.text).toBe(await readFile(join(f.to, 'config/limits.yaml'), 'utf8'));

  const result = await runScript(
    'boot-limits.ts',
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
console.log(JSON.stringify({ state: files.port('ferrets').fileState(def).state, enabled: files.port('ferrets').file(def)?.enabled }));
`,
    [f.to],
  );
  expect(result).toEqual({ state: 'valid', enabled: false });
});

test('Minor-1 a path no def owns is not recorded and is named in the report', async () => {
  const stray = {
    shape: 'file' as const,
    file: 'stray.yaml',
    schema: z.looseObject({}),
    plugin: 'nobody',
  };
  const text = 'a: 1\n';
  await mkdir(join(f.from, 'config'), { recursive: true });
  await writeFile(join(f.from, 'config/limits.yaml'), 'enabled: false\n');
  await f.put('state/config-accepted.json', {
    'limits.yaml': { etag: sha256('enabled: false\n'), text: 'enabled: false\n' },
  });
  const ctx = f.ctx();
  expect((await settingsStep.run(ctx)).status).toBe('converted');
  await ctx.v5.config(stray, undefined, text);
  expect(configOwner(configPath(stray))).toBeUndefined();
  const report = await acceptedConfigStep.run(ctx);
  expect(report.notCarried.map(item => item.what).join('\n')).toContain('config/stray.yaml');
  await expect(
    readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName('stray.yaml')}.json`), 'utf8'),
  ).rejects.toThrow();
  // The owned file beside it is still recorded.
  const limits = JSON.parse(
    await readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName('limits.yaml')}.json`), 'utf8'),
  ) as { plugin: string };
  expect(limits.plugin).toBe('ferrets');
});

test('Minor-1 every target names the plugin whose manifest declares it (data.config)', async () => {
  const targets = Object.entries(CONFIG_TARGETS).map(([key, target]) => ({
    key,
    plugin: target.plugin,
    ...(target.shape === 'file' ? { file: target.file } : { collection: target.collection }),
  }));
  const problems = await runScript(
    'manifests.ts',
    `
const [repo, listed] = process.argv.slice(2);
const problems = [];
for (const target of JSON.parse(listed)) {
  let manifest;
  for (const dir of ['plugins', 'core']) {
    try { manifest = (await import(repo + '/packages/' + dir + '/' + target.plugin + '/manifest.ts')).default; break; } catch {}
  }
  if (manifest === undefined || manifest.id !== target.plugin) { problems.push(target.key + ': no manifest with id ' + target.plugin); continue; }
  const found = manifest.data.config.some(def => (target.file !== undefined ? def.file === target.file : def.collection === target.collection));
  if (!found) problems.push(target.key + ': ' + target.plugin + ' does not declare it');
}
console.log(JSON.stringify(problems));
`,
    [JSON.stringify(targets)],
  );
  expect(problems).toEqual([]);
});
