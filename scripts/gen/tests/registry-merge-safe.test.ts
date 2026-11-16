/**
 * Every registry the generator writes takes two independent one-line adds without a conflict ("A registry is merge-safe by
 * construction", point 5). For each one the test builds the registry four times from real fixture workspaces (the base, with
 * entry X, with entry Y, with both), then hands the four texts to the shared helper (`merge-safe.ts`), which proves in a temp
 * git repository that `git merge` (both ways) and `git rebase` are clean and give the generator's own text for both entries.
 *
 * The entries are placed apart (X after the first of six names, Y after the third), as two features added by two people are:
 * two adds that touch the SAME line are the one case a plain merge cannot take, and the pure-list files that use
 * `merge=union` for it are proved in the last `describe` below.
 *
 * `generated/contract-hashes.json` and `generated/hooks.md` are not tested: the first is JSON (its last entry cannot end in a
 * comma) and the second is a document the generator renders, and neither is a list a feature adds a line to by hand.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Fixture, type FixturePackage, fixture, skeletonHalf } from './fixture.ts';
import { assertMergeSafe, type RegistryFiles, runTwoAdds } from './merge-safe.ts';
import { buildModel, contractRegistries, generateGlobal } from '../registries.ts';
import { loadWorkspace } from '../lib/workspace.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});

const KERNEL: FixturePackage = { id: 'kernel', core: true, halves: false };
const HOME = 'packages/plugins/alpha';
const halves = { daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli') } as const;

/** Six names in order; X (`c`) lands after the first and Y (`i`) after the third, so no two adds touch the same line. */
const BASE = ['b', 'd', 'f', 'h', 'j', 'l'] as const;
const withEntry = (extra: readonly string[]): readonly string[] => [...BASE, ...extra].sort();
const X = 'c';
const Y = 'i';

/** The whole generated registry of a fixture: the global files plus Ferrets-style contract barrels on `alpha`. */
async function generate(
  packages: readonly FixturePackage[],
  extra: Readonly<Record<string, string>> = {},
): Promise<ReadonlyMap<string, string>> {
  const f = fixture([KERNEL, ...packages]);
  made.push(f);
  for (const [rel, text] of Object.entries(extra)) f.write(rel, text);
  const model = await buildModel(f.root, false);
  return new Map([...generateGlobal(model), ...contractRegistries(loadWorkspace(f.root), HOME)]);
}

/** The four registries (base, X, Y, both) of one world, narrowed to `paths`. */
async function fourWays(
  world: (names: readonly string[]) => Promise<ReadonlyMap<string, string>>,
  paths: readonly string[],
): Promise<Parameters<typeof assertMergeSafe>[0]> {
  const pick = (all: ReadonlyMap<string, string>): RegistryFiles =>
    Object.fromEntries(
      paths.map(path => {
        const text = all.get(path);
        if (text === undefined)
          throw new Error(`the generator wrote no ${path}; it wrote ${[...all.keys()].join(', ')}`);
        return [path, text];
      }),
    );
  return {
    base: pick(await world(withEntry([]))),
    a: pick(await world(withEntry([X]))),
    b: pick(await world(withEntry([Y]))),
    both: pick(await world(withEntry([X, Y]))),
  };
}

/** A folder of files one package owns; the entries are `<name><suffix>`. */
const folderWorld =
  (folder: string, suffix: string, body: (name: string) => string, extraFiles: Readonly<Record<string, string>> = {}) =>
  (names: readonly string[]) =>
    generate([
      {
        id: 'alpha',
        ...halves,
        files: { ...extraFiles, ...Object.fromEntries(names.map(name => [`${folder}/${name}${suffix}`, body(name)])) },
      },
    ]);

describe('a folder registry takes two independent adds (features, verbs, manifest fragments, port slices, contract barrels)', () => {
  test('daemon/generated/features.ts', async () => {
    assertMergeSafe(
      await fourWays(
        folderWorld('daemon/features', '.feature.ts', () => 'export default { id: "x" };\n'),
        [`${HOME}/daemon/generated/features.ts`],
      ),
    );
  });

  test('cli/generated/verbs.ts', async () => {
    assertMergeSafe(
      await fourWays(
        folderWorld('cli/verbs', '.verb.ts', () => 'export default [];\n'),
        [`${HOME}/cli/generated/verbs.ts`],
      ),
    );
  });

  test('manifest/generated/actions.ts', async () => {
    assertMergeSafe(
      await fourWays(
        folderWorld('manifest/actions', '.actions.ts', () => 'export default { routes: [] };\n'),
        [`${HOME}/manifest/generated/actions.ts`],
      ),
    );
  });

  test('contract/generated/ferrets-api.ts (one `extends` line per port slice)', async () => {
    assertMergeSafe(
      await fourWays(
        folderWorld('contract/ports', '.port.ts', name => `export interface ${name}Api {}\n`),
        [`${HOME}/contract/generated/ferrets-api.ts`],
      ),
    );
  });

  test('contract/generated/{hooks,kinds}.ts (pure barrels of `export *`)', async () => {
    for (const folder of ['hooks', 'kinds'])
      assertMergeSafe(
        await fourWays(
          folderWorld(`contract/${folder}`, '.ts', name => `export const ${name} = 1;\n`),
          [`${HOME}/contract/generated/${folder}.ts`],
        ),
      );
  });

  test('contract/generated/slots.ts (the account slots, then one line per `*.slot.ts`)', async () => {
    assertMergeSafe(
      await fourWays(
        folderWorld('contract/slots', '.slot.ts', () => 'export default { slot: "s" } as const;\n', {
          'contract/slots/account-slots.ts': 'export const FERRET_ACCOUNT_SLOTS = ["a"] as const;\n',
        }),
        [`${HOME}/contract/generated/slots.ts`],
      ),
    );
  });

  test('contract/generated/app-hooks.ts (one record line per hook)', async () => {
    assertMergeSafe(
      await fourWays(
        folderWorld('contract/app-hooks', '.app-hook.ts', () => 'export default { name: "x", narrow: () => true };\n'),
        [`${HOME}/contract/generated/app-hooks.ts`],
      ),
    );
  });
});

/** Plugins in the graph: `kernel`, `mcp` and `runtimes` (what the slim entry needs) and the named ones, with every half. */
const pluginWorld = (names: readonly string[]) =>
  generate(
    [
      ...names.map(id => ({
        id,
        ...halves,
        manifest: `  words: [{ word: '${id}-word', means: 'a thing' }],`,
        files: { 'app/styles.css': `/* ${id} */\n` },
      })),
      { id: 'mcp', ...halves, files: { 'cli/serve.ts': 'export const serveTools = () => undefined;\n' } },
      {
        id: 'runtimes',
        ...halves,
        files: {
          'contract/tools-server.ts':
            'export const TOOLS_SERVER_INSTRUCTIONS = "";\nexport const CHANNEL_LAUNCH_ENV = "";\n',
        },
      },
    ],
    { 'packages/cli/bin/mcp-serve.ts': 'export {};\n' },
  );

describe('a registry of plugins takes two independent adds (start order, glossary, stylesheets)', () => {
  const files = (path: string) => fourWays(pluginWorld, [path]);

  test('kernel generated/plugins.ts (daemon halves, start order, contract hashes)', async () => {
    assertMergeSafe(await files('packages/core/kernel/src/generated/plugins.ts'));
  });

  test('cli generated/commands.ts', async () => {
    assertMergeSafe(await files('packages/cli/src/generated/commands.ts'));
  });

  test('cli generated/slim.ts (tool door facts)', async () => {
    assertMergeSafe(await files('packages/cli/src/generated/slim.ts'));
  });

  test('app generated/surfaces.ts', async () => {
    assertMergeSafe(await files('packages/app/src/generated/surfaces.ts'));
  });

  test('app generated/plugin-styles.css', async () => {
    assertMergeSafe(await files('packages/app/src/generated/plugin-styles.css'));
  });

  test('kernel generated/glossary.ts (one line per word)', async () => {
    assertMergeSafe(await files('packages/core/kernel/src/generated/glossary.ts'));
  });
});

/** The repository's own `.gitattributes`: the files it marks `merge=union`. */
const ATTRIBUTES = readFileSync(join(import.meta.dir, '..', '..', '..', '.gitattributes'), 'utf8');
const unionFiles = ATTRIBUTES.split('\n')
  .filter(line => !line.startsWith('#') && /\smerge=union$/u.test(line))
  .map(line => line.split(/\s+/u)[0] ?? '');

/** What a line of a pure entry list may be: the fixed header, a doc comment, a blank, or one entry. */
const PURE_LINES: Readonly<Record<string, RegExp>> = {
  hooks: /^(\/\/ Generated by .*|export \* from '[^']+';|)$/u,
  kinds: /^(\/\/ Generated by .*|export \* from '[^']+';|)$/u,
  'ferrets-api':
    /^(\/\/ Generated by .*|\/\*\*.*\*\/|import type \{ \w+ \} from '[^']+';|export type \* from '[^']+';|export interface FerretsApi extends \w+ \{\}|)$/u,
};

describe('merge=union is only for pure entry lists', () => {
  test('exactly these files are marked, and each is nothing but a fixed header and one entry per line', async () => {
    expect(unionFiles).toEqual([
      'packages/core/ferrets/contract/generated/hooks.ts',
      'packages/core/ferrets/contract/generated/kinds.ts',
      'packages/core/ferrets/contract/generated/ferrets-api.ts',
    ]);
    for (const path of unionFiles) {
      const name = path.replace(/^.*\//u, '').replace(/\.ts$/u, '');
      const world =
        name === 'ferrets-api'
          ? folderWorld('contract/ports', '.port.ts', n => `export interface ${n}Api {}\n`)
          : folderWorld(`contract/${name}`, '.ts', n => `export const ${n} = 1;\n`);
      const text = (await world(withEntry([X, Y]))).get(path.replace('packages/core/ferrets', HOME)) ?? '';
      expect(text).not.toBe('');
      for (const line of text.split('\n'))
        expect({ path, line, pure: PURE_LINES[name]?.test(line) }).toEqual({ path, line, pure: true });
    }
  });

  test('control: without the attribute two adds in the SAME gap conflict, with it both lines are kept', async () => {
    const adjacent = async (extra: readonly string[]) => {
      const all = await folderWorld(
        'contract/hooks',
        '.ts',
        n => `export const ${n} = 1;\n`,
      )([...BASE, ...extra].sort());
      return { [`${HOME}/contract/generated/hooks.ts`]: all.get(`${HOME}/contract/generated/hooks.ts`) ?? '' };
    };
    // 'c' and 'cc' both sort between 'b' and 'd': two adds on the same line.
    const spec = {
      base: await adjacent([]),
      a: await adjacent(['c']),
      b: await adjacent(['cc']),
      both: await adjacent(['c', 'cc']),
    };
    const plain = runTwoAdds(spec);
    expect([plain.mergeAB.ok, plain.mergeBA.ok, plain.rebase.ok]).toEqual([false, false, false]);
    const unioned = runTwoAdds({ ...spec, attributes: `${HOME}/contract/generated/hooks.ts merge=union\n` });
    for (const result of [unioned.mergeAB, unioned.mergeBA, unioned.rebase]) {
      expect(result.ok).toBe(true);
      const text = Object.values(result.files)[0] ?? '';
      expect(text).toContain("from '../hooks/c.ts';");
      expect(text).toContain("from '../hooks/cc.ts';");
    }
  });

  test('control: the old one-line list shape is the conflict this prevents', () => {
    const list = (names: readonly string[]): RegistryFiles => ({
      'list.ts': `export default [${names.join(', ')}] as const;\n`,
    });
    const result = runTwoAdds({
      base: list(['b', 'd', 'f', 'h']),
      a: list(['b', 'c', 'd', 'f', 'h']),
      b: list(['b', 'd', 'f', 'g', 'h']),
      both: list(['b', 'c', 'd', 'f', 'g', 'h']),
    });
    expect([result.mergeAB.ok, result.mergeBA.ok, result.rebase.ok]).toEqual([false, false, false]);
  });
});
