/**
 * `contract-consumes` (§7.9, §9.6): a client half (app or CLI) imports a contract, calls a route or registers for a
 * package its manifest does not declare it consumes, or reaches a daemon around the generated client.
 *
 * What a manifest declares it consumes: the providers of its `needs` and `uses`, the offerers of the hooks it takes,
 * the registrar of every ask source it renders, and the owners of the routes its app actions call. A route a half
 * calls (`client.call('GET /v1/x')`, a literal) must be its own or one of those packages'. `fetch`, `WebSocket`,
 * `EventSource` and `XMLHttpRequest` in a client half bypass the generated client and its hash guard.
 */
import { type Check, type Finding, memberPath, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { consumedBy } from '../gen/lib/hashes.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { sourceFiles } from '../gen/lib/workspace.ts';

const BYPASS = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//;

export const check: Check = {
  name: 'contract-consumes',
  summary: 'client halves consume only what their manifest declares, through the generated client',
  async run(ctx) {
    const check = 'contract-consumes';
    const model = await ctx.model();
    const declared = consumedBy(model.graph, []);
    const routeOwner = new Map<string, string>();
    for (const s of model.loaded)
      for (const decl of [...(s.manifest.actions?.routes ?? []), ...(s.manifest.actions?.sockets ?? [])])
        routeOwner.set(decl.key, s.id);
    const findings: Finding[] = [];
    for (const s of model.loaded) {
      if (ctx.packageId !== undefined && s.id !== ctx.packageId) continue;
      const allowed = new Set([s.id, 'kernel', ...(declared.get(s.id) ?? [])]);
      for (const action of s.manifest.actions?.app ?? []) {
        const owner = routeOwner.get(action.calls);
        if (owner === undefined)
          findings.push({ check, where: s.id, message: `app action ${action.id} calls ${action.calls}, which no package declares` });
        else allowed.add(owner);
      }
      for (const edge of model.edges) {
        if (edge.fromPkg !== s.pkg || (edge.fromArea !== 'app' && edge.fromArea !== 'cli')) continue;
        const to = edge.toPkg?.id;
        if (to !== undefined && edge.toArea === 'contract' && !allowed.has(to))
          findings.push({
            check,
            where: `${edge.from.slice(model.ws.root.length + 1)}:${edge.line}`,
            message: `the ${edge.fromArea} half imports ${to}'s contract but the manifest does not declare consuming ${to}`,
          });
      }
      for (const file of sourceFiles(s.pkg, { tests: false })) {
        const area = areaOf(s.pkg, file);
        if (area !== 'app' && area !== 'cli') continue;
        const parsed = parseFile(file);
        const rel = file.slice(model.ws.root.length + 1);
        walk(parsed.program, (node, parents) => {
          if (node.type === 'Identifier' && BYPASS.has(node.name as string)) {
            const parent = parents[parents.length - 1];
            const isProperty =
              parent !== undefined &&
              ((parent.type === 'MemberExpression' && parent.property === node && parent.computed !== true) ||
                (parent.type === 'Property' && parent.key === node && parent.computed !== true));
            const isType = parents.some(p => typeof p.type === 'string' && p.type.startsWith('TS'));
            if (!isProperty && !isType)
              findings.push({ check, where: `${rel}:${parsed.line(node.start)}`, message: `${node.name as string} bypasses the generated client` });
          }
          if (node.type === 'CallExpression') {
            const callee = node.callee as { type: string };
            const path = callee.type === 'MemberExpression' ? memberPath(callee as never) : undefined;
            const args = node.arguments as readonly { type: string; value?: unknown }[];
            const first = args[0];
            if (path?.[path.length - 1] === 'call' && first?.type === 'Literal' && typeof first.value === 'string' && ROUTE_KEY.test(first.value)) {
              const owner = routeOwner.get(first.value);
              if (owner === undefined || !allowed.has(owner))
                findings.push({
                  check,
                  where: `${rel}:${parsed.line(node.start)}`,
                  message:
                    owner === undefined
                      ? `calls ${first.value}, which no package declares`
                      : `calls ${first.value} of ${owner}, which the manifest does not declare consuming`,
                });
            }
          }
        });
      }
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
