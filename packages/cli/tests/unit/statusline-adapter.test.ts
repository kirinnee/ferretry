import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { createStatuslinePorts, passiveUsagePath } from '../../src/adapters/statusline/index.ts';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

describe('the statusline ports over the real disk', () => {
  it('should write the passive usage file atomically, 0600, where the logins daemon reads it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fy-statusline-'));
    made.push(home);
    const ports = createStatuslinePorts(home);
    const record = { version: 1, source: 'claude-statusline', at: 5, weekly: { usedPercent: 3 } } as const;

    await ports.writeUsage('claude-main', record);

    const path = passiveUsagePath(home, 'claude-main');
    should(path).equal(join(home, 'state', 'logins', 'credentials', 'claude-main', 'usage.json'));
    should(JSON.parse(await readFile(path, 'utf8'))).eql(record);
    should((await stat(path)).mode & 0o777).equal(0o600);
    const directory = join(home, 'state', 'logins', 'credentials', 'claude-main');
    should((await stat(directory)).mode & 0o777).equal(0o700);
    should(await readdir(directory)).eql(['usage.json']);
    should(await readdir(home)).eql(['state']);
  });

  it('should never turn an id that is not one plain name into a path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fy-statusline-'));
    made.push(home);

    await createStatuslinePorts(home).writeUsage('../../escape', { version: 1, source: 'claude-statusline', at: 1 });

    should(await readdir(home)).eql([]);
  });

  it('should run the own command with the same stdin and answer its exit code', async () => {
    const code = await createStatuslinePorts('/unused').chain('cat >/dev/null; exit 7', '{"a":1}');

    should(code).equal(7);
  });
});
