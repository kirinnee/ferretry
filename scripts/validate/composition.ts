/**
 * `composition`: every package's `composition.tsv` is well formed ("A feature adds files and lines; it never rewrites shared
 * code", the composition guard `scripts/ci/composition-guard.ts` reads these files). Per file: the fixed header, five columns,
 * a known kind, a clean path that EXISTS under the package, sorted by path then kind, no duplicate (and no path declared by
 * two packages), a reason on every line. The reader is `scripts/ci/lib/composition.ts`; this is only the check around it.
 * An `oversize` entry's 45-day expiry is the H6 size check's, not read here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPaths, readDeclared } from '../ci/lib/composition.ts';
import { packageRoots } from '../ci/one-folder.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

export const check: Check = {
  name: 'composition',
  summary: 'every package composition.tsv is well formed, sorted, and names files that exist',
  async run(ctx): Promise<readonly Finding[]> {
    const roots = packageRoots(ctx.root);
    const declared = readDeclared(roots, path => {
      const file = join(ctx.root, path);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    });
    const problems = checkPaths(declared, roots, path => existsSync(join(ctx.root, path)));
    return problems.map(problem => ({ check: 'composition', where: problem.where, message: problem.message }));
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
