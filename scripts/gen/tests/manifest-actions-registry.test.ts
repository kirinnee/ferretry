/**
 * A package's `manifest/actions/*.actions.ts` fragments are merged into `manifest/generated/actions.ts`. The four lists a
 * manifest has always merged are always there; every other section (`memberRoutes`, `app`, and the `ui`, `hooks` and `data`
 * lists) is emitted only when a fragment names it, so a package that never uses one keeps exactly the manifest it had.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type Fixture, fixture, skeletonHalf } from './fixture.ts';
import { buildModel, manifestRegistries } from '../registries.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});
const path = 'packages/plugins/alpha/manifest/generated/actions.ts';

const generated = async (files: Record<string, string>): Promise<string> => {
  const f = fixture(
    [
      { id: 'alpha', daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli'), files },
      { id: 'beta', daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli') },
    ],
    {},
  );
  made.push(f);
  return manifestRegistries((await buildModel(f.root, false)).ws).get(path) ?? '';
};

describe('manifest actions registry', () => {
  test('a package of routes-only fragments emits the four lists it always did, and nothing else', async () => {
    const text = await generated({
      'manifest/actions/20-b.actions.ts': 'export default { routes: [], sockets: [], agentTools: [], cli: [] };\n',
      'manifest/actions/10-a.actions.ts': 'export default { routes: [], sockets: [], agentTools: [], cli: [] };\n',
    });
    expect(text).toContain(
      'export default {\n  routes: [\n    ...actions_10_a.routes,\n    ...actions_20_b.routes,\n  ] as const,',
    );
    for (const kind of ['sockets', 'agentTools', 'cli']) expect(text).toContain(`  ${kind}: [\n`);
    expect(text).not.toMatch(/memberRoutes|app:|export const (ui|hooks|data)/);
  });

  test('a section a fragment names is merged, in file-name order, one entry per line', async () => {
    const text = await generated({
      'manifest/actions/10-a.actions.ts':
        'export default manifestFragment({ ui: { panels: [], screens: [] }, hooks: { offers: [] } });\n',
      'manifest/actions/20-b.actions.ts':
        'export default manifestFragment({ app: [], data: { publishes: [] }, ui: { panels: [] } });\n',
    });
    expect(text).toContain('  app: [\n    ...actions_10_a.app,\n    ...actions_20_b.app,\n  ] as const,');
    expect(text).toContain(
      'export const ui = {\n  screens: [\n    ...actions_10_a.ui.screens,\n    ...actions_20_b.ui.screens,\n  ] as const,\n  panels: [\n    ...actions_10_a.ui.panels,\n    ...actions_20_b.ui.panels,\n  ] as const,\n} as const;',
    );
    expect(text).toContain('export const hooks = {\n  offers: [\n');
    expect(text).toContain('export const data = {\n  publishes: [\n');
    expect(text).not.toMatch(/memberRoutes|settings|takes|subscribes|themes/);
  });

  test('a section named only in a comment is not emitted', async () => {
    const text = await generated({
      'manifest/actions/10-a.actions.ts':
        '// the panels and the app live elsewhere\n/** memberRoutes: none, hooks: none */\nexport default { routes: [] };\n',
    });
    expect(text).not.toMatch(/memberRoutes|app:|export const (ui|hooks|data)/);
  });
});
