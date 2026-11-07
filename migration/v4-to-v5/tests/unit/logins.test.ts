import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ModelsStateSchema } from '@ferretry/plugin-logins/contract';
import { chmod, lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loginsStep, V5_CREDENTIALS, V5_MODELS } from '../../src/steps/logins.ts';
import { AT, fixture } from './ferret-fixture.ts';

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  // A mode-0000 file must not stop the temp folder from being removed.
  await chmod(join(f.from, 'fleet/credentials/work/locked.json'), 0o600).catch(() => undefined);
  await chmod(join(f.to, V5_CREDENTIALS, 'work/locked.json'), 0o600).catch(() => undefined);
  await f.clean();
});

// FAKE sign-in bytes (not real credentials): each is a marker that must reach no report and no note.
const FAKE_CLAUDE = '{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-NOT-A-TOKEN"}}\n';
const FAKE_LOCKED = 'FAKE-LOCKED-SIGN-IN-BYTES';
const FAKE_NESTED = 'FAKE-NESTED-BYTES';
const FAKE_CODEX = '{"tokens":{"refresh_token":"FAKE-REFRESH-NOT-A-TOKEN"}}';

async function plantLogins() {
  const credentials = join(f.from, 'fleet/credentials');
  const work = join(credentials, 'work');
  await mkdir(join(work, 'nested'), { recursive: true, mode: 0o700 });
  await writeFile(join(work, '.credentials.json'), FAKE_CLAUDE, { mode: 0o600 });
  await writeFile(join(work, 'nested', 'state.bin'), FAKE_NESTED, { mode: 0o640 });
  await writeFile(join(work, 'locked.json'), FAKE_LOCKED, { mode: 0o600 });
  await chmod(join(work, 'locked.json'), 0o000);
  await writeFile(join(work, 'usage.json'), '{"version":1,"source":"claude-statusline","at":1}');
  // A link out of the home (the harness's own store): made again as the same link, never followed.
  await symlink('/nonexistent/FAKE-host-store/.credentials.json', join(work, 'host.json'));
  // A link inside the credentials folder: pointed at the same file in the new home.
  await symlink(join(work, '.credentials.json'), join(work, 'alias.json'));
  const codex = join(credentials, 'codex-1');
  await mkdir(codex, { mode: 0o700 });
  await writeFile(join(codex, 'auth.json'), FAKE_CODEX, { mode: 0o600 });
  // A whole login that is a link to a folder outside the home.
  await symlink('/nonexistent/FAKE-dot-codex', join(credentials, 'shared'));
  await chmod(work, 0o700);
}

test('moves each sign-in folder whole: same bytes, same modes, links remade, nothing opened or reported', async () => {
  await plantLogins();
  const report = await loginsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  const to = join(f.to, V5_CREDENTIALS);
  expect((await readdir(to)).sort()).toEqual(['codex-1', 'shared', 'work']);

  // The mode-0000 file moved although the step may not open it: still mode 0000, same bytes (checked by the test).
  const locked = join(to, 'work/locked.json');
  expect((await lstat(locked)).mode & 0o777).toBe(0o000);
  await chmod(locked, 0o600);
  expect(await readFile(locked, 'utf8')).toBe(FAKE_LOCKED);

  expect(await readFile(join(to, 'work/.credentials.json'), 'utf8')).toBe(FAKE_CLAUDE);
  expect((await stat(join(to, 'work/.credentials.json'))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(to, 'work/nested/state.bin'), 'utf8')).toBe(FAKE_NESTED);
  expect((await stat(join(to, 'work/nested/state.bin'))).mode & 0o777).toBe(0o640);
  expect((await stat(join(to, 'work'))).mode & 0o777).toBe(0o700);
  expect(await readFile(join(to, 'codex-1/auth.json'), 'utf8')).toBe(FAKE_CODEX);

  expect(await readlink(join(to, 'work/host.json'))).toBe('/nonexistent/FAKE-host-store/.credentials.json');
  expect(await readlink(join(to, 'work/alias.json'))).toBe(join(to, 'work/.credentials.json'));
  expect(await readlink(join(to, 'shared'))).toBe('/nonexistent/FAKE-dot-codex');
  // Usage's passive reading is not a sign-in: left for Usage.
  expect(await readdir(join(to, 'work'))).not.toContain('usage.json');

  expect(report.kept).toContainEqual({ what: 'login sign-in folders (moved unopened)', count: 3 });
  expect(report.kept).toContainEqual({ what: 'links in sign-in folders made again, never followed', count: 3 });
  expect(report.sealed).toEqual([
    { file: join(V5_CREDENTIALS, 'codex-1/auth.json'), bytes: FAKE_CODEX.length },
    { file: join(V5_CREDENTIALS, 'work/.credentials.json'), bytes: FAKE_CLAUDE.length },
    { file: join(V5_CREDENTIALS, 'work/locked.json'), bytes: FAKE_LOCKED.length },
    { file: join(V5_CREDENTIALS, 'work/nested/state.bin'), bytes: FAKE_NESTED.length },
  ]);
  expect(report.note).toContain('1 passive usage reading(s) left for Usage');
  // Not root: the kernel refused to open the mode-0000 file, so it was given a second name, never read.
  if (process.getuid?.() !== 0)
    expect(report.note).toContain('1 unreadable sign-in file(s) given a second name (link(2)) instead of a copy');
  const text = JSON.stringify(report);
  for (const secret of ['FAKE-ACCESS', 'FAKE-LOCKED', 'FAKE-NESTED', 'FAKE-REFRESH'])
    expect(text).not.toContain(secret);
});

test('the v4 credentials are left where they were', async () => {
  await plantLogins();
  const before = (await readdir(join(f.from, 'fleet/credentials'), { recursive: true })).sort();
  await loginsStep.run(f.ctx());
  expect((await readdir(join(f.from, 'fleet/credentials'), { recursive: true })).sort()).toEqual(before);
  expect((await lstat(join(f.from, 'fleet/credentials/work/locked.json'))).mode & 0o777).toBe(0o000);
});

test('a login id with capitals fails naming the login, never a byte of it', async () => {
  await mkdir(join(f.from, 'fleet/credentials/Work'), { recursive: true });
  await writeFile(join(f.from, 'fleet/credentials/Work/.credentials.json'), FAKE_CLAUDE);
  const report = await loginsStep.run(f.ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe(
    'fleet/credentials/Work: login "Work" is not a v5 login id (lowercase letters, digits and dashes); rename the login in v4 first',
  );
  expect(JSON.stringify(report)).not.toContain('FAKE-ACCESS');
  expect(await stat(join(f.to, V5_CREDENTIALS)).catch(() => undefined)).toBeUndefined();
});

test('a dry run lists what would move and writes nothing', async () => {
  await plantLogins();
  const report = await loginsStep.run(f.ctx(true));
  expect(report.status).toBe('converted');
  expect(report.sealed.length).toBe(4);
  expect(report.note).toStartWith('dry run: nothing written');
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});

test('the published model catalog v4 last took becomes models.json', async () => {
  const catalog = { v: 1, catalogs: { fake: { label: 'Fake catalog' } } };
  await f.put('state/model-catalog.json', {
    version: 7,
    document: catalog,
    fetchedAt: AT,
    checkedAt: AT,
    last: { outcome: 'unchanged' },
  });
  const report = await loginsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toContainEqual({ what: 'published model catalog', count: 1 });
  const models = ModelsStateSchema.parse(JSON.parse(await readFile(join(f.to, V5_MODELS), 'utf8')));
  expect(JSON.parse(JSON.stringify(models))).toEqual({
    format: 1,
    published: { version: 7, fetchedAt: AT, checkedAt: AT, catalog },
  });
});

test('a damaged model catalog is not carried: v5 downloads it again', async () => {
  await mkdir(join(f.from, 'state'), { recursive: true });
  await writeFile(join(f.from, 'state/model-catalog.json'), '{"FAKE-TORN');
  const report = await loginsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.note).toBe('state/model-catalog.json is damaged: v5 downloads the catalog again');
  expect(await stat(join(f.to, V5_MODELS)).catch(() => undefined)).toBeUndefined();
});

test('a home with no logins converts to nothing', async () => {
  const report = await loginsStep.run(f.ctx());
  expect(report.status).toBe('converted');
  expect(report.sealed).toEqual([]);
  expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
});
