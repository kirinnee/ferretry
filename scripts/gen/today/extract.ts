/**
 * Extracts TODAY's route, socket, member-route and agent-tool descriptor tables from a read-only
 * checkout of the reference tree, as one JSON fixture (`routes.json`), so the descriptor-parity check
 * can compare a 5.0 manifest against what 4.x serves.
 *
 * A real AST pass (`oxc-parser`), never a grep: a path inside a doc comment is not a route.
 *
 * ## WHAT IT READS
 *
 * - ROUTES / SOCKETS — every object literal that carries `method` + `path` + `minimum` in
 *   `packages/daemon/src/lib/{runtime/mounts,api/routes,catalog-members}`. One that also carries
 *   `accept` is a socket route (the protocol-switching table); the rest are request/response routes.
 * - MEMBER ROUTES — `method` + `path` + `needs: 'key' | 'unlocked'` (`SharedRoute`), which have no
 *   credential minimum; they are served to a catalog member, not to a credential class.
 * - TOOLS — every object literal with `name` + `description` + `inputSchema` in
 *   `packages/cli/src/lib/mcp` (the MCP tool table an agent is shown).
 *
 * Today's tables lean on shared constants and spreads (`{ ...USE, method, path }` with
 * `const USE = { minimum, caller, capability, noStore }`), so a literal value is resolved through
 * same-file and imported `const` declarations, block scopes included. A value that cannot be resolved
 * (a call, a parameter, a package import) is written `unresolved:<source text>` and its row is listed
 * on stderr so it is visible.
 *
 * Usage: `bun scripts/gen/today/extract.ts --ref <checkout> --out <routes.json> [--source <sha>]`
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

// ─── output shape ─────────────────────────────────────────────────────────────────────────────

export type TableName = 'member' | 'route' | 'socket' | 'tool';

export interface CapabilityRow {
  capability: string;
  axis: string;
  narrowing?: true;
}

export interface Row {
  table: TableName;
  key: string;
  minimum?: string;
  caller?: string;
  ferretDoor?: true;
  privilegedOnly?: true;
  unlockExempt?: true;
  capability?: CapabilityRow | string;
  consultsGrants?: true;
  wardenRemedy?: string;
  noStore?: boolean | string;
  compress?: true;
  precedence?: number | string;
  available?: true;
  member?: string;
  catalog?: string;
  /** Tools only: the wire name the daemon knows the tool by (`terminal.read` for `terminal_read`). */
  wire?: string;
  from: string;
}

export interface Fixture {
  format: 1;
  source: string;
  rows: Row[];
}

export interface ExtractResult {
  fixture: Fixture;
  /** One line per row that holds an unresolved value, for stderr. */
  unresolved: string[];
  /** `method` + `path` objects that carry neither `minimum` nor `needs`: not a table row. */
  skipped: string[];
}

// ─── layout of today's code ───────────────────────────────────────────────────────────────────

/** Directories holding route-table declarations; the same set `scripts/validate/route-agreement.ts` reads. */
export const ROUTE_DIRECTORIES = [
  'packages/daemon/src/lib/api/routes',
  'packages/daemon/src/lib/runtime/mounts',
  'packages/daemon/src/lib/catalog-members',
] as const;

/** Directories holding the MCP tool table. */
export const TOOL_DIRECTORIES = ['packages/cli/src/lib/mcp'] as const;

const HTTP_VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

// ─── AST access ───────────────────────────────────────────────────────────────────────────────

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

const children = (node: Node, key: string): readonly Node[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const nameOf = (node: Node): string | undefined =>
  node.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;

/** A property key as text: `foo`, `'foo'`. A computed key is not one. */
function keyName(property: Node): string | undefined {
  if (property.computed === true) return undefined;
  const key = child(property, 'key');
  if (key === undefined) return undefined;
  if (key.type === 'Identifier') return nameOf(key);
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

/** Looks through the type-only wrappers that never change a value. */
function unwrap(node: Node): Node {
  let current = node;
  for (;;) {
    if (
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression'
    ) {
      const inner = child(current, 'expression');
      if (inner === undefined) return current;
      current = inner;
    } else return current;
  }
}

// ─── files and scopes ─────────────────────────────────────────────────────────────────────────

type Scope = ReadonlyMap<string, Node>;

interface Binding {
  readonly from: string;
  readonly imported: string;
}

interface SourceFile {
  readonly path: string;
  readonly source: string;
  readonly program: Node;
  readonly top: Scope;
  readonly imports: ReadonlyMap<string, Binding>;
  /** `export { a as b }` and `export { x as y } from '…'`: exported name → local name or a re-export. */
  readonly exports: ReadonlyMap<string, string | Binding>;
  readonly lineStarts: readonly number[];
}

/** Where a name is read: a file, and the scopes (outermost first) visible at that point. */
interface Context {
  readonly file: SourceFile;
  readonly scopes: readonly Scope[];
}

function constsDirectlyIn(statements: readonly Node[]): Scope {
  const found = new Map<string, Node>();
  for (const statement of statements) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? (child(statement, 'declaration') ?? statement) : statement;
    if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const declarator of children(declaration, 'declarations')) {
      const id = child(declarator, 'id');
      const init = child(declarator, 'init');
      const name = id === undefined ? undefined : nameOf(id);
      if (name !== undefined && init !== undefined) found.set(name, init);
    }
  }
  return found;
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === '\n') starts.push(index + 1);
  return starts;
}

function lineOf(file: SourceFile, offset: number): number {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((file.lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function importsOf(program: Node): Map<string, Binding> {
  const imports = new Map<string, Binding>();
  for (const statement of children(program, 'body')) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = child(statement, 'source');
    const from = source !== undefined && typeof source.value === 'string' ? source.value : undefined;
    if (from === undefined) continue;
    for (const specifier of children(statement, 'specifiers')) {
      const local = child(specifier, 'local');
      const localName = local === undefined ? undefined : nameOf(local);
      if (localName === undefined) continue;
      if (specifier.type === 'ImportSpecifier') {
        const imported = child(specifier, 'imported');
        const importedName =
          imported === undefined
            ? undefined
            : (nameOf(imported) ?? (typeof imported.value === 'string' ? imported.value : undefined));
        if (importedName !== undefined) imports.set(localName, { from, imported: importedName });
      }
    }
  }
  return imports;
}

function exportsOf(program: Node): Map<string, string | Binding> {
  const exported = new Map<string, string | Binding>();
  for (const statement of children(program, 'body')) {
    if (statement.type !== 'ExportNamedDeclaration' || child(statement, 'declaration') !== undefined) continue;
    const source = child(statement, 'source');
    const from = source !== undefined && typeof source.value === 'string' ? source.value : undefined;
    for (const specifier of children(statement, 'specifiers')) {
      const local = child(specifier, 'local');
      const outer = child(specifier, 'exported');
      const localName = local === undefined ? undefined : (nameOf(local) ?? String(local.value));
      const outerName = outer === undefined ? undefined : (nameOf(outer) ?? String(outer.value));
      if (localName === undefined || outerName === undefined) continue;
      exported.set(outerName, from === undefined ? localName : { from, imported: localName });
    }
  }
  return exported;
}

class Workspace {
  readonly #files = new Map<string, SourceFile | null>();

  constructor(readonly root: string) {}

  load(path: string): SourceFile | undefined {
    const cached = this.#files.get(path);
    if (cached !== undefined) return cached ?? undefined;
    let loaded: SourceFile | null = null;
    if (existsSync(path) && statSync(path).isFile()) {
      const source = readFileSync(path, 'utf8');
      const parsed = parseSync(path, source, { lang: 'ts' });
      const program = parsed.program as unknown as Node;
      loaded = {
        path,
        source,
        program,
        top: constsDirectlyIn(children(program, 'body')),
        imports: importsOf(program),
        exports: exportsOf(program),
        lineStarts: lineStartsOf(source),
      };
    }
    this.#files.set(path, loaded);
    return loaded ?? undefined;
  }

  /** The file a relative specifier names, trying the extensions this repository writes. */
  resolveModule(from: SourceFile, specifier: string): SourceFile | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = resolve(dirname(from.path), specifier);
    const candidates = [base, `${base}.ts`, join(base, 'index.ts'), base.replace(/\.js$/u, '.ts')];
    for (const candidate of candidates) {
      const file = existsSync(candidate) && statSync(candidate).isFile() ? this.load(candidate) : undefined;
      if (file !== undefined) return file;
    }
    return undefined;
  }

  /** An exported `const` by its exported name, following `export { … }` and re-exports. */
  exportedConst(file: SourceFile, name: string, depth = 0): Located | undefined {
    if (depth > 8) return undefined;
    const direct = file.top.get(name);
    const renamed = file.exports.get(name);
    if (renamed === undefined) return direct === undefined ? undefined : { init: direct, context: topContext(file) };
    if (typeof renamed === 'string') {
      const init = file.top.get(renamed);
      return init === undefined ? undefined : { init, context: topContext(file) };
    }
    const target = this.resolveModule(file, renamed.from);
    return target === undefined ? undefined : this.exportedConst(target, renamed.imported, depth + 1);
  }
}

const topContext = (file: SourceFile): Context => ({ file, scopes: [file.top] });

interface Located {
  readonly init: Node;
  readonly context: Context;
}

// ─── value resolution ─────────────────────────────────────────────────────────────────────────

/** An object's properties by name, each with the context its value is read in. */
type Properties = Map<string, Located>;

type Resolved =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'object'; readonly properties: Properties }
  | { readonly kind: 'unresolved'; readonly text: string };

const textOf = (context: Context, node: Node): string =>
  context.file.source.slice(node.start, node.end).replace(/\s+/gu, ' ').trim();

const unresolved = (context: Context, node: Node): Resolved => ({ kind: 'unresolved', text: textOf(context, node) });

class Resolver {
  constructor(private readonly workspace: Workspace) {}

  /** The `const` a bare name stands for at this point: nearest block scope outward, then an import. */
  lookup(context: Context, name: string): Located | undefined {
    for (let index = context.scopes.length - 1; index >= 0; index -= 1) {
      const init = context.scopes[index]?.get(name);
      if (init !== undefined)
        return { init, context: { file: context.file, scopes: context.scopes.slice(0, index + 1) } };
    }
    const binding = context.file.imports.get(name);
    if (binding === undefined) return undefined;
    const target = this.workspace.resolveModule(context.file, binding.from);
    return target === undefined ? undefined : this.workspace.exportedConst(target, binding.imported);
  }

  resolve(node: Node, context: Context, depth = 0): Resolved {
    if (depth > 24) return unresolved(context, node);
    const inner = unwrap(node);
    switch (inner.type) {
      case 'Literal': {
        if (typeof inner.value === 'string') return { kind: 'string', value: inner.value };
        if (typeof inner.value === 'number') return { kind: 'number', value: inner.value };
        if (typeof inner.value === 'boolean') return { kind: 'boolean', value: inner.value };
        return unresolved(context, inner);
      }
      case 'TemplateLiteral':
        return this.#template(inner, context, depth);
      case 'BinaryExpression': {
        const left = child(inner, 'left');
        const right = child(inner, 'right');
        if (inner.operator !== '+' || left === undefined || right === undefined) return unresolved(context, inner);
        const a = this.resolve(left, context, depth + 1);
        const b = this.resolve(right, context, depth + 1);
        return a.kind === 'string' && b.kind === 'string'
          ? { kind: 'string', value: a.value + b.value }
          : unresolved(context, inner);
      }
      case 'Identifier': {
        const name = nameOf(inner);
        const located = name === undefined ? undefined : this.lookup(context, name);
        return located === undefined
          ? unresolved(context, inner)
          : this.resolve(located.init, located.context, depth + 1);
      }
      case 'MemberExpression': {
        const object = child(inner, 'object');
        const property = child(inner, 'property');
        if (object === undefined || property === undefined) return unresolved(context, inner);
        const key =
          inner.computed === true
            ? property.type === 'Literal'
              ? String(property.value)
              : undefined
            : nameOf(property);
        const base = this.resolve(object, context, depth + 1);
        if (key === undefined || base.kind !== 'object') return unresolved(context, inner);
        const member = base.properties.get(key);
        return member === undefined ? unresolved(context, inner) : this.resolve(member.init, member.context, depth + 1);
      }
      case 'ObjectExpression':
        return { kind: 'object', properties: this.properties(inner, context, depth + 1).properties };
      default:
        return unresolved(context, inner);
    }
  }

  #template(node: Node, context: Context, depth: number): Resolved {
    const quasis = children(node, 'quasis');
    const expressions = children(node, 'expressions');
    let value = '';
    for (let index = 0; index < quasis.length; index += 1) {
      const text = (quasis[index] as Node).value as { cooked?: unknown } | undefined;
      value += typeof text?.cooked === 'string' ? text.cooked : '';
      const expression = expressions[index];
      if (expression === undefined) continue;
      const part = this.resolve(expression, context, depth + 1);
      if (part.kind === 'string') value += part.value;
      else if (part.kind === 'number' || part.kind === 'boolean') value += String(part.value);
      else return unresolved(context, node);
    }
    return { kind: 'string', value };
  }

  /** The properties an object literal ends with, spreads resolved through constants; later keys win. */
  properties(node: Node, context: Context, depth = 0): { properties: Properties; openSpread: string[] } {
    const properties: Properties = new Map();
    const openSpread: string[] = [];
    for (const member of children(node, 'properties')) {
      if (member.type === 'SpreadElement') {
        const argument = child(member, 'argument');
        const spread = argument === undefined ? undefined : this.resolve(argument, context, depth + 1);
        if (spread?.kind === 'object') for (const [key, located] of spread.properties) properties.set(key, located);
        else openSpread.push(argument === undefined ? '...?' : `...${textOf(context, argument)}`);
        continue;
      }
      if (member.type !== 'Property') continue;
      const key = keyName(member);
      const value = child(member, 'value');
      if (key !== undefined && value !== undefined) properties.set(key, { init: value, context });
    }
    return { properties, openSpread };
  }
}

// ─── walking ──────────────────────────────────────────────────────────────────────────────────

interface Found {
  readonly node: Node;
  readonly context: Context;
}

/** Every object literal in a file, each with the block scopes visible where it is written. */
function objectLiterals(file: SourceFile): Found[] {
  const found: Found[] = [];
  const visit = (node: Node, scopes: readonly Scope[]): void => {
    let here = scopes;
    if (node.type === 'BlockStatement' || node.type === 'StaticBlock')
      here = [...scopes, constsDirectlyIn(children(node, 'body'))];
    if (node.type === 'ObjectExpression') found.push({ node, context: { file, scopes: here } });
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      if (Array.isArray(value)) for (const item of value) if (isNode(item)) visit(item, here);
      if (isNode(value)) visit(value, here);
    }
  };
  visit(file.program, [file.top]);
  return found;
}

function sourceFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts'))
      out.push(path);
  }
  return out;
}

// ─── rows ─────────────────────────────────────────────────────────────────────────────────────

const unresolvedText = (text: string): string => `unresolved:${text}`;

class RowBuilder {
  readonly unresolved: string[] = [];

  constructor(
    private readonly resolver: Resolver,
    private readonly root: string,
  ) {}

  #where(file: SourceFile, node: Node): string {
    return `${relative(this.root, file.path)}:${String(lineOf(file, node.start))}`;
  }

  /** A scalar field as text, or the `unresolved:` marker (recorded against the row). */
  #string(located: Located | undefined, noted: string[], field: string): string | undefined {
    if (located === undefined) return undefined;
    const value = this.resolver.resolve(located.init, located.context);
    if (value.kind === 'string') return value.value;
    if (value.kind === 'number' || value.kind === 'boolean') return String(value.value);
    noted.push(field);
    return unresolvedText(value.kind === 'unresolved' ? value.text : textOf(located.context, located.init));
  }

  /** A field whose literal value is `true`: present means `true`; anything else resolvable means absent. */
  #flag(located: Located | undefined, noted: string[], field: string): boolean | string | undefined {
    if (located === undefined) return undefined;
    const value = this.resolver.resolve(located.init, located.context);
    if (value.kind === 'boolean') return value.value;
    noted.push(field);
    return unresolvedText(value.kind === 'unresolved' ? value.text : textOf(located.context, located.init));
  }

  #capability(located: Located | undefined, noted: string[]): CapabilityRow | string | undefined {
    if (located === undefined) return undefined;
    const value = this.resolver.resolve(located.init, located.context);
    if (value.kind !== 'object') {
      noted.push('capability');
      return unresolvedText(value.kind === 'unresolved' ? value.text : textOf(located.context, located.init));
    }
    const capability = this.#string(value.properties.get('capability'), noted, 'capability.capability');
    const axis = this.#string(value.properties.get('axis'), noted, 'capability.axis');
    const narrowing = this.#flag(value.properties.get('narrowing'), noted, 'capability.narrowing');
    return {
      capability: capability ?? unresolvedText('(missing)'),
      axis: axis ?? unresolvedText('(missing)'),
      ...(narrowing === true ? { narrowing: true as const } : {}),
    };
  }

  /** The row an object literal declares, or `undefined` when it declares none of the tables. */
  route(found: Found): { row?: Row; skipped?: string } {
    const { node, context } = found;
    const { properties, openSpread } = this.resolver.properties(node, context);
    const method = properties.get('method');
    const path = properties.get('path');
    if (method === undefined || path === undefined) return {};
    const where = this.#where(context.file, node);
    const isMember = properties.has('needs');
    if (!properties.has('minimum') && !isMember) return { skipped: where };

    const noted: string[] = [];
    const verb = this.#string(method, noted, 'method');
    const route = this.#string(path, noted, 'path');
    const table: TableName = isMember ? 'member' : properties.has('accept') ? 'socket' : 'route';

    const row: Row = { table, key: `${verb ?? '?'} ${route ?? '?'}`, from: where };
    const set = <K extends keyof Row>(name: K, value: Row[K] | undefined): void => {
      if (value !== undefined) row[name] = value;
    };
    set('minimum', this.#string(properties.get('minimum'), noted, 'minimum'));
    set('caller', this.#string(properties.get('caller'), noted, 'caller'));
    if (properties.has('ferretDoor')) row.ferretDoor = true;
    for (const flag of ['privilegedOnly', 'unlockExempt', 'consultsGrants', 'compress'] as const) {
      const value = this.#flag(properties.get(flag), noted, flag);
      if (value === true) row[flag] = true;
      else if (typeof value === 'string') (row as unknown as Record<string, unknown>)[flag] = value;
    }
    set('capability', this.#capability(properties.get('capability'), noted));
    set('wardenRemedy', this.#string(properties.get('wardenRemedy'), noted, 'wardenRemedy'));
    const noStore = this.#flag(properties.get('noStore'), noted, 'noStore');
    if (noStore !== undefined) row.noStore = noStore;
    const precedence = properties.get('precedence');
    if (precedence !== undefined) {
      const value = this.resolver.resolve(precedence.init, precedence.context);
      if (value.kind === 'number') row.precedence = value.value;
      else {
        noted.push('precedence');
        row.precedence = unresolvedText(textOf(precedence.context, precedence.init));
      }
    }
    if (properties.has('available')) row.available = true;
    if (isMember) set('member', this.#string(properties.get('needs'), noted, 'needs'));
    set('catalog', this.#string(properties.get('catalog'), noted, 'catalog'));

    for (const spread of openSpread) noted.push(spread);
    if (noted.length > 0) this.unresolved.push(`${where}  ${row.key}  [${noted.join(', ')}]`);
    return { row };
  }

  /** A tool: `name` + `description` + `inputSchema`, with its wire name from `tool` / `configTool` / `lessonTool`. */
  tool(found: Found): Row | undefined {
    const { node, context } = found;
    const { properties } = this.resolver.properties(node, context);
    const name = properties.get('name');
    if (name === undefined || !properties.has('description') || !properties.has('inputSchema')) return undefined;
    // A tool is named by a string literal; a shorthand `{ name, description, inputSchema }` that re-shapes
    // the table for the wire (server.ts) names nothing.
    const named = this.resolver.resolve(name.init, name.context);
    if (named.kind !== 'string') return undefined;
    const noted: string[] = [];
    const key = named.value;
    const where = this.#where(context.file, node);
    const row: Row = { table: 'tool', key, from: where };
    for (const field of ['tool', 'configTool', 'lessonTool']) {
      const wire = this.#string(properties.get(field), noted, field);
      if (wire !== undefined) row.wire = wire;
    }
    if (noted.length > 0) this.unresolved.push(`${where}  ${key}  [${noted.join(', ')}]`);
    return row;
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Extracts every table from a checkout. `source` is recorded verbatim (the checkout's commit). */
export function extract(root: string, source: string): ExtractResult {
  const workspace = new Workspace(root);
  const resolver = new Resolver(workspace);
  const builder = new RowBuilder(resolver, root);
  const rows: Row[] = [];
  const skipped: string[] = [];

  for (const directory of ROUTE_DIRECTORIES) {
    for (const path of sourceFilesUnder(join(root, directory))) {
      const file = workspace.load(path);
      if (file === undefined) continue;
      for (const found of objectLiterals(file)) {
        const result = builder.route(found);
        if (result.row !== undefined) rows.push(result.row);
        if (result.skipped !== undefined) skipped.push(result.skipped);
      }
    }
  }
  for (const directory of TOOL_DIRECTORIES) {
    for (const path of sourceFilesUnder(join(root, directory))) {
      const file = workspace.load(path);
      if (file === undefined) continue;
      for (const found of objectLiterals(file)) {
        const row = builder.tool(found);
        if (row !== undefined) rows.push(row);
      }
    }
  }

  rows.sort((a, b) => compare(a.table, b.table) || compare(a.key, b.key) || compare(a.from, b.from));
  return { fixture: { format: 1, source, rows }, unresolved: builder.unresolved, skipped };
}

// ─── command line ─────────────────────────────────────────────────────────────────────────────

function argument(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function commitOf(root: string): string | undefined {
  const run = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
  return run.exitCode === 0 ? run.stdout.toString().trim() : undefined;
}

function main(args: readonly string[]): number {
  const refArgument = argument(args, '--ref');
  const out = argument(args, '--out');
  if (refArgument === undefined || out === undefined) {
    console.error('usage: extract.ts --ref <reference checkout> --out <routes.json> [--source <sha>]');
    return 2;
  }
  const root = resolve(refArgument.replace(/^~(?=\/|$)/u, process.env.HOME ?? '~'));
  const source = argument(args, '--source') ?? commitOf(root);
  if (source === undefined) {
    console.error(`${root} is not a git checkout; pass --source <sha> to name what it is`);
    return 2;
  }
  const { fixture, unresolved, skipped } = extract(root, source);
  if (fixture.rows.length === 0) {
    console.error('no rows found: the extractor read nothing, so it refuses to write an empty fixture');
    return 2;
  }
  writeFileSync(resolve(out), `${JSON.stringify(fixture, null, 2)}\n`);

  const counts = new Map<TableName, number>();
  for (const row of fixture.rows) counts.set(row.table, (counts.get(row.table) ?? 0) + 1);
  console.error(
    `${String(fixture.rows.length)} rows (${(['route', 'socket', 'member', 'tool'] as const)
      .map(table => `${table} ${String(counts.get(table) ?? 0)}`)
      .join(
        ', ',
      )}); ${String(unresolved.length)} with unresolved values; ${String(skipped.length)} method+path objects skipped (no minimum/needs)`,
  );
  for (const line of unresolved) console.error(`unresolved: ${line}`);
  for (const line of skipped) console.error(`skipped (not a table row): ${line}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
