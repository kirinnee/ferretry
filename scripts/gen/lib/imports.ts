/**
 * A real module-record pass (oxc-parser), never a grep: every static import, re-export and literal dynamic import of
 * a file, each resolved to the package and AREA it lands in. The import checks (`context-imports`, `contract-graph`,
 * `contract-consumes`) are set operations over these edges.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { Workspace, WorkspacePackage } from './workspace.ts';

/**
 * Where inside a package a file sits. `contract-testing` is the contract's fakes and suites; `tests` is the package's
 * own tests; `generated` is generator output; `other` is anything outside the §3 layout.
 */
export type Area =
  | 'contract'
  | 'contract-testing'
  | 'manifest'
  | 'daemon'
  | 'app'
  | 'cli'
  | 'tests'
  | 'generated'
  | 'kernel-contract'
  | 'kernel-manifest'
  | 'kernel-testing'
  | 'kernel-host'
  | 'kernel-plugin'
  | 'root'
  | 'other';

function posix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Classifies an absolute file inside `pkg`. */
export function areaOf(pkg: WorkspacePackage, file: string): Area {
  const rel = posix(relative(pkg.dir, file));
  if (/(^|\/)generated\//.test(rel)) return 'generated';
  if (rel.startsWith('tests/')) return 'tests';
  if (pkg.id === 'kernel') {
    if (rel.startsWith('contract/')) return 'kernel-contract';
    if (rel.startsWith('manifest/')) return 'kernel-manifest';
    if (rel.startsWith('testing/')) return 'kernel-testing';
    if (rel.startsWith('host/') || rel.startsWith('src/')) return 'kernel-host';
    if (rel === 'plugin.ts') return 'kernel-plugin';
    return 'other';
  }
  if (rel.startsWith('contract/testing/')) return 'contract-testing';
  if (rel.startsWith('contract/')) return 'contract';
  if (rel === 'manifest.ts') return 'manifest';
  if (rel.startsWith('daemon/')) return 'daemon';
  if (rel.startsWith('app/')) return 'app';
  if (rel.startsWith('cli/')) return 'cli';
  if (pkg.kind === 'shared' || pkg.kind === 'shell') return 'root';
  return 'other';
}

/** The area a package subpath export lands in (`@ferretry/plugin-board/contract/testing` → `contract-testing`). */
function areaOfSubpath(pkg: WorkspacePackage, subpath: string): Area {
  if (pkg.id === 'kernel') {
    const kernelAreas: Record<string, Area> = {
      contract: 'kernel-contract',
      manifest: 'kernel-manifest',
      testing: 'kernel-testing',
      host: 'kernel-host',
      plugin: 'kernel-plugin',
    };
    return kernelAreas[subpath] ?? 'other';
  }
  const areas: Record<string, Area> = {
    contract: 'contract',
    'contract/testing': 'contract-testing',
    manifest: 'manifest',
    daemon: 'daemon',
    app: 'app',
    cli: 'cli',
    '': 'root',
  };
  return areas[subpath] ?? 'other';
}

export interface ImportEdge {
  /** Absolute importing file. */
  readonly from: string;
  readonly fromPkg: WorkspacePackage;
  readonly fromArea: Area;
  readonly specifier: string;
  /** 1-based line of the specifier. */
  readonly line: number;
  readonly typeOnly: boolean;
  readonly kind: 'import' | 'export' | 'dynamic';
  /** The workspace package it lands in; undefined for an npm package or a file outside every package. */
  readonly toPkg?: WorkspacePackage;
  readonly toArea?: Area;
  /** The npm package name for an external import (`zod`, `node:fs`). */
  readonly external?: string;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

function externalName(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

/** Resolves one specifier as seen from `from`. */
export function resolveSpecifier(
  ws: Workspace,
  from: string,
  specifier: string,
): { readonly toPkg?: WorkspacePackage; readonly toArea?: Area; readonly external?: string } {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const target = resolve(dirname(from), specifier);
    const toPkg = ws.ownerOf(target);
    return toPkg === undefined ? {} : { toPkg, toArea: areaOf(toPkg, target) };
  }
  const byName = [...ws.packages]
    .sort((a, b) => b.name.length - a.name.length)
    .find(pkg => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`));
  if (byName !== undefined) {
    const subpath = specifier === byName.name ? '' : specifier.slice(byName.name.length + 1);
    return { toPkg: byName, toArea: areaOfSubpath(byName, subpath) };
  }
  return { external: externalName(specifier) };
}

/** Every import edge of one file. Throws with the file name on a parse error. */
export function importsOf(ws: Workspace, file: string): ImportEdge[] {
  const fromPkg = ws.ownerOf(file);
  if (fromPkg === undefined) return [];
  const source = readFileSync(file, 'utf8');
  const parsed = parseSync(file, source, { sourceType: 'module' });
  if (parsed.errors.length > 0) {
    throw new Error(`${file}: ${parsed.errors.map(error => error.message).join('; ')}`);
  }
  const fromArea = areaOf(fromPkg, file);
  const edges: ImportEdge[] = [];
  const push = (specifier: string, offset: number, typeOnly: boolean, kind: ImportEdge['kind']): void => {
    edges.push({
      from: file,
      fromPkg,
      fromArea,
      specifier,
      line: lineAt(source, offset),
      typeOnly,
      kind,
      ...resolveSpecifier(ws, file, specifier),
    });
  };
  for (const record of parsed.module.staticImports) {
    const typeOnly = record.entries.length > 0 && record.entries.every(entry => entry.isType);
    push(record.moduleRequest.value, record.moduleRequest.start, typeOnly, 'import');
  }
  for (const record of parsed.module.staticExports) {
    for (const entry of record.entries) {
      if (entry.moduleRequest === null || entry.moduleRequest === undefined) continue;
      push(entry.moduleRequest.value, entry.moduleRequest.start, entry.isType, 'export');
      break;
    }
  }
  for (const record of parsed.module.dynamicImports) {
    const raw = source.slice(record.moduleRequest.start, record.moduleRequest.end).trim();
    const literal = /^(['"`])([^'"`$]*)\1$/.exec(raw);
    if (literal !== null) push(literal[2] as string, record.moduleRequest.start, false, 'dynamic');
  }
  return edges;
}
