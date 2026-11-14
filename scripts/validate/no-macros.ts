/**
 * `no-macros`: an import or re-export carries `with { type: 'macro' }` (a Bun macro) anywhere in the workspace — every
 * package's source and tests, and `scripts/`.
 *
 * Why every macro and not only a macro whose own graph reaches another macro import: Bun transpiles every module it
 * loads while running a macro with macros switched off. A nested macro import there is silently DROPPED and its call
 * left in place, and that output is written to the runtime transpiler cache (`~/.bun/install/cache`, shared by every
 * checkout on the machine) under a key that ignores the macro mode. From then on every run of that source on the
 * machine throws `<macro> is not defined`, and only deleting the entry (or `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`)
 * clears it. Logins' presets service was poisoned that way in Nov 2026 and blocked every commit's `manifest-match`; the
 * file that loaded it inside a macro was never pinned down, and any branch, test or scratch script on the machine can
 * be one, so a graph check over this checkout could not have proved it safe. Data the build should not parse at boot
 * is written as a checked-in file instead (Logins' `scripts/built-ins.ts` is the shape).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type AstNode, type Check, type Finding, nameOf, parseFile, runMain, walk } from '../gen/lib/check.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';

const DECLARATIONS = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration']);

/** Whether an import attribute list says `type: 'macro'`. */
function saysMacro(attributes: unknown): boolean {
  if (!Array.isArray(attributes)) return false;
  return attributes.some(attribute => {
    const node = attribute as AstNode;
    return nameOf(node.key) === 'type' && nameOf(node.value) === 'macro';
  });
}

/** Every macro import or re-export in one file, as findings at `where`. */
export function macrosIn(file: string, where = file): Finding[] {
  const parsed = parseFile(file);
  const findings: Finding[] = [];
  walk(parsed.program, node => {
    if (!DECLARATIONS.has(node.type)) return;
    if (!saysMacro(node.attributes) && !saysMacro(node.withClause)) return;
    const from = nameOf(node.source) ?? '?';
    findings.push({
      check: 'no-macros',
      where: `${where}:${parsed.line(node.start)}`,
      message:
        `imports "${from}" as a Bun macro; a module loaded inside any macro is transpiled with its own macro ` +
        'imports dropped and cached machine-wide that way. Write the value as a checked-in data file instead.',
    });
  });
  return findings;
}

/** The repo's own scripts (not a workspace package): every TypeScript file under `scripts/`. */
function scriptFiles(root: string): string[] {
  const dir = join(root, 'scripts');
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const match of new Bun.Glob('**/*.{ts,tsx,mts}').scanSync({ cwd: dir, onlyFiles: true })) {
    const path = match.split(sep).join('/');
    if (path.includes('node_modules/') || path.includes('/.tmp/')) continue;
    files.push(join(dir, match));
  }
  return files.sort();
}

export const check: Check = {
  name: 'no-macros',
  summary: 'no Bun macro imports anywhere (they poison the shared transpiler cache)',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    const files: string[] = [];
    for (const pkg of ws.packages) {
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      files.push(...sourceFiles(pkg));
    }
    if (ctx.packageId === undefined) files.push(...scriptFiles(ws.root));
    // Only a file that says "macro" can hold one; parsing the rest would cost every commit seconds for nothing.
    return files
      .filter(file => readFileSync(file, 'utf8').includes('macro'))
      .flatMap(file => macrosIn(file, relative(ws.root, file).split(sep).join('/')));
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
