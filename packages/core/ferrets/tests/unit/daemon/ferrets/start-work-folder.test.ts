import { expect, test } from 'bun:test';
import { err, ok } from '@ferretry/std';
import { fenced } from '../../../../contract/testing/index.ts';
import { additivesFixture } from './additives-fixture.ts';

test('work folder: omitted, the ferret works in the folder it was started in', async () => {
  const f = additivesFixture({ empty: true });
  const started = await f.service.start({ folder: '/repo', by: 'owner' });
  expect(started.ok).toBe(true);
  expect(f.registry.get(f.id)?.folder).toBe('/repo');
  expect(f.harness.launched.at(-1)?.folder).toBe(fenced('/repo'));
});

test('work folder: given, it is the folder the ferret works in and launches in', async () => {
  const f = additivesFixture({ empty: true });
  const started = await f.service.start({ folder: '/repo', workFolder: '/warden/investigations/one', by: 'owner' });
  expect(started.ok).toBe(true);
  expect(f.registry.get(f.id)?.folder).toBe('/warden/investigations/one');
  expect(f.harness.launched.at(-1)?.folder).toBe(fenced('/warden/investigations/one'));
});

test('work folder: a path that is not canonical is refused as a folder failure and starts nothing', async () => {
  for (const workFolder of ['/a/../../etc', '/a/./b', '/a//b', '/a/b/', '/', 'relative/path', '/a/\0b']) {
    const f = additivesFixture({ empty: true });
    const refused = await f.service.start({ folder: '/repo', workFolder, by: 'owner' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe('folder');
    expect(f.registry.get(f.id)).toBeUndefined();
    expect(f.runner.starts).toBe(0);
  }
});

test('work folder: it goes through the same folder check as the folder; a refusal is a folder failure and starts nothing', async () => {
  const f = additivesFixture({ empty: true });
  f.ports.folder = path => (path.startsWith('/state') ? err('inside the daemon’s fence') : ok(fenced(path)));
  const refused = await f.service.start({ folder: '/repo', workFolder: '/state/home', by: 'owner' });
  expect(refused).toEqual({ ok: false, error: { code: 'folder', reason: 'inside the daemon’s fence' } });
  expect(f.registry.get(f.id)).toBeUndefined();
  expect(f.runner.starts).toBe(0);
});

test('work folder: the report the investigator wrote is read back through summary(ferret)', async () => {
  const f = additivesFixture({ empty: true });
  f.ports.summaryText = async () => '# verdict\nleave it';
  await f.service.start({ folder: '/repo', workFolder: '/warden/one', by: 'owner' });
  expect(await f.service.summary(f.id)).toBeUndefined(); // still working: no report yet
  await f.service.stop(f.id, 'now', 'done', { kind: 'completed' });
  expect(await f.service.summary(f.id)).toBe('# verdict\nleave it');
});
