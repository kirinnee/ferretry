import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigFiles } from '../../../host/config/service.ts';
import { createNodeHostFs } from '../../../host/state/host-fs.ts';
import { captureLog, loginsDef, manualClock, updatesDef } from '../../unit/host-config/support.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function freshFiles() {
  const home = await mkdtemp(join(tmpdir(), 'fy-kernel-config-'));
  homes.push(home);
  const make = () =>
    createConfigFiles({
      home,
      fs: createNodeHostFs(),
      clock: manualClock(),
      log: captureLog(),
      binary: 'fy',
      defs: [
        { plugin: 'updates', def: updatesDef },
        { plugin: 'logins', def: loginsDef },
      ],
    });
  return { home, files: make(), restart: make };
}

describe('config files on a real disk', () => {
  test('a write is atomic and private, a held loosening survives a restart, and a patch keeps the owner comments', async () => {
    const { home, files, restart } = await freshFiles();
    await files.write('updates', updatesDef, undefined, '# the owner wrote this\nlimit: 5 # keep it small\n');
    const path = join(home, 'config', 'updates.yaml');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const held = await files.write('updates', updatesDef, undefined, { patch: { limit: 50 } });
    expect(held.kind).toBe('held');
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# the owner wrote this');
    expect(text).toContain('limit: 50 # keep it small');

    const again = restart();
    await again.reload();
    expect((again.port('updates').file(updatesDef) as { limit: number }).limit).toBe(5);
    expect(again.held()).toHaveLength(1);
    if (held.kind === 'held') expect(await again.confirm(held.id)).toBe(true);
    expect((again.port('updates').file(updatesDef) as { limit: number }).limit).toBe(50);
  });

  test('a link planted in the config folder is never followed: it is not read and the last good version stays', async () => {
    const { home, files } = await freshFiles();
    await files.write('logins', loginsDef, 'work', 'model: a\n');
    const target = join(home, 'elsewhere.yaml');
    await writeFile(target, 'model: stolen\n');
    await rm(join(home, 'config', 'logins', 'work.yaml'));
    await symlink(target, join(home, 'config', 'logins', 'work.yaml'));
    await files.reload();
    const map = files.port('logins').collection(loginsDef) as ReadonlyMap<string, { model: string }>;
    expect(map.get('work')?.model).toBe('a');
    expect(files.status().issues[0]?.message).toContain('not read');
  });
});
