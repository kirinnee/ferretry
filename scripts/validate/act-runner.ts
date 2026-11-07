/**
 * `act-runner` (§4.7, §7.9), static layer. Fails when:
 *
 * - a tool-kind plugin declares an agent tool with no `op`, or an `op` that is not one of the twelve `OPS`;
 * - a tool-kind plugin's daemon half is ported (not a skeleton) and none of its daemon files calls `.act(` — every act
 *   goes through `kernel.act`;
 * - the type-level layer is missing: `packages/core/kernel/tests/types/act.types.ts` (compiled by `tsc --noEmit`)
 *   holds the negative cases (write-only `Op`, `Ack`, `OpaqueId`, `ResultOf`).
 *
 * The runtime layer — every tool passes the §4.7 hold table, effects table and overlap cases, and a write-only result
 * reaches nothing without `closeAck` — is the tool conformance suite in `@ferretry/kernel/testing`
 * (`toolConformance`), which each tool plugin runs in its own tests. This check cannot see inside a handler, and says
 * so rather than pretending to.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OPS } from '../../packages/core/kernel/contract/index.ts';
import { type Check, type Finding, memberPath, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { isSkeleton } from '../gen/lib/halves.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { loadHalf, sourceFiles } from '../gen/lib/workspace.ts';

export const ACT_TYPES = 'packages/core/kernel/tests/types/act.types.ts';

function callsAct(file: string): boolean {
  let found = false;
  walk(parseFile(file).program, node => {
    if (found || node.type !== 'CallExpression') return;
    const path = memberPath(node.callee as never);
    if (path !== undefined && path.length > 1 && path[path.length - 1] === 'act') found = true;
  });
  return found;
}

export const check: Check = {
  name: 'act-runner',
  summary: 'every tool act declares an Op and runs through kernel.act',
  async run(ctx) {
    const check = 'act-runner';
    const model = await ctx.model();
    const findings: Finding[] = [];
    const ops = new Set<string>(OPS);
    if (!existsSync(join(ctx.root, ACT_TYPES)))
      findings.push({ check, where: ACT_TYPES, message: 'the type-level act cases are missing' });
    for (const s of model.loaded) {
      if (ctx.packageId !== undefined && s.id !== ctx.packageId) continue;
      if (!s.manifest.kinds.includes('tool')) continue;
      const tools = s.manifest.actions?.agentTools ?? [];
      for (const tool of tools) {
        if (tool.op === undefined) findings.push({ check, where: s.id, message: `tool ${tool.name} declares no Op` });
        else if (!ops.has(tool.op)) findings.push({ check, where: s.id, message: `tool ${tool.name} declares unknown Op "${tool.op}"` });
      }
      if (tools.length === 0) continue;
      const daemon = await loadHalf(s.pkg, 'daemon').catch(() => undefined);
      if (daemon === undefined || isSkeleton(daemon)) continue;
      const files = sourceFiles(s.pkg, { tests: false }).filter(file => areaOf(s.pkg, file) === 'daemon');
      if (!files.some(callsAct))
        findings.push({ check, where: s.id, message: 'a ported tool plugin whose daemon half never calls kernel.act' });
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
