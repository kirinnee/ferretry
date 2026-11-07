import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedConfigFile, acceptedName } from '@ferretry/kernel/contract';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  const ctx = f.ctx(dryRun);
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
    expect(acceptedConfigFile.schema?.parse(body)).toEqual({ etag: sha256(v5Text), text: v5Text });
  }
  expect(JSON.stringify(report)).not.toContain('memoryMax');
});

test('a held edit anywhere: nothing is recorded, and the report names the file, never its text', async () => {
  await yaml('limits.yaml', LIMITS);
  await yaml('warden.yaml', WARDEN);
  const older = 'enabled: false\n';
  await f.put('state/config-accepted.json', {
    'limits.yaml': { etag: sha256(LIMITS), text: LIMITS },
    'warden.yaml': { etag: sha256(older), text: older },
  });
  const report = await convert();
  expect(report.status).toBe('converted');
  expect(await listAccepted()).toEqual([]);
  const what = report.notCarried.map(item => item.what).join('\n');
  expect(what).toContain('warden.yaml');
  expect(what).not.toContain('limits.yaml');
  expect(JSON.stringify(report)).not.toContain('enabled');
});

test('no accepted record, a file v4 never accepted, or a held deletion: nothing is recorded', async () => {
  await yaml('limits.yaml', LIMITS);
  expect(await listAccepted()).toEqual([]);
  let report = await convert();
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
  expect(await listAccepted()).toEqual([]);
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
