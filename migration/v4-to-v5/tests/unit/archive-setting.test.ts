import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ARCHIVE_MAX_HOURS, ArchiveConfigFile, ArchiveSettingsSchema } from '@ferretry/core-ferrets/contract';
import { ARCHIVE_CONFIG, archiveSettingStep } from '../../src/steps/archive-setting.ts';
import type { HostFacts } from '../../src/steps/index.ts';
import { parseArchiveAfter, plistEnvironmentValue, systemdEnvironmentWords } from '../../src/v4/archive-after.ts';
import { fixture } from './ferret-fixture.ts';

const VARIABLE = 'FYD_SESSION_ARCHIVE_AFTER_HOURS';

let f: Awaited<ReturnType<typeof fixture>>;
/** A pretend user home under the temp root: the converter never reads a real one in these tests. */
let user: string;
beforeEach(async () => {
  f = await fixture();
  user = join(f.root, 'user');
  await mkdir(user, { recursive: true });
});
afterEach(async () => {
  await f.clean();
});

const put = async (path: string, text: string) => {
  const target = join(user, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, text);
};
const UNIT_DIR = '.config/systemd/user';
const PLIST = 'Library/LaunchAgents/com.ferretry.fyd.plist';

/** The unit `fy daemon install` renders: it names the state home and never the variable. */
const unit = (home = f.from) =>
  `[Unit]\nDescription=fyd\n\n[Service]\nEnvironment="FY_HOME=${home}"\nEnvironment="HOME=${user}"\nEnvironment="PATH=/usr/bin"\nExecStart="/bin/fyd"\n`;
const plist = (extra = '', home = f.from) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.ferretry.fyd</string><key>EnvironmentVariables</key><dict><key>FY_HOME</key><string>${home}</string>${extra}</dict></dict></plist>\n`;

const run = (env: Record<string, string | undefined> = {}, host: HostFacts | undefined = undefined) =>
  archiveSettingStep.run({ ...f.ctx(), host: host ?? { homeDirectory: user, env } });
const archive = async (): Promise<unknown> => parse(await readFile(join(f.to, 'config', 'archive.yaml'), 'utf8'));
const written = () =>
  stat(join(f.to, 'config', 'archive.yaml')).then(
    () => true,
    () => false,
  );

test('a value in the documented systemd drop-in is carried to archive.yaml afterHours', async () => {
  await put(`${UNIT_DIR}/fyd.service`, unit());
  await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=24"\n`);
  const report = await run();
  expect(report.status).toBe('converted');
  expect(await archive()).toEqual({ afterHours: 24 });
  expect(report.kept[0]?.what).toContain('24 h');
  expect(report.kept[0]?.what).toContain('fyd.service.d/archive.conf');
});

test('a value in the launchd plist EnvironmentVariables is carried', async () => {
  await put(PLIST, plist(`<key>${VARIABLE}</key>\n    <string>48</string>`));
  const report = await run();
  expect(report.status).toBe('converted');
  expect(await archive()).toEqual({ afterHours: 48 });
  expect(report.kept[0]?.what).toContain('launchd plist');
});

test('an invalid value writes nothing and says so, so the default stays off', async () => {
  for (const bad of ['soon', '0', '-3', '1.5', '24h', '08']) {
    await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=${bad}"\n`);
    const report = await run();
    expect(report.status).toBe('converted');
    expect(report.kept).toEqual([]);
    expect(report.note).toContain('archive.yaml not written');
    expect(report.note).toContain('refuses');
    // The bad value itself is never echoed.
    expect(report.note).not.toContain(`=${bad}`);
    expect(await written()).toBe(false);
  }
});

test('an absent value writes nothing and says so', async () => {
  await put(`${UNIT_DIR}/fyd.service`, unit());
  await put(PLIST, plist());
  const report = await run();
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([]);
  expect(report.note).toContain('unset');
  expect(await written()).toBe(false);
});

test('off and empty are v4’s default: nothing written, and the winning source is the one that said off', async () => {
  await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=OFF"\n`);
  const report = await run({ [VARIABLE]: '24' });
  expect(report.kept).toEqual([]);
  expect(report.note).toContain('off or empty');
  expect(await written()).toBe(false);
});

test('order: a later drop-in beats an earlier one, drop-ins beat the unit, the service beats the environment', async () => {
  await put(`${UNIT_DIR}/fyd.service`, unit().replace('[Service]\n', `[Service]\nEnvironment="${VARIABLE}=6"\n`));
  await put(`${UNIT_DIR}/fyd.service.d/10-a.conf`, `[Service]\nEnvironment=${VARIABLE}=12\n`);
  await put(`${UNIT_DIR}/fyd.service.d/20-b.conf`, `[Service]\nEnvironment="X=1" "${VARIABLE}=72"\n`);
  await put(PLIST, plist(`<key>${VARIABLE}</key><string>96</string>`));
  const report = await run({ [VARIABLE]: '120' });
  expect(await archive()).toEqual({ afterHours: 72 });
  expect(report.kept[0]?.what).toContain('20-b.conf');
});

test('with no service definition the converter’s own environment is the fallback', async () => {
  const report = await run({ [VARIABLE]: ' 36 ' });
  expect(await archive()).toEqual({ afterHours: 36 });
  expect(report.kept[0]?.what).toContain('environment');
});

test('the plist wins over the environment, and an invalid first source is not skipped', async () => {
  await put(PLIST, plist(`<key>${VARIABLE}</key><string>soon</string>`));
  const report = await run({ [VARIABLE]: '24' });
  expect(report.kept).toEqual([]);
  expect(await written()).toBe(false);
});

test('a unit that supervises another state home is not this home’s setting', async () => {
  await put(`${UNIT_DIR}/fyd.service`, unit(join(f.root, 'elsewhere')));
  await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=24"\n`);
  const report = await run();
  expect(await written()).toBe(false);
  expect(report.note).toContain('another state home');
});

test('XDG_CONFIG_HOME moves where the unit is read from', async () => {
  const xdg = join(f.root, 'xdg');
  await mkdir(join(xdg, 'systemd/user/fyd.service.d'), { recursive: true });
  await writeFile(join(xdg, 'systemd/user/fyd.service.d/archive.conf'), `[Service]\nEnvironment="${VARIABLE}=24"\n`);
  await run({}, { homeDirectory: user, configHome: xdg, env: {} });
  expect(await archive()).toEqual({ afterHours: 24 });
});

test('a value v5 cannot hold (over a year) is not carried, and a dry run writes nothing', async () => {
  await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=9000"\n`);
  const big = await run();
  expect(big.kept).toEqual([]);
  expect(big.note).toContain('8760');
  await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=24"\n`);
  const dry = await archiveSettingStep.run({ ...f.ctx(true), host: { homeDirectory: user, env: {} } });
  expect(dry.kept).toHaveLength(1);
  expect(await written()).toBe(false);
});

test('no host facts: nothing is read, nothing is written', async () => {
  const report = await archiveSettingStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toContain('no host facts');
  expect(await written()).toBe(false);
});

test('the parse rule is v4’s own, and the readers handle the spellings systemd and launchd allow', () => {
  expect(parseArchiveAfter(undefined)).toEqual({ kind: 'off' });
  expect(parseArchiveAfter('  OFF ')).toEqual({ kind: 'off' });
  expect(parseArchiveAfter('24')).toEqual({ kind: 'hours', hours: 24 });
  expect(parseArchiveAfter('0')).toEqual({ kind: 'invalid' });
  expect(systemdEnvironmentWords(`A=1 "B=two words" 'C=3' D=4\\ 5 E=100%%`)).toEqual([
    'A=1',
    'B=two words',
    'C=3',
    'D=4 5',
    'E=100%',
  ]);
  expect(plistEnvironmentValue(plist(`<key>${VARIABLE}</key><string>2&amp;4</string>`), VARIABLE).value).toBe('2&4');
  expect(plistEnvironmentValue(plist(), VARIABLE).value).toBeUndefined();
  expect(plistEnvironmentValue('bplist00....', VARIABLE).binary).toBe(true);
  // A key outside EnvironmentVariables is not the variable.
  expect(
    plistEnvironmentValue(`<dict><key>${VARIABLE}</key><string>24</string></dict>`, VARIABLE).value,
  ).toBeUndefined();
});

test('the converter writes archive.yaml with the reader’s own schema, and what it writes parses with it', async () => {
  // One fact, one owner: the step's target IS Ferrets' ArchiveConfigFile, never a restatement of it.
  expect(ARCHIVE_CONFIG.shape).toBe('file');
  expect(ARCHIVE_CONFIG.shape === 'file' ? ARCHIVE_CONFIG.file : undefined).toBe(ArchiveConfigFile.file);
  expect(ARCHIVE_CONFIG.schema).toBe(ArchiveConfigFile.schema);
  for (const hours of ['1', '24', String(ARCHIVE_MAX_HOURS)]) {
    await f.clean();
    f = await fixture();
    user = join(f.root, 'user');
    await put(`${UNIT_DIR}/fyd.service`, unit());
    await put(`${UNIT_DIR}/fyd.service.d/archive.conf`, `[Service]\nEnvironment="${VARIABLE}=${hours}"\n`);
    expect((await run()).status).toBe('converted');
    const read = ArchiveSettingsSchema.safeParse(await archive());
    expect(read.success).toBe(true);
    expect(read.data).toEqual({ afterHours: Number(hours) });
  }
  // One past the reader's bound is not carried at all: nothing the reader would refuse is ever written.
  await f.clean();
  f = await fixture();
  user = join(f.root, 'user');
  await put(`${UNIT_DIR}/fyd.service`, unit());
  await put(
    `${UNIT_DIR}/fyd.service.d/archive.conf`,
    `[Service]\nEnvironment="${VARIABLE}=${String(ARCHIVE_MAX_HOURS + 1)}"\n`,
  );
  await run();
  expect(await written()).toBe(false);
});
