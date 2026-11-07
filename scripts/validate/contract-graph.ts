/**
 * `contract-graph` (§2.4, §7.9): the contract import graph has a cycle, a core contract imports a plugin contract, or
 * a plugin contract imports another plugin's contract outside the allowed edges (Usage → Logins for `LoginId`, Packs →
 * Runtimes for `RuntimeId`, Access → Connections for the published carriers a pairing answer carries; any other edge
 * needs the lead).
 */
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { isCore } from '../gen/lib/graph.ts';
import type { ImportEdge } from '../gen/lib/imports.ts';

export const ALLOWED_PLUGIN_EDGES: ReadonlySet<string> = new Set([
  'usage→logins',
  'packs→runtimes',
  'access→connections',
  // Lead-approved optional use: Catalogs shares pairing's advertised address and directory facts (P80).
  'catalogs→connections',
  // Warden settings read the runtime list and whether the Jev key is set (britnee, optional uses).
  'warden→runtimes', // read-only fact for Warden settings (britnee, optional uses)
  'warden→voice', // read-only fact for Warden settings (britnee, optional uses)
]);

export function contractEdges(edges: readonly ImportEdge[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    const from = edge.fromPkg.id;
    const to = edge.toPkg?.id;
    if (from === undefined || to === undefined || from === to) continue;
    if ((edge.fromArea !== 'contract' && edge.fromArea !== 'contract-testing') || edge.toArea !== 'contract') continue;
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from)?.add(to);
  }
  return graph;
}

export function contractGraphFindings(edges: readonly ImportEdge[]): Finding[] {
  const check = 'contract-graph';
  const graph = contractEdges(edges);
  const findings: Finding[] = [];
  for (const [from, targets] of [...graph].sort(([a], [b]) => a.localeCompare(b)))
    for (const to of [...targets].sort()) {
      if (isCore(from) && !isCore(to))
        findings.push({ check, where: from, message: `core contract imports plugin contract ${to}` });
      else if (!isCore(from) && !isCore(to) && !ALLOWED_PLUGIN_EDGES.has(`${from}→${to}`))
        findings.push({
          check,
          where: from,
          message: `plugin contract imports plugin contract ${to}; only ${[...ALLOWED_PLUGIN_EDGES].join(', ')} are allowed (ask the lead)`,
        });
    }
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    if (state.get(id) === 'done') return undefined;
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of [...(graph.get(id) ?? [])].sort()) {
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const id of [...graph.keys()].sort()) {
    const cycle = visit(id);
    if (cycle !== undefined) {
      findings.push({ check, where: cycle[0] as string, message: `contract cycle: ${cycle.join(' → ')}` });
      break;
    }
  }
  return findings;
}

export const check: Check = {
  name: 'contract-graph',
  summary: 'contracts form a one-way graph; core contracts import no plugin',
  async run(ctx) {
    return contractGraphFindings((await ctx.model()).edges);
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
