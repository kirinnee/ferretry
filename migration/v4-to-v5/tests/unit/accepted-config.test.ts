import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedConfigFile, acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dryConfigsOf } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const LIMITS = '# keep the daemon reachable\nenabled: true\nperFerret:\n  memoryMax: 4G\n';
const WARDEN = 'enabled: true\n';

const yaml = async (path: string, text: string) => {
  const target = join(f.from, 'config', path);
  await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
  await writeFile(target, text, { mode: 0o600 });
};
const acceptedDir = () => join(f.to, 'state/kernel/accepted-config');
const listAccepted = () => readdir(acceptedDir()).catch(() => [] as string[]);

/** Settings then the accepted step, on ONE writer, as the converter runs them. */
async function convert(dryRun = false) {
  // `dryConfigs` is what the converter hands every step: the plain dry conversion of a v4 home (here just Settings).
  const ctx = { ...f.ctx(dryRun), dryConfigs: dryConfigsOf(f.from, f.to, undefined, [settingsStep]) };
  expect((await settingsStep.run(ctx)).status).toBe('converted');
  return await acceptedConfigStep.run(ctx);
}

test('every v4 file in effect as written: each config file the run wrote is recorded as accepted with its own text', async () => {
  await yaml('limits.yaml', LIMITS);
  await yaml('warden.yaml', WARDEN);
  await f.put('state/config-accepted.json', {
    'limits.yaml': { etag: sha256(LIMITS), text: LIMITS },
    'warden.yaml': { etag: sha256(WARDEN), text: WARDEN },
  });
  const report = await convert();
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'v4 config files in effect as written', count: 2 });
  for (const name of ['limits.yaml', 'warden.yaml']) {
    const v5Text = await readFile(join(f.to, 'config', name), 'utf8');
    const raw = await readFile(join(acceptedDir(), `${acceptedName(name)}.json`), 'utf8');
    const document = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(document)[0]).toBe('format');
    const { format, ...body } = document;
    expect(format).toBe(acceptedConfigFile.format);
    // Each record names the plugin whose def owns the file (the kernel reads a record only for that plugin).
    const plugin = name === 'limits.yaml' ? 'ferrets' : 'warden';
    expect(acceptedConfigFile.schema?.parse(body)).toEqual({ etag: sha256(v5Text), text: v5Text, plugin });
  }
  expect(JSON.stringify(report)).not.toContain('memoryMax');
});

const recordOf = async (name: string) =>
  JSON.parse(await readFile(join(acceptedDir(), `${acceptedName(name)}.json`), 'utf8')) as { text: string };

test('a held edit: the v5 file carries v4 current text, the record carries what v4 ENFORCED; the report names the file, never its text', async () => {
  await yaml('limits.yaml', LIMITS);
  await yaml('warden.yaml', WARDEN);
  const older = 'enabled: false\n';
  await f.put('state/config-accepted.json', {
    'limits.yaml': { etag: sha256(LIMITS), text: LIMITS },
    'warden.yaml': { etag: sha256(older), text: older },
  });
  const report = await convert();
  expect(report.status).toBe('converted');
  // The file in effect as written is recorded with its own text; the held one with the text v4 ENFORCED.
  expect((await recordOf('limits.yaml')).text).toBe(await readFile(join(f.to, 'config/limits.yaml'), 'utf8'));
  const enforced = (await recordOf('warden.yaml')).text;
  const current = await readFile(join(f.to, 'config/warden.yaml'), 'utf8');
  expect(enforced).toContain('enabled: false');
  expect(current).toContain('enabled: true');
  expect(enforced).not.toBe(current);
  const what = report.notCarried.map(item => item.what).join('\n');
  expect(what).toContain('warden.yaml');
  expect(what).not.toContain('limits.yaml');
  expect(JSON.stringify(report)).not.toContain('enabled');
});

test('a held DELETION: the v5 file is absent and the record carries the enforced text', async () => {
  await yaml('limits.yaml', LIMITS);
  await f.put('state/config-accepted.json', {
    'limits.yaml': { etag: sha256(LIMITS), text: LIMITS },
    'warden.yaml': { etag: sha256(WARDEN), text: WARDEN },
  });
  await convert();
  expect(await readFile(join(f.to, 'config/warden.yaml'), 'utf8').catch(() => undefined)).toBeUndefined();
  expect((await recordOf('warden.yaml')).text).toContain('enabled: true');
});

test('a held file v4 never accepted carries no record', async () => {
  await yaml('limits.yaml', LIMITS);
  await yaml('warden.yaml', WARDEN);
  await f.put('state/config-accepted.json', { 'limits.yaml': { etag: sha256(LIMITS), text: LIMITS } });
  await convert();
  expect(await listAccepted()).toEqual([`${acceptedName('limits.yaml')}.json`]);
});

test('no accepted record at all, or a held deletion of a file this run does not write: no record for the unconverted file', async () => {
  await yaml('limits.yaml', LIMITS);
  expect(await listAccepted()).toEqual([]);
  let report = await convert();
  // v4 enforced nothing for limits.yaml: no record.
  expect(await listAccepted()).toEqual([]);
  expect(report.notCarried.map(item => item.what).join('\n')).toContain('limits.yaml');

  await f.clean();
  f = await fixture();
  await yaml('limits.yaml', LIMITS);
  await f.put('state/config-accepted.json', {
    'limits.yaml': { etag: sha256(LIMITS), text: LIMITS },
    'voice.yaml': { etag: sha256('x: 1\n'), text: 'x: 1\n' },
  });
  report = await convert();
  // limits.yaml was in effect as written (recorded); the deleted voice.yaml converts to nothing here.
  expect(await listAccepted()).toEqual([`${acceptedName('limits.yaml')}.json`]);
  expect(report.notCarried.map(item => item.what).join('\n')).toContain('voice.yaml');
});

test('a damaged accepted record is read as nothing accepted; a dry run writes nothing', async () => {
  await yaml('limits.yaml', LIMITS);
  await mkdir(join(f.from, 'state'), { recursive: true });
  await writeFile(join(f.from, 'state/config-accepted.json'), '{ not json');
  const report = await convert();
  expect(await listAccepted()).toEqual([]);
  expect(report.notCarried.map(item => item.what).join('\n')).toContain('state/config-accepted.json');

  await f.clean();
  f = await fixture();
  await yaml('limits.yaml', LIMITS);
  await f.put('state/config-accepted.json', { 'limits.yaml': { etag: sha256(LIMITS), text: LIMITS } });
  const dry = await convert(true);
  expect(dry.kept).toContainEqual({ what: 'v5 config files recorded as accepted', count: 1 });
  expect(await readdir(f.to).catch(() => [])).toEqual([]);
});
