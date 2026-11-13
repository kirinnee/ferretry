/** `core-closed` (§7.9): a core manifest needs, uses or takes a hook from a plugin. */
import { type Check, runMain } from '../gen/lib/check.ts';
import { coreClosedFindings } from '../gen/lib/graph.ts';

export const check: Check = {
  name: 'core-closed',
  summary: 'the core depends on nothing a plugin provides',
  async run(ctx) {
    return coreClosedFindings((await ctx.model()).graph);
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
