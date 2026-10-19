/**
 * The published model catalog (docs/model-catalog.md § Live updates): writes the built-in catalogs into
 * the hosted app's `dist/catalog/`, so every paired daemon can follow a model list without a release.
 * Runs after `vite build` and BEFORE `build-release.ts`, so both files are in the signed release list
 * and a daemon checks `catalog/models.json` against that signature.
 *
 *   [MODEL_CATALOG_VERSION=<n>] bun run scripts/build-model-catalog.ts [distDirectory]
 *
 * THE VERSION is the number of commits that changed `packages/fleet/models/` — it moves exactly when a
 * catalog does, so a daemon downloads nothing when only the app changed. It needs the history, so the
 * Pages build checks out with `fetch-depth: 0` and sets `MODEL_CATALOG_REQUIRE_HISTORY=1`, which turns
 * a shallow checkout into a failed build instead of a catalog stuck at one version. Anywhere else a
 * shallow checkout publishes version 0, which no deployed catalog equals.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { builtInModelCatalogs, publishedModelCatalogFiles } from '@ferretry/fleet';

const packageRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const distDirectory = resolve(process.argv[2] ?? join(packageRoot, 'dist'));

const git = (...args: string[]): string | undefined => {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

/** The version this build publishes: the override, else the catalog directory's commit count. */
function catalogVersion(): number {
  const given = process.env.MODEL_CATALOG_VERSION;
  if (given !== undefined && given !== '') {
    const version = Number(given);
    if (!Number.isInteger(version) || version < 0) throw new Error(`❌ MODEL_CATALOG_VERSION=${given} is not a count`);
    return version;
  }
  if (git('rev-parse', '--is-shallow-repository') !== 'false') {
    if (process.env.MODEL_CATALOG_REQUIRE_HISTORY === '1')
      throw new Error('❌ the model catalog version needs the full history: check out with fetch-depth: 0');
    return 0;
  }
  return Number(git('rev-list', '--count', 'HEAD', '--', 'packages/fleet/models') ?? '0');
}

const version = catalogVersion();
for (const [path, text] of Object.entries(publishedModelCatalogFiles(version, builtInModelCatalogs()))) {
  const target = join(distDirectory, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
}
process.stdout.write(`✅ model catalog version ${version} written to ${join(distDirectory, 'catalog')}\n`);
