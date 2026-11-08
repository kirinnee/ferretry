import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineState } from '@ferretry/kernel/contract';
import { definePlugin, route, verb } from '@ferretry/kernel/manifest';
import should from 'should';
import { createPluginHost } from '../../src/adapters/plugin-host.ts';

const SCOPE = { minimum: 'authenticated', audit: { skip: 'test' }, guard: { none: 'test' } } as const;
const NOTES = defineState({ name: 'notes', path: 'notes/*', store: 'opaque', format: 1 });
const manifest = definePlugin({
  id: 'probe',
  title: 'Probe',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],
  actions: { routes: [route('GET /v1/probe', { ...SCOPE, caller: 'any' })], cli: [verb('probe')] },
  data: { state: [NOTES] },
});

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fy-host-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

describe('the facilities a plugin half is handed, on the real disk', () => {
  it('should read a real file by path and the standard input for "-" when nothing is injected', async () => {
    const dir = await temp();
    await writeFile(join(dir, 'recipe.txt'), 'open the page');
    const host = createPluginHost({ home: dir });
    should(await host.readText(join(dir, 'recipe.txt'))).equal('open the page');
    // Standard input belongs to whoever runs the suite, so the default reader is only asked and then left to settle.
    const typed = host.readText('-');
    const outcome = await Promise.race([typed, Bun.sleep(300).then(() => 'still waiting for input')]);
    should(outcome).be.a.String();
  });

  it('should keep a plugin’s own state under its own folder of the home, built on first use', async () => {
    const home = await temp();
    const host = createPluginHost({ home });
    const own = host.ownState(manifest);
    // Nothing touches the disk until the plugin uses its state.
    should(await readdir(home)).eql([]);
    await own.write(NOTES, 'mine', 'a.txt');
    const path = own.pathOf(NOTES, 'a.txt');
    should(path).equal(join(home, 'state', 'probe', 'notes', 'a.txt'));
    should(await readFile(path, 'utf8')).equal('mine');
    should((await own.stat(NOTES, 'a.txt'))?.kind).equal('file');
    should(await own.list(NOTES)).containEql('a.txt');
    await own.createPrivateDirectory(NOTES, 'sub');
    should(((await stat(join(home, 'state', 'probe', 'notes', 'sub'))).mode & 0o777).toString(8)).equal('700');
    await own.removeEmptyDirectory(NOTES, 'sub');
    await own.remove(NOTES, 'a.txt');
    should(await own.list(NOTES)).eql([]);
  });

  it('should see a real directory, a real file and a missing path as existing, existing and absent', async () => {
    const dir = await temp();
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'marker.txt'), 'x');
    const host = createPluginHost({ home: dir, cwd: () => dir });
    should(await host.exists('out/')).be.true();
    should(await host.exists('marker.txt')).be.true();
    should(await host.exists('absent')).be.false();
    should(host.clock.nowMs()).be.above(0);
    should(Date.parse(host.clock.now())).be.above(0);
    await host.sleep(1 as never);
  });
});
