/**
 * `plugin-graph` (§7.9): the start-order graph (needs + taken hooks) has a cycle; a required provider is missing; a
 * kernel-bound port has zero or two providers; a security-path hook is taken by a plugin not on its list; two takers
 * of one provide key.
 */
import { type Check, runMain } from '../gen/lib/check.ts';
import { pluginGraphFindings } from '../gen/lib/graph.ts';

export const check: Check = {
  name: 'plugin-graph',
  summary: 'the start-order graph is acyclic and every port and hook is bound once',
  async run(ctx) {
    return pluginGraphFindings((await ctx.model()).graph);
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
