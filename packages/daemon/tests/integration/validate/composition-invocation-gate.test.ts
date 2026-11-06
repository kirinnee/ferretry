import { afterEach, describe, it } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';

/**
 * The composition-invocation gate, run on small throwaway repositories. The extraction of the daemon's
 * features into `bin/modules` moved the real reads of a world field out of `src/`, where the gate used to
 * look, so these pin the two outcomes that matter: a field read only by a module still passes, and a field
 * that is declared and constructed with no reader anywhere still fails.
 */

const GATE = 'scripts/validate/composition-invocation.sh';
const REPO_ROOT = join(import.meta.dir, '../../../../..');
const created: string[] = [];

type Files = Readonly<Record<string, string>>;

/** A declared + constructed field, the shape the gate reports when nothing reads it. */
const ROOT = [
  'export interface DaemonWorld {',
  '  readonly widget: Widget;',
  '}',
  'export function buildWorld(): DaemonWorld {',
  '  return {',
  '    widget: makeWidget(),',
  '  };',
  '}',
  '',
].join('\n');

const run = async (files: Files): Promise<{ readonly code: number; readonly stderr: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'composition-gate-'));
  created.push(dir);
  const all: Files = {
    'packages/daemon/package.json': JSON.stringify({ bin: { fyd: 'bin/fyd.ts' } }),
    'packages/cli/package.json': JSON.stringify({ bin: { fy: 'bin/fy.ts' } }),
    'packages/cli/bin/program.ts': 'export interface CliWorld {}\n',
    'packages/daemon/bin/fyd.ts': ROOT,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await mkdir(join(dir, 'scripts/validate'), { recursive: true });
  await cp(join(REPO_ROOT, GATE), join(dir, GATE));
  const init = Bun.spawnSync(['git', 'init', '--quiet'], { cwd: dir });
  should(init.exitCode).equal(0);
  const result = Bun.spawnSync(['bash', GATE], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode ?? -1, stderr: result.stderr.toString() };
};

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('the composition-invocation gate', () => {
  it('should pass a world field read only by a module under bin/modules', async () => {
    const result = await run({
      'packages/daemon/bin/modules/seams.ts':
        'export const seamsOf = (world: DaemonWorld) => ({ widget: world.widget });\n',
    });
    should(result.stderr).equal('');
    should(result.code).equal(0);
  });

  it('should pass a world field read only under src, as before', async () => {
    const result = await run({ 'packages/daemon/src/use.ts': 'export const use = (w: DaemonWorld) => w.widget;\n' });
    should(result.code).equal(0);
  });

  it('should fail a declared and constructed field that nothing reads anywhere', async () => {
    const result = await run({
      'packages/daemon/bin/modules/seams.ts':
        'export const seamsOf = (world: DaemonWorld) => ({ other: world.other });\n',
    });
    should(result.code).equal(1);
    should(result.stderr).containEql('DaemonWorld.widget');
  });

  it('should not count a mention in a bin/modules comment or string as a read', async () => {
    const result = await run({
      'packages/daemon/bin/modules/seams.ts': [
        '// world.widget is documented here but never read',
        "export const label = 'world.widget';",
        '',
      ].join('\n'),
    });
    should(result.code).equal(1);
    should(result.stderr).containEql('DaemonWorld.widget');
  });
});
