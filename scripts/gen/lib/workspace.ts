/**
 * The one view of the workspace every generator and check reads (§7.5): the packages found through the ROOT
 * `workspaces` globs (one list, review r6 finding 10), what each says it is in its own `package.json`
 * (`"ferretry": { "id", "manifest" }`), and its manifest and halves loaded on demand.
 *
 * Nothing here knows a subsystem by name. A fixture workspace (tests) is just another root.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type {
  AppImplementation,
  CliImplementation,
  DaemonImplementation,
  Manifest,
} from '../../../packages/core/kernel/manifest/index.ts';

export type PackageKind = 'shared' | 'core' | 'plugin' | 'shell';
export type HalfName = 'daemon' | 'app' | 'cli';
export const HALVES: readonly HalfName[] = ['daemon', 'app', 'cli'];

export interface WorkspacePackage {
  /** Absolute folder. */
  readonly dir: string;
  /** Folder relative to the root, `/`-separated. */
  readonly rel: string;
  /** npm name. */
  readonly name: string;
  readonly kind: PackageKind;
  /** The subsystem id from `"ferretry": { "id" }`; undefined for `std` and the two shells. */
  readonly id?: string;
  /** Absolute manifest path (`"ferretry": { "manifest" }`). */
  readonly manifestPath?: string;
  /** `exports` map, as written. */
  readonly exports: Readonly<Record<string, string>>;
  readonly dependencies: Readonly<Record<string, string>>;
}

export interface Workspace {
  readonly root: string;
  readonly packages: readonly WorkspacePackage[];
  /** Packages that declare a subsystem id (core and plugins), sorted by id. */
  readonly subsystems: readonly WorkspacePackage[];
  byId(id: string): WorkspacePackage | undefined;
  byName(name: string): WorkspacePackage | undefined;
  /** The package whose folder holds this absolute file, if any. */
  ownerOf(file: string): WorkspacePackage | undefined;
}

interface PackageJson {
  readonly name?: string;
  readonly workspaces?: readonly string[] | { readonly packages?: readonly string[] };
  readonly ferretry?: { readonly id?: string; readonly manifest?: string };
  readonly exports?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

function readJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function kindOf(rel: string, id: string | undefined): PackageKind {
  if (rel.startsWith('packages/core/')) return 'core';
  if (rel.startsWith('packages/plugins/')) return 'plugin';
  return id === undefined && rel !== 'packages/std' ? 'shell' : 'shared';
}

/** Reads the root `workspaces` globs and every package they match. Throws on a malformed root. */
export function loadWorkspace(rootDir: string): Workspace {
  const root = resolve(rootDir);
  const rootJson = readJson(join(root, 'package.json'));
  const globs = Array.isArray(rootJson.workspaces)
    ? rootJson.workspaces
    : ((rootJson.workspaces as { packages?: readonly string[] } | undefined)?.packages ?? []);
  if (globs.length === 0) throw new Error(`${root}/package.json has no workspaces`);
  const seen = new Set<string>();
  const packages: WorkspacePackage[] = [];
  for (const pattern of globs) {
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`);
    for (const match of [...glob.scanSync({ cwd: root, onlyFiles: true })].sort()) {
      const file = join(root, match);
      const dir = dirname(file);
      if (seen.has(dir) || dir.includes(`${sep}node_modules${sep}`)) continue;
      seen.add(dir);
      const json = readJson(file);
      const rel = toPosix(relative(root, dir));
      const id = json.ferretry?.id;
      packages.push({
        dir,
        rel,
        name: json.name ?? rel,
        kind: kindOf(rel, id),
        ...(id === undefined ? {} : { id }),
        ...(json.ferretry?.manifest === undefined ? {} : { manifestPath: resolve(dir, json.ferretry.manifest) }),
        exports: json.exports ?? {},
        dependencies: json.dependencies ?? {},
      });
    }
  }
  packages.sort((a, b) => a.rel.localeCompare(b.rel));
  const subsystems = packages
    .filter(pkg => pkg.id !== undefined)
    .sort((a, b) => (a.id as string).localeCompare(b.id as string));
  const byDirLength = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  return {
    root,
    packages,
    subsystems,
    byId: id => subsystems.find(pkg => pkg.id === id),
    byName: name => packages.find(pkg => pkg.name === name),
    ownerOf: file => byDirLength.find(pkg => file === pkg.dir || file.startsWith(pkg.dir + sep)),
  };
}

/** Absolute path of a half's entry, from the package's `exports` (`./daemon`), or undefined. */
export function halfPath(pkg: WorkspacePackage, half: HalfName): string | undefined {
  const target = pkg.exports[`./${half}`];
  if (target === undefined) return undefined;
  const file = resolve(pkg.dir, target);
  return existsSync(file) ? file : undefined;
}

export function contractPath(pkg: WorkspacePackage, testing = false): string | undefined {
  const target = pkg.exports[testing ? './contract/testing' : './contract'];
  if (target === undefined) return undefined;
  const file = resolve(pkg.dir, target);
  return existsSync(file) ? file : undefined;
}

// ─── loading ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LoadedSubsystem {
  readonly pkg: WorkspacePackage;
  readonly id: string;
  readonly manifest: Manifest;
}

/** Imports every subsystem manifest. A manifest that throws is reported, not swallowed. */
export async function loadManifests(
  ws: Workspace,
): Promise<{ readonly loaded: readonly LoadedSubsystem[]; readonly failures: readonly string[] }> {
  const loaded: LoadedSubsystem[] = [];
  const failures: string[] = [];
  for (const pkg of ws.subsystems) {
    if (pkg.manifestPath === undefined) {
      failures.push(`${pkg.rel}: package.json "ferretry" names no manifest`);
      continue;
    }
    try {
      const module = (await import(pkg.manifestPath)) as { default?: Manifest };
      const manifest = module.default;
      if (manifest === undefined || typeof manifest !== 'object') {
        failures.push(`${pkg.rel}: ${relative(ws.root, pkg.manifestPath)} has no default export`);
        continue;
      }
      if (manifest.id !== pkg.id) {
        failures.push(`${pkg.rel}: manifest id "${manifest.id}" is not package.json's "${pkg.id}"`);
        continue;
      }
      loaded.push({ pkg, id: pkg.id as string, manifest });
    } catch (error) {
      failures.push(`${pkg.rel}: manifest failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { loaded, failures };
}

export type AnyImplementation = DaemonImplementation | AppImplementation | CliImplementation;

/** Imports one half's default export. Undefined when the package has no such half. */
export async function loadHalf(pkg: WorkspacePackage, half: HalfName): Promise<AnyImplementation | undefined> {
  const file = halfPath(pkg, half);
  if (file === undefined) return undefined;
  const module = (await import(file)) as { default?: AnyImplementation };
  return module.default;
}

/** Every source file of a package (TS/TSX), relative paths, skipping node_modules and generated output. */
export function sourceFiles(pkg: WorkspacePackage, options: { readonly tests?: boolean } = {}): string[] {
  const glob = new Bun.Glob('**/*.{ts,tsx,mts}');
  const files: string[] = [];
  for (const match of glob.scanSync({ cwd: pkg.dir, onlyFiles: true })) {
    const path = toPosix(match);
    if (path.includes('node_modules/')) continue;
    if (options.tests === false && /(^|\/)tests\//.test(path)) continue;
    files.push(join(pkg.dir, match));
  }
  return files.sort();
}

export function relPath(ws: Workspace, file: string): string {
  return toPosix(relative(ws.root, file));
}
