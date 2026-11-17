/**
 * A package's `daemon/features/*.feature.ts` files are listed into `daemon/generated/features.ts` by the generator, so a
 * feature is added by adding a file and no list is edited. These tests pin the rule: every feature file is listed in file
 * order, a helper in the same folder is not, and a package with no feature folder gets no registry.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { type Fixture, fixture, skeletonHalf } from './fixture.ts';
import { buildModel, featureRegistries, featureRegistryPath, staleFiles } from '../registries.ts';

const made: Fixture[] = [];
afterAll(() => {
  for (const f of made) f.dispose();
});
const feature = 'export default { id: "x", register: () => undefined };\n';
const path = featureRegistryPath('packages/plugins/alpha');

const ws = (files: Record<string, string>): Fixture => {
  const f = fixture(
    [
      { id: 'alpha', daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli'), files },
      { id: 'beta', daemon: skeletonHalf('Daemon'), app: skeletonHalf('App'), cli: skeletonHalf('Cli') },
    ],
    {},
  );
  made.push(f);
  return f;
};
const generated = async (f: Fixture): Promise<ReadonlyMap<string, string>> =>
  featureRegistries(await buildModel(f.root, false));

describe('feature registry', () => {
  test('lists every *.feature.ts of the folder by file name, and nothing else', async () => {
    const f = ws({
      'daemon/features/zeta.feature.ts': feature,
      'daemon/features/alpha-one.feature.ts': feature,
      'daemon/features/types.ts': 'export type T = 1;\n',
    });
    const text = (await generated(f)).get(path);
    expect(text).toBeDefined();
    const imports = [...(text ?? '').matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports).toEqual(['../features/alpha-one.feature.ts', '../features/zeta.feature.ts']);
    expect(text).toContain('export default [\n  feature_alpha_one,\n  feature_zeta,\n] as const;');
  });

  test('a package with no feature file gets no registry', async () => {
    const f = ws({ 'daemon/features/types.ts': 'export type T = 1;\n' });
    expect([...(await generated(f)).keys()]).toEqual([]);
  });

  test('a new feature file changes the registry, and regenerating lists it with no list edited', async () => {
    const f = ws({ 'daemon/features/one.feature.ts': feature });
    const before = await generated(f);
    expect(staleFiles(f.root, before, true)).toEqual([`${path} (missing)`]);
    f.write('packages/plugins/alpha/daemon/features/two.feature.ts', feature);
    const after = await generated(f);
    expect(after.get(path)).toContain('two.feature.ts');
    expect(after.get(path)).not.toBe(before.get(path));
  });
});

describe('feature registry: a feature in its own folder', () => {
  test('lists <f>/<f>.feature.ts beside the flat files, by path, and skips any other file in a subfolder', async () => {
    const f = ws({
      'daemon/features/alpha.feature.ts': feature,
      'daemon/features/queue/queue.feature.ts': feature,
      'daemon/features/queue/helper.feature.ts': feature,
      'daemon/features/queue/parts.ts': 'export const parts = 1;\n',
      'daemon/features/zeta.feature.ts': feature,
    });
    const text = (await generated(f)).get(path) ?? '';
    const imports = [...text.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports).toEqual([
      '../features/alpha.feature.ts',
      '../features/queue/queue.feature.ts',
      '../features/zeta.feature.ts',
    ]);
    expect(text).toContain('  feature_alpha,\n  feature_queue_queue,\n  feature_zeta,\n');
  });

  test('a package whose only feature is in its own folder still gets a registry', async () => {
    const f = ws({ 'daemon/features/queue/queue.feature.ts': feature });
    expect((await generated(f)).get(path)).toContain('../features/queue/queue.feature.ts');
  });
});
