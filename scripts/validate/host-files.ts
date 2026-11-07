/**
 * `host-files` (§7.9): a host file (`fyd.ts`, `fy.ts`, `main.tsx`) names a subsystem or exceeds 150 lines. "Names" =
 * imports a core or plugin package other than the kernel, or holds a string that is a subsystem id or package name.
 * A host reaches subsystems only through the generated registries, which are excepted by path (they live under a
 * `generated/` folder) and kept honest by `registries-fresh`.
 */
import { relative, sep } from 'node:path';
import { type Check, type Finding, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { importsOf } from '../gen/lib/imports.ts';
import type { Workspace } from '../gen/lib/workspace.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';

export const HOST_FILE_NAMES: ReadonlySet<string> = new Set(['fyd.ts', 'fy.ts', 'main.tsx']);
export const HOST_FILE_MAX_LINES = 150;

export function hostFiles(ws: Workspace): string[] {
  return ws.packages
    .flatMap(pkg => sourceFiles(pkg, { tests: false }))
    .filter(file => HOST_FILE_NAMES.has(file.split(sep).pop() as string))
    .filter(file => !file.includes(`${sep}generated${sep}`));
}

export function hostFileFindings(ws: Workspace, file: string): Finding[] {
  const check = 'host-files';
  const rel = relative(ws.root, file).split(sep).join('/');
  const findings: Finding[] = [];
  const parsed = parseFile(file);
  const lines = parsed.source.split('\n').length - (parsed.source.endsWith('\n') ? 1 : 0);
  if (lines > HOST_FILE_MAX_LINES)
    findings.push({ check, where: rel, message: `${lines} lines; a host file has at most ${HOST_FILE_MAX_LINES}` });
  const ids = new Set(ws.subsystems.map(pkg => pkg.id as string).filter(id => id !== 'kernel'));
  const names = new Set(ws.subsystems.filter(pkg => pkg.id !== 'kernel').map(pkg => pkg.name));
  for (const edge of importsOf(ws, file)) {
    const target = edge.toPkg;
    if (target === undefined || edge.toArea === 'generated') continue;
    if (target.id !== undefined && target.id !== 'kernel')
      findings.push({
        check,
        where: `${rel}:${edge.line}`,
        message: `imports ${edge.specifier}; a host names no subsystem`,
      });
  }
  walk(parsed.program, node => {
    if (node.type !== 'Literal' || typeof node.value !== 'string') return;
    const value = node.value;
    if (ids.has(value) || names.has(value) || [...names].some(name => value.startsWith(`${name}/`)))
      findings.push({ check, where: `${rel}:${parsed.line(node.start)}`, message: `names subsystem "${value}"` });
  });
  return findings;
}

export const check: Check = {
  name: 'host-files',
  summary: 'host files are short and name no subsystem',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    return hostFiles(ws).flatMap(file => hostFileFindings(ws, file));
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
