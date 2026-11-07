/**
 * `read-scoped` (§7.3, §7.9): a tool or reader's wait, search, diff or store path does not take a `RedactionScope`.
 * Read in every subsystem's daemon half (Vault excepted: it implements the scope): a function, method or arrow named
 * `wait…`, `search…`, `diff…` or `store…` must have a parameter whose type names `RedactionScope`. A path that never
 * shows text can opt out with the exact comment `// read-scoped: none — <reason>` on the line above.
 */
import { relative, sep } from 'node:path';
import { type AstNode, type Check, type Finding, nameOf, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { areaOf } from '../gen/lib/imports.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';

export const READ_PATH = /^(wait|search|diff|store)(?![a-z])/;
const OPT_OUT = /\/\/ read-scoped: none — \S/;

function functionNode(node: AstNode): { readonly name: string; readonly fn: AstNode } | undefined {
  if (node.type === 'FunctionDeclaration' && node.id !== null) {
    const name = nameOf(node.id);
    return name === undefined ? undefined : { name, fn: node };
  }
  if (
    (node.type === 'MethodDefinition' || node.type === 'TSAbstractMethodDefinition' || node.type === 'Property') &&
    node.computed !== true
  ) {
    const value = node.value as AstNode | undefined;
    const name = nameOf(node.key);
    if (name === undefined || value === undefined) return undefined;
    if (value.type === 'FunctionExpression' || value.type === 'ArrowFunctionExpression') return { name, fn: value };
    return undefined;
  }
  if (node.type === 'VariableDeclarator') {
    const init = node.init as AstNode | null;
    const name = nameOf(node.id);
    if (
      name !== undefined &&
      init !== null &&
      (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')
    )
      return { name, fn: init };
  }
  return undefined;
}

export function readScopedIn(file: string, where = file): Finding[] {
  const parsed = parseFile(file);
  const lines = parsed.source.split('\n');
  const findings: Finding[] = [];
  walk(parsed.program, node => {
    const found = functionNode(node);
    if (found === undefined || !READ_PATH.test(found.name)) return;
    const line = parsed.line(node.start);
    if (OPT_OUT.test(lines[line - 2] ?? '')) return;
    const params = (found.fn.params as readonly AstNode[] | undefined) ?? [];
    const typed = params.some(param => {
      const text = parsed.source.slice(param.start, param.end);
      return /\bRedactionScope\b/.test(text);
    });
    if (!typed)
      findings.push({
        check: 'read-scoped',
        where: `${where}:${line}`,
        message: `${found.name} reads without a RedactionScope parameter`,
      });
  });
  return findings;
}

export const check: Check = {
  name: 'read-scoped',
  summary: 'every wait, search, diff and store path takes a RedactionScope',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    const findings: Finding[] = [];
    for (const pkg of ws.subsystems) {
      if (pkg.id === 'vault' || pkg.id === 'kernel') continue;
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      for (const file of sourceFiles(pkg, { tests: false }))
        if (areaOf(pkg, file) === 'daemon')
          findings.push(...readScopedIn(file, relative(ws.root, file).split(sep).join('/')));
    }
    return findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
