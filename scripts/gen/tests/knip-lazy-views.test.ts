/**
 * Production knip must reach every file a plugin's app half loads lazily.
 *
 * A plugin's `app/index.ts` loads its React views through a dynamic `import(`./views/${name}.tsx`)` (a Vite
 * dynamic-import variable, so the registry generator never loads React). Knip cannot follow a template specifier, so
 * the workspace's `entry` in `knip.production.json` must name those files, or the whole view tree reads as dead.
 *
 * The entries are per workspace (a single `app/views/*.tsx` on the `packages/plugins/*` block would raise a "no
 * matches" config hint for every plugin without the folder). This test is what stops a plugin added later from
 * silently missing its entry: the plugins to check are DERIVED from each `app/index.ts`, never listed by hand.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..', '..');
const pluginsDir = join(root, 'packages', 'plugins');
const WILDCARD = 'packages/plugins/*';

type KnipWorkspace = { readonly entry?: readonly string[] };
type KnipConfig = { readonly workspaces: Record<string, KnipWorkspace> };

const scan = async (pattern: string, cwd: string): Promise<string[]> => {
  const found: string[] = [];
  for await (const file of new Bun.Glob(pattern).scan({ cwd })) found.push(file);
  return found.sort();
};

/** `import(`./views/${name}.tsx`)` → `views/*.tsx`; `import(`./${'surfaces'}.tsx`)` → `surfaces.tsx`. */
const lazyGlobs = (indexSource: string): string[] =>
  [...indexSource.matchAll(/import\(\s*`\.\/([^`]+)`\s*\)/g)].map(match =>
    (match[1] ?? '').replace(/\$\{\s*'([^']*)'\s*\}/g, '$1').replace(/\$\{[^}]*\}/g, '*'),
  );

/** What knip uses for a plugin folder: its own workspace block, else the `packages/plugins/*` one (no merging). */
const entriesFor = (config: KnipConfig, plugin: string): readonly string[] =>
  (config.workspaces[`packages/plugins/${plugin}`] ?? config.workspaces[WILDCARD])?.entry ?? [];

const config = (await Bun.file(join(root, 'knip.production.json')).json()) as KnipConfig;
const plugins = (await scan('*/app/index.ts', pluginsDir)).map(file => file.split('/')[0] ?? '');

describe('production knip: lazy-loaded plugin views', () => {
  test('the plugin list is derived from the tree and is not empty', () => {
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins).toContain('agenda');
  });

  for (const plugin of plugins) {
    test(`${plugin}: every file its app/index.ts lazy-loads is a knip entry, and no test fixture is`, async () => {
      const appDir = join(pluginsDir, plugin, 'app');
      const lazy = lazyGlobs(await Bun.file(join(appDir, 'index.ts')).text());
      const pluginDir = join(pluginsDir, plugin);
      const reached = new Set<string>();
      for (const entry of entriesFor(config, plugin))
        for (const file of await scan(entry, pluginDir)) reached.add(file);

      for (const glob of lazy) {
        const loaded = await scan(glob, appDir);
        // A lazy import that resolves to nothing is itself a bug: the view would 404 at runtime.
        expect(loaded.length, `${plugin}: import(\`./${glob}\`) matches no file`).toBeGreaterThan(0);
        for (const file of loaded) {
          expect(reached.has(`app/${file}`), `${plugin}: app/${file} is lazy-loaded but is not a knip entry`).toBe(
            true,
          );
        }
      }
      expect([...reached].some(file => file.startsWith('tests/'))).toBe(false);
    });
  }

  test('at least the Agenda views every surface needs are reached', async () => {
    const pluginDir = join(pluginsDir, 'agenda');
    const reached = new Set<string>();
    for (const entry of entriesFor(config, 'agenda'))
      for (const file of await scan(entry, pluginDir)) reached.add(file);
    for (const name of ['surfaces']) expect(reached.has(`app/views/${name}.tsx`)).toBe(true);
  });
});
