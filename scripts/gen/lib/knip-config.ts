/**
 * Where the knip settings live. Each package owns its own, so a feature that adds an entry point or keeps an export
 * edits its own folder and never a file every package shares. THE RULE (one name, two places):
 *
 * - `<package>/knip.json` is that package's workspace block for the repository run (`knip.ts`);
 *   `<package>/knip.production.json` is its block for the production run (`knip.production.ts`). Both are the knip
 *   workspace settings (`entry`, `project`, `ignore`, `ignoreIssues`, `ignoreDependencies`, …) of ONE package, plus an
 *   optional `allowed` object: `{ "<setting>": "<why it is honest>" }`, the reason `pending-tags` asks for a setting that
 *   keeps code alive without a pending-port tie (`entry:app/surfaces.tsx`, `ignoreDependencies:sherpa-glue`,
 *   `ignoreIssues["contract/wire.ts"]`). A package with no special setting has no file: the root's `packages/core/*` and
 *   `packages/plugins/*` blocks cover it.
 * - the root `knip.ts` / `knip.production.ts` keep only what is truly global: the rules, the tags, the root workspace
 *   `.` and the two glob defaults (`ROOT_WORKSPACES`). A package key in either is refused by `pending-tags`.
 *
 * A package owns a file when it is `packages/std`, `packages/cli`, `packages/app`, or `packages/core|plugins/<id>`
 * (`OWNED_DIR`). The root files call `composeKnip`, which reads those files and returns the one config knip runs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The part file of the repository run and of the production run, by the root config that reads it. */
export const KNIP_RUNS = [
  { config: 'knip.ts', part: 'knip.json' },
  { config: 'knip.production.ts', part: 'knip.production.json' },
] as const;

export type KnipPartName = (typeof KNIP_RUNS)[number]['part'];

/** The workspace keys that may stay in a root config. Every other key belongs in its package's own file. */
export const ROOT_WORKSPACES: readonly string[] = ['.', 'packages/core/*', 'packages/plugins/*'];

/** A folder that owns knip files: std, the CLI, the app shell, or one core or plugin package. */
export const OWNED_DIR = /^packages\/(?:std|cli|app|(?:core|plugins)\/[^/]+)$/u;

/** The settings of one knip workspace, as knip reads them. */
export type KnipWorkspace = Record<string, unknown>;

/** What a root config holds itself: the global keys and the root-level workspaces. */
export interface KnipGlobals {
  readonly workspaces: Readonly<Record<string, KnipWorkspace>>;
  readonly [key: string]: unknown;
}

/** One package's part file, parsed. */
export interface KnipPart {
  /** Repo-relative path of the file, `/`-separated. */
  readonly where: string;
  /** The package folder, repo-relative: the workspace key it becomes. */
  readonly dir: string;
  /** The workspace settings, without `$schema` and `allowed`. */
  readonly settings: KnipWorkspace;
  /** Setting → reason, from `allowed`. */
  readonly allowed: Readonly<Record<string, string>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every folder that may own knip files, repo-relative and sorted: std, cli, app, `core/*`, `plugins/*`. */
export function ownedDirs(root: string): string[] {
  const dirs = ['packages/std', 'packages/cli', 'packages/app'];
  for (const group of ['core', 'plugins']) {
    const base = join(root, 'packages', group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true }))
      if (entry.isDirectory()) dirs.push(`packages/${group}/${entry.name}`);
  }
  return dirs.filter(dir => existsSync(join(root, dir))).sort();
}

/** Parses one part file; throws a sentence naming the file when it is not a JSON object. */
export function parsePart(where: string, dir: string, text: string): KnipPart {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Error(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(doc)) throw new Error(`${where}: is not a JSON object of workspace settings`);
  const { $schema: _schema, allowed, ...settings } = doc;
  if (allowed !== undefined && !(isRecord(allowed) && Object.values(allowed).every(why => typeof why === 'string')))
    throw new Error(`${where}: "allowed" must map a setting to its reason`);
  return { where, dir, settings, allowed: (allowed ?? {}) as Record<string, string> };
}

/** Every package's part file of one run that exists, sorted by package folder. */
export function readKnipParts(root: string, part: KnipPartName): KnipPart[] {
  const parts: KnipPart[] = [];
  for (const dir of ownedDirs(root)) {
    const where = `${dir}/${part}`;
    const path = join(root, where);
    if (existsSync(path)) parts.push(parsePart(where, dir, readFileSync(path, 'utf8')));
  }
  return parts;
}

/** The config knip runs: the root's globals, then one workspace per package part file. */
export function composeKnipFrom(globals: KnipGlobals, parts: readonly KnipPart[]): Record<string, unknown> {
  const workspaces: Record<string, KnipWorkspace> = { ...globals.workspaces };
  for (const { dir, settings, where } of parts) {
    if (dir in workspaces) throw new Error(`${where}: "${dir}" is also a workspace of the root config`);
    workspaces[dir] = settings;
  }
  return { ...globals, workspaces };
}

/** What a root `knip.ts` / `knip.production.ts` exports: its globals composed with every package's part file. */
export const composeKnip = (root: string, part: KnipPartName, globals: KnipGlobals): Record<string, unknown> =>
  composeKnipFrom(globals, readKnipParts(root, part));

/** The names `knip.json` / `knip.production.json` go by, anywhere in a tree. */
const PART_NAMES: ReadonlySet<string> = new Set(KNIP_RUNS.map(run => run.part));

/** Directories no search enters: VCS metadata, dependencies, other checkouts, the nix shell cache. */
const NOT_SEARCHED: ReadonlySet<string> = new Set(['.git', 'node_modules', '.worktrees', '.direnv']);

/**
 * Every `knip.json` / `knip.production.json` under `root`, root-relative and sorted, wherever it sits. The ownership
 * check, not the listing, decides which are allowed: one the rule does not allow must be found to be rejected.
 */
export function knipFilePaths(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (NOT_SEARCHED.has(entry.name)) continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (PART_NAMES.has(entry.name)) found.push(next);
    }
  };
  walk('');
  return found.sort();
}
