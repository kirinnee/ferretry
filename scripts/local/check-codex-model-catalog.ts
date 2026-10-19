#!/usr/bin/env bun
/**
 * Prove the installed Codex loads the model catalog files Ferretry writes, and lists exactly their models.
 *
 *   bun scripts/local/check-codex-model-catalog.ts [--codex <path-to-codex>]...
 *
 * For every built-in model catalog Ferretry hands to Codex's own picker (each catalog with Codex models
 * except those of models Codex ships), it renders the file a runtime would be launched with and asks each
 * Codex `debug models -c model_catalog_json=<file>` on a throwaway Codex home — no account, no network.
 * It fails when Codex cannot parse the file (Codex then refuses to start, which is the failure this guards
 * against after a Codex bump) or lists anything other than the catalog's models, in the order a runtime
 * launches them in (its default first),
 * with the catalog's reasoning levels.
 *
 * Run it after bumping Codex or changing `packages/fleet/src/lib/models/codex-catalog.ts`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtInModelCatalogs } from '../../packages/fleet/src/lib/models/catalog.ts';
import { codexCatalogModels, renderCodexModelCatalog } from '../../packages/fleet/src/lib/models/codex-catalog.ts';
import { runtimeModels } from '../../packages/fleet/src/lib/models/runtime.ts';

interface ListedModel {
  readonly slug: string;
  readonly display_name: string;
  readonly supported_reasoning_levels: readonly { readonly effort: string }[];
}

const codexes = Bun.argv.flatMap((argument, index) => (argument === '--codex' ? [Bun.argv[index + 1] ?? ''] : []));
if (codexes.length === 0) codexes.push('codex');

const scratch = await mkdtemp(join(tmpdir(), 'fy-codex-catalog-'));
const failures: string[] = [];
try {
  for (const [id, catalog] of Object.entries(builtInModelCatalogs())) {
    const derived = runtimeModels({ harness: 'codex', modelSet: undefined, catalog });
    const offered = codexCatalogModels(derived);
    if (offered === undefined) continue;
    const models = [
      ...offered.filter(model => model.id === derived.default),
      ...offered.filter(model => model.id !== derived.default),
    ];
    const file = join(scratch, `${id}.json`);
    await writeFile(file, renderCodexModelCatalog(offered, derived.default));
    for (const codex of codexes) {
      const child = Bun.spawn([codex, 'debug', 'models', '-c', `model_catalog_json=${JSON.stringify(file)}`], {
        env: { PATH: Bun.env.PATH ?? '', HOME: scratch, CODEX_HOME: scratch },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const label = `${id} on ${codex}`;
      if ((await child.exited) !== 0) {
        failures.push(`${label}: Codex refused the file: ${err.trim().split('\n').at(-1) ?? ''}`);
        continue;
      }
      const listed = (JSON.parse(out) as { models: ListedModel[] }).models;
      const want = models.map(model => `${model.id}|${model.label}|${model.efforts.join('/')}`);
      const got = listed.map(
        model =>
          `${model.slug}|${model.display_name}|${model.supported_reasoning_levels.map(level => level.effort).join('/')}`,
      );
      if (JSON.stringify(want) === JSON.stringify(got)) console.log(`ok   ${label}: ${models.length} models`);
      else failures.push(`${label}: wanted ${JSON.stringify(want)}, Codex lists ${JSON.stringify(got)}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

for (const failure of failures) console.error(`FAIL ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
