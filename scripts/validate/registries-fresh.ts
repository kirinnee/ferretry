/**
 * `registries-fresh` (§7.9): a generated file on disk differs from a fresh generation. A missing file is not stale
 * (generated files are git-ignored and written by install, build, test and typecheck).
 */
import { type Check, runMain } from '../gen/lib/check.ts';
import { generateGlobal, staleFiles } from '../gen/registries.ts';

export const check: Check = {
  name: 'registries-fresh',
  summary: 'generated registries match a fresh generation',
  async run(ctx) {
    const model = await ctx.model();
    return staleFiles(model.ws.root, generateGlobal(model), false).map(rel => ({
      check: 'registries-fresh',
      where: rel,
      message: 'differs from a fresh generation; run `bun scripts/gen/registries.ts`',
    }));
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
