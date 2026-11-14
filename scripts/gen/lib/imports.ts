/**
 * Two passes over the same question, "what does this file import":
 *
 *   importsOf        a real module-record pass (oxc-parser), never a grep: every static import, re-export and literal
 *                    dynamic import of a file, each resolved to the package and AREA it lands in, with line numbers
 *                    and the type-only flag. The import checks (`context-imports`, `contract-graph`,
 *                    `contract-consumes`) are set operations over these edges. oxc-parser is a devDependency, so it
 *                    is loaded on the first call, never when this module loads: the Nix build installs production
 *                    dependencies only and only generates (it never checks).
 *   scannedImportsOf the generator's pass: Bun's own import scanner, which needs no dependency. It carries just what
 *                    contract hashing reads (which package and area a file imports, test files excluded), so its
 *                    edges have no line number and no type-only flag.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import type { parseSync as ParseSync } from 'oxc-parser';
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
  | 'kernel-worker'
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
    if (rel === 'worker.ts') return 'kernel-worker';
    // The Kernel's own app half (Settings › Files, Doctor, Host checks): browser code like any other app half.
    if (rel.startsWith('app/')) return 'app';
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
      // The push envelope alone, for the signed service worker: its graph may hold this one file and zod, not the barrel.
      'contract/push-envelope': 'kernel-contract',
      // This device's notification filter document, for the same worker: its graph is this file, the envelope and zod.
      'contract/notification-filter': 'kernel-contract',
      // The hosted app origin alone, for the app's build config: Node's type stripping loads it, and the barrel
      // carries syntax it refuses.
      'contract/hosted-app': 'kernel-contract',
      // The pure wire and the browser-safe session codec: no IO, so another package may import them as it imports
      // the contract (the files themselves sit outside contract/ because they re-export the host's session wire).
      wire: 'kernel-contract',
      session: 'kernel-contract',
      manifest: 'kernel-manifest',
      testing: 'kernel-testing',
      host: 'kernel-host',
      plugin: 'kernel-plugin',
      // A worker thread's opener for the sqlite files its half granted: daemon-side code only.
      worker: 'kernel-worker',
      app: 'app',
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

let oxcParseSync: typeof ParseSync | undefined;

/** oxc-parser, loaded on first use (see the module comment). */
export function parser(): typeof ParseSync {
  oxcParseSync ??= (createRequire(import.meta.url)('oxc-parser') as { parseSync: typeof ParseSync }).parseSync;
  return oxcParseSync;
}

const transpilers = new Map<string, Bun.Transpiler>();

/**
 * Bun's scanner erases type-only imports, but a type-only import of a contract is still consumption (§9.6), so the
 * `type` markers are removed first: `import type`, `export type {`/`export type *` and inline `{ type X }`.
 */
function withTypeMarkersRemoved(source: string): string {
  return source
    .replace(/^#!.*/, '')
    .replace(/^(\s*)import\s+type\s+/gm, '$1import ')
    .replace(/^(\s*)export\s+type\s*([{*])/gm, '$1export $2')
    .replace(/([{,]\s*)type\s+(?=[A-Za-z_$][\w$]*\s*(?:as\s+[\w$]+\s*)?[,}])/g, '$1');
}

/** Every import edge of one file, from Bun's scanner. Throws with the file name on a parse error. */
export function scannedImportsOf(ws: Workspace, file: string): ImportEdge[] {
  const fromPkg = ws.ownerOf(file);
  if (fromPkg === undefined) return [];
  const loader = file.endsWith('.tsx') ? 'tsx' : 'ts';
  let transpiler = transpilers.get(loader);
  if (transpiler === undefined) {
    transpiler = new Bun.Transpiler({ loader });
    transpilers.set(loader, transpiler);
  }
  let found: ReturnType<Bun.Transpiler['scanImports']>;
  try {
    found = transpiler.scanImports(withTypeMarkersRemoved(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fromArea = areaOf(fromPkg, file);
  return found.map(entry => ({
    from: file,
    fromPkg,
    fromArea,
    specifier: entry.path,
    line: 0,
    typeOnly: false,
    kind: entry.kind === 'dynamic-import' ? ('dynamic' as const) : ('import' as const),
    ...resolveSpecifier(ws, file, entry.path),
  }));
}

/** Every import edge of one file. Throws with the file name on a parse error. */
export function importsOf(ws: Workspace, file: string): ImportEdge[] {
  const fromPkg = ws.ownerOf(file);
  if (fromPkg === undefined) return [];
  const source = readFileSync(file, 'utf8');
  const parsed = parser()(file, source, { sourceType: 'module' });
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
