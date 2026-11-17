/**
 * A manifest `instructions` entry whose `text` file is not on disk used to pass generation: `instructions.ts` was written
 * with an import of a file that is not there, and the break showed up later, in whatever bundled the kernel. Generation
 * and `--check` (`registries-fresh`) now fail and name the plugin, the id and the path.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Fixture, fixture } from './fixture.ts';
import { buildModel, missingInstructionTexts } from '../registries.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});

const instructions = (...entries: readonly string[]): string => `instructions: [${entries.join(', ')}],`;
const entry = (id: string, text: string): string => `{ id: '${id}', text: '${text}' }`;

function world(files: Record<string, string>, ...entries: readonly string[]): Fixture {
  const f = fixture([{ id: 'alpha', manifest: instructions(...entries), files }]);
  made.push(f);
  return f;
}

const SCRIPT = join(import.meta.dir, '..', 'registries.ts');
const run = (root: string, ...flags: readonly string[]) => {
  const done = Bun.spawnSync(['bun', SCRIPT, '--root', root, ...flags], { stderr: 'pipe', stdout: 'pipe' });
  return { code: done.exitCode, err: done.stderr.toString() };
};

describe('a manifest instruction whose text file does not exist', () => {
  test('is named by plugin, id and path, and an existing file is not', async () => {
    const f = world(
      { 'instructions/here.md': 'words\n' },
      entry('here', 'instructions/here.md'),
      entry('gone', 'instructions/gone.md'),
    );
    expect(missingInstructionTexts(await buildModel(f.root, false))).toEqual([
      'plugin "alpha" declares instruction "gone" with text "instructions/gone.md", but packages/plugins/alpha/instructions/gone.md does not exist',
    ]);
  });

  test('a workspace whose instruction files all exist reports nothing', async () => {
    const f = world({ 'instructions/here.md': 'words\n' }, entry('here', 'instructions/here.md'));
    expect(missingInstructionTexts(await buildModel(f.root, false))).toEqual([]);
  });

  test('fails generation, writes no instructions.ts, and says which plugin, id and path', () => {
    const f = world({}, entry('gone', 'instructions/gone.md'));
    const done = run(f.root);
    expect(done.code).toBe(1);
    expect(done.err).toContain('plugin "alpha" declares instruction "gone"');
    expect(done.err).toContain('packages/plugins/alpha/instructions/gone.md does not exist');
    expect(existsSync(join(f.root, 'packages/core/kernel/src/generated/instructions.ts'))).toBe(false);
  });

  test('fails --check (registries-fresh) the same way', () => {
    const f = world({}, entry('gone', 'instructions/gone.md'));
    const done = run(f.root, '--check');
    expect(done.code).toBe(1);
    expect(done.err).toContain('missing-instruction: plugin "alpha" declares instruction "gone"');
  });

  test('a present file generates and checks clean of the missing-instruction failure', () => {
    const f = world({ 'instructions/here.md': 'words\n' }, entry('here', 'instructions/here.md'));
    expect(run(f.root).err).not.toContain('missing-instruction');
    expect(run(f.root, '--check').err).not.toContain('missing-instruction');
  });
});
