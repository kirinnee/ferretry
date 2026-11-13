/**
 * The TypeScript view the fleet-link fitness guard (`fleet-link-scan.ts`, `fleet-link-authority.ts`) reads: every production
 * module of a workspace root, inside the TypeScript project(s) that type-check it, so a question about a value is
 * answered by the type checker and not by how the code happens to be spelled.
 *
 * The checker is TypeScript 7's (`typescript/unstable/async`: the native compiler behind a pipe). Its synchronous client
 * does not run under Bun, so this module is asynchronous end to end.
 *
 * COVERAGE IS PROVED: the root `tsconfig.json` is opened first; a production module it does not include is looked up in the
 * nearest `tsconfig.json` above it that does (`packages/app`, the one-shot migration); a module no project includes is an
 * error, never a silent skip — a file that is not type-checked is a file the guard cannot see.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { API, type Project } from 'typescript/unstable/async';
import { loadWorkspace, sourceFiles } from './workspace.ts';

export interface ProjectFiles {
  readonly project: Project;
  /** Absolute production files this project is responsible for (each production file is in exactly one). */
  readonly files: readonly string[];
}

export interface ProductionProgram {
  readonly root: string;
  readonly projects: readonly ProjectFiles[];
  /** Root-relative, `/`-separated. */
  rel(file: string): string;
  close(): Promise<void>;
}

/** Every production TypeScript module of the repo at `root`: workspace sources minus tests, plus the one-shot migration. */
export function productionFiles(root: string): string[] {
  const ws = loadWorkspace(root);
  return [
    ...ws.packages.flatMap(pkg => sourceFiles(pkg, { tests: false })),
    ...[...new Bun.Glob('migration/**/*.{ts,tsx,mts}').scanSync({ cwd: root, onlyFiles: true })]
      .filter(path => !path.includes('node_modules/') && !/(^|\/)(tests?|fixtures)\//.test(path))
      .map(path => join(root, path)),
  ];
}

/** The nearest tsconfig above `file` (below `root`), deepest first. */
function tsconfigsAbove(root: string, file: string): string[] {
  const found: string[] = [];
  for (let dir = dirname(file); dir.startsWith(root + sep); dir = dirname(dir)) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) found.push(candidate);
  }
  return found;
}

export async function openProductionProgram(rootDir: string): Promise<ProductionProgram> {
  const root = resolve(rootDir);
  const rootConfig = join(root, 'tsconfig.json');
  if (!existsSync(rootConfig)) throw new Error(`${root} has no tsconfig.json: nothing to type-check`);
  const files = productionFiles(root);
  const api = new API({ cwd: root });
  try {
    let snapshot = await api.updateSnapshot({ openProjects: [rootConfig] });
    const memberOf = async (projects: readonly Project[]): Promise<Set<string>[]> =>
      Promise.all(projects.map(async project => new Set(await project.program.getSourceFileNames())));
    let members = await memberOf(snapshot.getProjects());
    const uncovered = files.filter(file => !members.some(names => names.has(file)));
    if (uncovered.length > 0) {
      // The tsconfigs above the uncovered modules, deepest first, that actually include them.
      const wanted = new Set<string>();
      for (const file of uncovered) {
        for (const config of tsconfigsAbove(root, file)) {
          const parsed = await api.parseConfigFile(config);
          if (parsed.fileNames.includes(file)) {
            wanted.add(config);
            break;
          }
        }
      }
      snapshot = await api.updateSnapshot({ openProjects: [rootConfig, ...wanted] });
    }
    // The root project first: it is the one that must hold the kernel contract, and the one that owns a module several include.
    const projects = [...snapshot.getProjects()].sort(
      (a, b) => Number(b.configFileName === rootConfig) - Number(a.configFileName === rootConfig),
    );
    members = await memberOf(projects);
    const assigned = projects.map(() => [] as string[]);
    const lost: string[] = [];
    for (const file of files) {
      const index = members.findIndex(names => names.has(file));
      if (index < 0) lost.push(file);
      else assigned[index]?.push(file);
    }
    if (lost.length > 0)
      throw new Error(
        `${lost.length} production module(s) are in no TypeScript project, so the fleet-link guard cannot type-check ` +
          `them (add them to a tsconfig include): ${lost
            .slice(0, 8)
            .map(file => relative(root, file))
            .join(', ')}`,
      );
    return {
      root,
      projects: projects.map((project, index) => ({ project, files: assigned[index] ?? [] })),
      rel: file => relative(root, file).split(sep).join('/'),
      close: () => api.close(),
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
