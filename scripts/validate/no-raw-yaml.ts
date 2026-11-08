/**
 * The raw-YAML gate: no product code parses YAML with a reader of its own, outside the files the ledger names, and
 * nobody reaches such a reader without the ledger saying so.
 *
 * WHY. A hand-written YAML file is the most hostile input the daemon reads: one long string aliased many times made
 * `Bun.YAML.parse` of a 256 KiB `gate.yaml` take 2.3 s and 5.4 GB at every boot (kac2 review round 8), while the
 * kernel's own reader (`packages/core/kernel/host/config/yaml-text.ts`: the size cap, the alias budget by length, no
 * YAML 1.1 tags, duplicate keys in one pass) refused the same file in one linear pass. Every daemon-side reader of
 * text a person or an agent can write must go through that one reader — or through the value the kernel already
 * checked — so a new parse of its own is refused here until somebody says, in the ledger, why it is safe.
 *
 * WHY A PARSER. The first version matched lines with regular expressions, and review (kac2 round 9, m2) found each
 * way past it: an aliased import (`import { YAML as Y } from 'bun'`), a namespace import (`import * as B from 'bun'`),
 * a multi-line destructure, a member chain split across lines, a template-literal specifier, another YAML package,
 * and a call of an exported parser the ledger had allowed. This walks the syntax tree (`oxc-parser`: this repository's
 * `typescript` is the native compiler, which has no JavaScript API) and follows names the way the language does.
 *
 * WHAT COUNTS, in every tracked product file under `packages/` that is not a test, a fixture or test support:
 * - any use of Bun's `YAML` but its `stringify` (writing YAML reads nothing), however it is reached: `Bun.YAML`,
 *   `Bun['YAML']`, `globalThis.Bun.YAML`, an import of `YAML` from `'bun'` under any name, a namespace/default/dynamic
 *   import or `require` of `'bun'` (then `.YAML`), a name bound to `Bun` (`const b = Bun`), a destructure out of any of
 *   these (any depth, any layout, a rest element, a computed key), and a computed key it cannot read;
 * - any `YAML.parse`-family member (`parse`, `parseDocument`, `load`, …) of a name that holds a YAML module;
 * - any import, re-export, dynamic import or `require` of a module whose bare name contains `yaml` (`yaml`,
 *   `js-yaml`, `@std/yaml`, `yamljs`, …), type-only imports included: they are the first step.
 *
 * THE LEDGER (`scripts/validate/raw-yaml-allowlist.txt`) has three kinds of line, each `… # reason`:
 * - `path  # reason`: the FILE may parse YAML itself;
 * - `path::name  <- caller.ts, other.ts  # reason`: an EXPORT of that file reaches a parse (its body calls one, or a
 *   function of the file that does). The callers are the only files that may import it — laundering a ledgered parser
 *   through a new importer is a use too. `<- *` (open to every caller) is the kernel's bounded reader alone: that
 *   file is the sanctioned door, and everybody else's parser is reached only by name;
 * - EXACT BOTH WAYS: a file that parses and is not listed fails; a listed file that no longer parses fails; an exported
 *   parser without a line fails; a line whose export, or whose listed caller, is gone fails; a line without a reason
 *   fails. So the ledger stays the true inventory of who can reach a raw parser.
 *
 * DECLARED GAPS (a tree walk is not an interpreter): a module specifier built at run time (`import(name)`), a name
 * passed through a call (`Reflect.get(Bun, 'YAML')`, `Object.values(Bun)`, a callback parameter other than the
 * `.then` of a `'bun'` import), and a ledgered parser reached through a function of an allowed caller that itself is
 * exported (the caller's ledger line is the review; its own importers are not followed).
 *
 * Usage: `bun scripts/validate/no-raw-yaml.ts <repo root>`; exits 0 clean, 1 a violation, 2 a broken gate.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

export const LEDGER = 'scripts/validate/raw-yaml-allowlist.txt';

/** The kernel's bounded reader: the one file whose parsing exports are open to every caller. */
export const KERNEL_READER = 'packages/core/kernel/host/config/yaml-text.ts';

/** What a YAML module (or Bun's `YAML`) offers that reads text. `stringify` and the `is…` helpers read nothing. */
const PARSE_NAMES: ReadonlySet<string> = new Set([
  'parse',
  'parseAll',
  'parseDocument',
  'parseAllDocuments',
  'Parser',
  'Composer',
  'Lexer',
  'load',
  'loadAll',
  'safeLoad',
  'safeLoadAll',
  'parseFile',
]);

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window', 'global']);

/** A use of a YAML reader of its own, located. */
export interface RawYamlUse {
  readonly line: number;
  readonly text: string;
}

/** One module a file loads, as far as the code says: the names it takes, or all of them. */
export interface ImportEdge {
  readonly specifier: string;
  readonly line: number;
  readonly names: readonly string[] | 'all';
}

export interface FileFacts {
  /** Every raw-YAML use in the file. */
  readonly uses: readonly RawYamlUse[];
  /** The exported names whose body reaches a parse, sorted. */
  readonly parserExports: readonly string[];
  /** Every value import, re-export, dynamic import and `require` (type-only ones are erased and not listed). */
  readonly edges: readonly ImportEdge[];
  /** Set when the file would not parse: it is refused, never counted as clean. */
  readonly unparsable?: string;
}

/** Whether a tracked path is product code this gate covers (not a test, a fixture or test support). */
export function inScope(path: string): boolean {
  if (!path.startsWith('packages/') || !/\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path)) return false;
  if (/\.test\.[cm]?[jt]sx?$/u.test(path)) return false;
  return !path.split('/').some(part => part === 'tests' || part === 'testing' || part === 'fixtures');
}

/** A syntax-tree node as `oxc-parser` spells it: ESTree, with TypeScript's own node types beside. */
interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [field: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

/** Subtrees that only describe types: nothing in them runs. */
const TYPE_ONLY: ReadonlySet<string> = new Set([
  'TSTypeAnnotation',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSTypeQuery',
  'TSTypeReference',
  'TSTypeParameterDeclaration',
  'TSTypeParameterInstantiation',
  'TSDeclareFunction',
  'TSIndexSignature',
  'TSMethodSignature',
  'TSPropertySignature',
  'TSImportType',
]);

/** Expression wrappers that hold the same value. */
const TRANSPARENT: ReadonlySet<string> = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'AwaitExpression',
]);

/** The name a key or member spells STATICALLY — an identifier, a string, a template with no holes — else none. */
function staticName(node: unknown): string | undefined {
  if (!isNode(node)) return undefined;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasi = (node.quasis as Node[] | undefined)?.[0]?.value as { cooked?: unknown } | undefined;
    return typeof quasi?.cooked === 'string' ? quasi.cooked : undefined;
  }
  return undefined;
}

/** The name a member access spells: `a.b` and `a['b']` are `b`; `a[k]` is none. */
const memberName = (member: Node): string | undefined =>
  member.computed === true && isNode(member.property) && member.property.type === 'Identifier'
    ? undefined
    : staticName(member.property);

/** The name an object-pattern entry takes: `{ YAML }` and `{ ['YAML']: y }` are `YAML`; `{ [k]: y }` is none. */
const keyName = (property: Node): string | undefined =>
  property.computed === true && isNode(property.key) && property.key.type === 'Identifier'
    ? undefined
    : staticName(property.key);

/** A module specifier of a YAML library: bare (not a path) and with `yaml` in its name. */
const isYamlLibrary = (specifier: string): boolean => !/^[./]/u.test(specifier) && /yaml/iu.test(specifier);

/** Whether an identifier found under `parent.key` only NAMES something a declaration introduces. */
function declaresOnly(parent: Node | undefined, key: string): boolean {
  if (parent === undefined) return false;
  switch (parent.type) {
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
    case 'TSAbstractMethodDefinition':
    case 'TSAbstractPropertyDefinition':
      return key === 'key' && parent.computed !== true;
    case 'MemberExpression':
      return key === 'property' && parent.computed !== true;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return key === 'id' || key === 'params';
    case 'VariableDeclarator':
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'TSEnumMember':
    case 'TSModuleDeclaration':
      return key === 'id';
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return true;
    case 'ExportSpecifier':
      return key === 'exported';
    case 'ExportAllDeclaration':
      return true;
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label';
    case 'CatchClause':
      return key === 'param';
    default:
      return false;
  }
}

interface Visited {
  readonly node: Node;
  readonly parent: Node | undefined;
  readonly key: string;
}

type Holds = 'bun' | 'yaml' | 'parser';

/** The identifiers a pattern binds (not the defaults and computed keys inside it, which run). */
function bindingsOf(pattern: unknown, into: Node[]): void {
  if (!isNode(pattern)) return;
  switch (pattern.type) {
    case 'Identifier':
      into.push(pattern);
      return;
    case 'ObjectPattern':
      for (const property of (pattern.properties as Node[] | undefined) ?? [])
        bindingsOf(property.type === 'RestElement' ? property.argument : property.value, into);
      return;
    case 'ArrayPattern':
      for (const element of (pattern.elements as unknown[] | undefined) ?? []) bindingsOf(element, into);
      return;
    case 'AssignmentPattern':
      bindingsOf(pattern.left, into);
      return;
    case 'RestElement':
      bindingsOf(pattern.argument, into);
      return;
    default:
  }
}

/** What the entry `name` of a value holding `kind` holds: Bun's `YAML`, a YAML module's parse functions, `default`. */
function entering(kind: Holds, name: string | undefined): Holds | undefined {
  if (kind === 'bun') return name === 'YAML' ? 'yaml' : name === 'default' ? 'bun' : undefined;
  if (kind === 'yaml')
    return name !== undefined && PARSE_NAMES.has(name) ? 'parser' : name === 'default' ? 'yaml' : undefined;
  return undefined;
}

/** What one file does about YAML: its uses, the exports that reach a parse, and the modules it loads. */
export function scanFile(path: string, text: string): FileFacts {
  const lang = /\.tsx$/u.test(path) ? 'tsx' : /\.jsx$/u.test(path) ? 'jsx' : /\.(?:[cm]?js)$/u.test(path) ? 'js' : 'ts';
  const parsed = parseSync(path, text, { lang, sourceType: 'module' });
  if (parsed.errors.length > 0)
    return { uses: [], parserExports: [], edges: [], unparsable: parsed.errors[0]?.message ?? 'parse error' };

  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
  const lineText = (line: number): string => text.slice(lineStarts[line - 1], lineStarts[line] ?? text.length).trim();

  // ---- the nodes, once: every pass below is a loop over this list.
  const nodes: Visited[] = [];
  const bound = new Set<Node>();
  const collect = (node: Node, parent: Node | undefined, key: string): void => {
    if (TYPE_ONLY.has(node.type)) return;
    nodes.push({ node, parent, key });
    if (node.type === 'VariableDeclarator') {
      const into: Node[] = [];
      bindingsOf(node.id, into);
      for (const id of into) bound.add(id);
    } else if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      const into: Node[] = [];
      for (const param of (node.params as unknown[] | undefined) ?? []) bindingsOf(param, into);
      for (const id of into) bound.add(id);
    } else if (node.type === 'CatchClause') {
      const into: Node[] = [];
      bindingsOf(node.param, into);
      for (const id of into) bound.add(id);
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (childKey === 'type' || childKey === 'start' || childKey === 'end') continue;
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) collect(item, node, childKey);
      } else if (isNode(value)) collect(value, node, childKey);
    }
  };
  collect(parsed.program as unknown as Node, undefined, 'program');

  // ---- what each local name holds. Seeds: the global `Bun`, and a global `YAML` (`YAML.parse(` was always refused).
  const bunNames = new Set<string>(['Bun']);
  const yamlNames = new Set<string>(['YAML']);
  const parserNames = new Set<string>();
  /** Names a YAML LIBRARY import binds: that import is the use, so a later reference is a site, not a second use. */
  const libraryNames = new Set<string>();
  /** Names bound to Bun's `YAML` object. */
  const bunYamlNames = new Set<string>();

  const specifierOf = (node: Node): string | undefined => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return staticName(node.source);
    if (node.type === 'ExportNamedDeclaration') return isNode(node.source) ? staticName(node.source) : undefined;
    if (node.type === 'ImportExpression') return staticName(node.source);
    if (node.type === 'TSImportEqualsDeclaration') {
      const reference = node.moduleReference;
      return isNode(reference) && reference.type === 'TSExternalModuleReference'
        ? staticName(reference.expression)
        : undefined;
    }
    if (node.type === 'CallExpression' && isNode(node.callee) && node.callee.type === 'Identifier') {
      if (node.callee.name !== 'require') return undefined;
      const [first] = (node.arguments as unknown[] | undefined) ?? [];
      return staticName(first);
    }
    return undefined;
  };

  /** What an expression holds, when it holds Bun, a YAML module, or a YAML parse function. */
  const holds = (expression: unknown): Holds | undefined => {
    if (!isNode(expression)) return undefined;
    if (TRANSPARENT.has(expression.type)) return holds(expression.expression ?? expression.argument);
    switch (expression.type) {
      case 'Identifier': {
        const name = expression.name as string;
        if (parserNames.has(name)) return 'parser';
        if (yamlNames.has(name)) return 'yaml';
        return bunNames.has(name) ? 'bun' : undefined;
      }
      case 'MemberExpression': {
        const object = isNode(expression.object) ? expression.object : undefined;
        const name = memberName(expression);
        if (object?.type === 'Identifier' && GLOBAL_OBJECTS.has(object.name as string))
          return name === 'Bun' ? 'bun' : name === 'YAML' ? 'yaml' : undefined;
        const inner = holds(object);
        if (inner === 'bun') return name === 'YAML' ? 'yaml' : name === 'default' ? 'bun' : undefined;
        if (inner === 'yaml')
          return name !== undefined && PARSE_NAMES.has(name) ? 'parser' : name === 'default' ? 'yaml' : undefined;
        return undefined;
      }
      case 'ImportExpression':
      case 'CallExpression': {
        const specifier = specifierOf(expression);
        if (specifier === 'bun') return 'bun';
        return specifier !== undefined && isYamlLibrary(specifier) ? 'yaml' : undefined;
      }
      case 'ConditionalExpression':
        return holds(expression.consequent) ?? holds(expression.alternate);
      case 'LogicalExpression':
        return holds(expression.left) ?? holds(expression.right);
      case 'AssignmentExpression':
        return holds(expression.right);
      case 'SequenceExpression':
        return holds((expression.expressions as unknown[] | undefined)?.at(-1));
      default:
        return undefined;
    }
  };

  const remember = (name: string, kind: Holds | undefined, viaLibrary = false): boolean => {
    if (kind === undefined) return false;
    const set = kind === 'bun' ? bunNames : kind === 'yaml' ? yamlNames : parserNames;
    let changed = !set.has(name);
    set.add(name);
    if (viaLibrary && !libraryNames.has(name)) {
      libraryNames.add(name);
      changed = true;
    }
    return changed;
  };

  /** Names a pattern takes out of a value that holds `kind`; true when a name was new. */
  const takeOut = (pattern: unknown, kind: Holds | undefined): boolean => {
    if (!isNode(pattern) || kind === undefined) return false;
    let changed = false;
    if (pattern.type === 'Identifier') return remember(pattern.name as string, kind);
    if (pattern.type === 'AssignmentPattern') return takeOut(pattern.left, kind);
    if (pattern.type === 'ObjectPattern') {
      for (const property of (pattern.properties as Node[] | undefined) ?? []) {
        if (property.type === 'RestElement') {
          changed = takeOut(property.argument, kind) || changed;
          continue;
        }
        const name = keyName(property);
        const inner = kind === 'parser' ? undefined : entering(kind, name);
        if (inner === 'yaml' && kind === 'bun' && property.value !== undefined) {
          const into: Node[] = [];
          bindingsOf(property.value, into);
          for (const id of into) {
            bunYamlNames.add(id.name as string);
          }
        }
        changed = takeOut(property.value, inner) || changed;
      }
    }
    return changed;
  };

  // Imports first, then the bindings those lead to, until nothing new is learned.
  for (const { node } of nodes) {
    if (node.type !== 'ImportDeclaration') continue;
    const specifier = staticName(node.source);
    if (specifier === undefined) continue;
    const library = isYamlLibrary(specifier);
    if (specifier !== 'bun' && !library) continue;
    for (const specifierNode of (node.specifiers as Node[] | undefined) ?? []) {
      const local = staticName(specifierNode.local);
      if (local === undefined) continue;
      if (specifierNode.type !== 'ImportSpecifier') {
        remember(local, specifier === 'bun' ? 'bun' : 'yaml', library);
        continue;
      }
      const imported = staticName(specifierNode.imported);
      if (specifier === 'bun') {
        if (imported === 'YAML') {
          remember(local, 'yaml');
          bunYamlNames.add(local);
        }
      } else if (imported !== undefined && PARSE_NAMES.has(imported)) remember(local, 'parser', true);
      else if (imported === 'default') remember(local, 'yaml', true);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const { node } of nodes) {
      if (node.type === 'VariableDeclarator' && node.init !== null && node.init !== undefined)
        changed = takeOut(node.id, holds(node.init)) || changed;
      else if (node.type === 'AssignmentExpression' && node.operator === '=')
        changed = takeOut(node.left, holds(node.right)) || changed;
    }
  }

  // ---- the uses and the parse sites.
  const useLines = new Map<number, RawYamlUse>();
  const sites: number[] = [];
  const refs: { readonly name: string; readonly start: number }[] = [];
  const edges: ImportEdge[] = [];
  const use = (node: Node, site = true): void => {
    const line = lineOf(node.start);
    if (!useLines.has(line)) useLines.set(line, { line, text: lineText(line) });
    if (site) sites.push(node.start);
  };
  const isStringify = (parent: Node | undefined, key: string): boolean =>
    parent?.type === 'MemberExpression' && key === 'object' && memberName(parent) === 'stringify';

  /** A pattern taking entries out of Bun or of a YAML module: a use for each entry that reads, at any depth. */
  const checkPattern = (pattern: Node, kind: 'bun' | 'yaml'): void => {
    for (const property of (pattern.properties as Node[] | undefined) ?? []) {
      const name = property.type === 'RestElement' ? undefined : keyName(property);
      const reads =
        kind === 'bun' ? name === 'YAML' || name === undefined : name === undefined || PARSE_NAMES.has(name);
      if (reads) use(property);
      const inner = name === undefined ? undefined : entering(kind, name);
      const value = property.value;
      if (isNode(value) && value.type === 'ObjectPattern' && (inner === 'bun' || inner === 'yaml'))
        checkPattern(value, inner);
    }
  };

  for (const { node, parent, key } of nodes) {
    const specifier = specifierOf(node);
    if (specifier !== undefined) {
      if (isYamlLibrary(specifier)) use(node, false);
      if (specifier === 'bun' && node.type === 'ExportAllDeclaration') use(node, false);
      if (specifier === 'bun' && node.type === 'ExportNamedDeclaration')
        for (const exported of (node.specifiers as Node[] | undefined) ?? [])
          if (staticName(exported.local) === 'YAML') use(exported, false);
    }
    if (node.type === 'Identifier') {
      if (declaresOnly(parent, key) || bound.has(node)) continue;
      const name = node.name as string;
      refs.push({ name, start: node.start });
      if (parserNames.has(name)) {
        if (!libraryNames.has(name)) use(node);
        else sites.push(node.start);
      } else if (yamlNames.has(name) && !(parent?.type === 'MemberExpression' && key === 'object')) {
        // A YAML module handed on whole (`export { Y }`, `f(Y)`): anything may then be read through it.
        if (isStringify(parent, key)) continue;
        if (libraryNames.has(name)) sites.push(node.start);
        else use(node);
      }
      continue;
    }
    if (node.type === 'MemberExpression') {
      const kind = holds(node.object);
      const name = memberName(node);
      if (kind === 'bun') {
        if ((name === 'YAML' || name === undefined) && !isStringify(parent, key)) use(node);
        else if (name === 'then') use(node, false);
      } else if (kind === 'yaml' && (name === undefined || PARSE_NAMES.has(name))) use(node);
      continue;
    }
    if (node.type === 'ObjectPattern') {
      // A destructure of Bun or of a YAML module: written as a declaration or as an assignment.
      const source =
        parent?.type === 'VariableDeclarator' && key === 'id'
          ? parent.init
          : parent?.type === 'AssignmentExpression' && key === 'left'
            ? parent.right
            : undefined;
      const kind = holds(source);
      if (kind === 'bun' || kind === 'yaml') checkPattern(node, kind);
    }
  }

  // ---- the modules loaded (type-only ones are erased and cannot run).
  for (const { node } of nodes) {
    const specifier = specifierOf(node);
    if (specifier === undefined) continue;
    const line = lineOf(node.start);
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') continue;
      const names: string[] = [];
      let everything = false;
      for (const specifierNode of (node.specifiers as Node[] | undefined) ?? []) {
        if (specifierNode.type === 'ImportNamespaceSpecifier') everything = true;
        else if (specifierNode.type === 'ImportDefaultSpecifier') names.push('default');
        else if (specifierNode.importKind !== 'type') names.push(staticName(specifierNode.imported) ?? '');
      }
      if (everything) edges.push({ specifier, line, names: 'all' });
      else if (names.length > 0) edges.push({ specifier, line, names });
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type') continue;
      const names = ((node.specifiers as Node[] | undefined) ?? [])
        .filter(item => item.exportKind !== 'type')
        .map(item => staticName(item.local) ?? '');
      if (names.length > 0) edges.push({ specifier, line, names });
    } else edges.push({ specifier, line, names: 'all' });
  }

  // ---- the exports that reach a parse: a top-level declaration holds a site, or names one that does.
  interface Declaration {
    readonly name: string;
    readonly start: number;
    readonly end: number;
  }
  const declarations: Declaration[] = [];
  const exported: { readonly exportName: string; readonly local: string | Declaration }[] = [];
  const declare = (statement: Node): readonly string[] => {
    const names: string[] = [];
    if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && isNode(statement.id)) {
      declarations.push({ name: statement.id.name as string, start: statement.start, end: statement.end });
      names.push(statement.id.name as string);
    } else if (statement.type === 'VariableDeclaration') {
      for (const declarator of (statement.declarations as Node[] | undefined) ?? []) {
        const into: Node[] = [];
        bindingsOf(declarator.id, into);
        for (const id of into) {
          declarations.push({ name: id.name as string, start: declarator.start, end: declarator.end });
          names.push(id.name as string);
        }
      }
    }
    return names;
  };
  for (const statement of ((parsed.program as unknown as Node).body as Node[] | undefined) ?? []) {
    if (statement.type === 'ExportNamedDeclaration') {
      if (statement.exportKind === 'type') continue;
      if (isNode(statement.declaration))
        for (const name of declare(statement.declaration)) exported.push({ exportName: name, local: name });
      else if (!isNode(statement.source))
        for (const item of (statement.specifiers as Node[] | undefined) ?? []) {
          const local = staticName(item.local);
          const exportName = staticName(item.exported);
          if (local !== undefined && exportName !== undefined && item.exportKind !== 'type')
            exported.push({ exportName, local });
        }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = statement.declaration as Node;
      if (declaration.type === 'Identifier')
        exported.push({ exportName: 'default', local: declaration.name as string });
      else {
        declare(declaration);
        exported.push({
          exportName: 'default',
          local: { name: 'default', start: declaration.start, end: declaration.end },
        });
      }
    } else declare(statement);
  }
  const within = (declaration: Declaration, offset: number): boolean =>
    offset >= declaration.start && offset < declaration.end;
  const reaching = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const declaration of declarations) {
      if (reaching.has(declaration.name)) continue;
      if (
        sites.some(site => within(declaration, site)) ||
        refs.some(ref => reaching.has(ref.name) && within(declaration, ref.start))
      ) {
        reaching.add(declaration.name);
        changed = true;
      }
    }
  }
  const parserExports = new Set<string>();
  for (const item of exported) {
    const reaches =
      typeof item.local === 'string'
        ? reaching.has(item.local)
        : sites.some(site => within(item.local as Declaration, site)) ||
          refs.some(ref => reaching.has(ref.name) && within(item.local as Declaration, ref.start));
    if (reaches) parserExports.add(item.exportName);
  }

  return {
    uses: [...useLines.values()].sort((a, b) => a.line - b.line),
    parserExports: [...parserExports].sort(),
    edges,
  };
}

/** One ledger line for an export: who may import it. */
export interface ExportEntry {
  readonly callers: readonly string[] | '*';
  readonly reason: string;
}

/** The ledger: files that may parse, exports that reach a parse, and what is wrong with the text. */
export function parseLedger(text: string): {
  readonly files: ReadonlyMap<string, string>;
  readonly exports: ReadonlyMap<string, ExportEntry>;
  readonly problems: readonly string[];
} {
  const files = new Map<string, string>();
  const exports = new Map<string, ExportEntry>();
  const problems: string[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const where = `${LEDGER}:${String(index + 1)}`;
    const match = /^(\S+)\s+(?:<-\s+(.+?)\s+)?#\s*(\S.*)$/u.exec(line);
    if (match === null) {
      problems.push(`${where}: every entry is "path  # reason" or "path::export  <- callers  # reason"`);
      return;
    }
    const [, subject, callerText, reason] = match as unknown as [string, string, string | undefined, string];
    const [path = '', name, ...extra] = subject.split('::');
    if (name === undefined) {
      if (callerText !== undefined) problems.push(`${where}: a file line has no callers; name an export: path::export`);
      if (files.has(path)) problems.push(`${where}: ${path} is listed twice`);
      files.set(path, reason);
      return;
    }
    if (extra.length > 0 || name === '') {
      problems.push(`${where}: "${subject}" is not path::export`);
      return;
    }
    if (exports.has(subject)) problems.push(`${where}: ${subject} is listed twice`);
    const callers = callerText === undefined ? [] : callerText.split(',').map(item => item.trim());
    if (callers.some(caller => caller === '')) problems.push(`${where}: an empty caller in "${callerText ?? ''}"`);
    if (callers.includes('*') && callers.length > 1) problems.push(`${where}: "*" stands alone`);
    if (callers.includes('*') && path !== KERNEL_READER)
      problems.push(`${where}: only ${KERNEL_READER} is open to every caller; list the callers of ${subject}`);
    exports.set(subject, { callers: callers.includes('*') ? '*' : callers, reason });
  });
  return { files, exports, problems };
}

/** The ledgered file a relative specifier lands on, if it lands on one. */
function resolveSpecifier(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  for (const candidate of [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].flatMap(ext => [`${stem}${ext}`, `${base}${ext}`]),
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ])
    if (known.has(candidate)) return candidate;
  return undefined;
}

const useMessage = (path: string, use: RawYamlUse): string =>
  `${path}:${String(use.line)}: a YAML reader of its own (${use.text}). Read the text with the kernel's ` +
  'bounded reader (or the value the kernel checked), or list the file in the ledger with why it is safe';

/** Every finding over the given files and ledger. Pure: the tests drive it with planted files. */
export function findings(
  files: readonly { readonly path: string; readonly text: string }[],
  ledgerText: string,
): readonly string[] {
  const ledger = parseLedger(ledgerText);
  const found: string[] = [...ledger.problems];
  const facts = new Map<string, FileFacts>();
  for (const file of files) {
    if (!inScope(file.path)) continue;
    const scanned = scanFile(file.path, file.text);
    if (scanned.unparsable !== undefined) {
      found.push(`${file.path}: would not parse, so its YAML reading cannot be checked: ${scanned.unparsable}`);
      continue;
    }
    facts.set(file.path, scanned);
  }

  // 1. A file that parses is listed, and a listed file parses.
  for (const [path, scanned] of facts)
    if (scanned.uses.length > 0 && !ledger.files.has(path))
      for (const item of scanned.uses) found.push(useMessage(path, item));
  for (const path of ledger.files.keys())
    if ((facts.get(path)?.uses.length ?? 0) === 0)
      found.push(`${LEDGER}: ${path} no longer parses YAML itself; remove its line`);

  // 2. A listed file names each export that reaches a parse, and each named export still does.
  for (const path of ledger.files.keys())
    for (const name of facts.get(path)?.parserExports ?? [])
      if (!ledger.exports.has(`${path}::${name}`))
        found.push(
          `${path}: exports ${name}, which reaches a raw YAML parse. List it: "${path}::${name}  <- callers  # reason"`,
        );
  for (const key of ledger.exports.keys()) {
    const [path = '', name = ''] = key.split('::');
    if (!ledger.files.has(path))
      found.push(`${LEDGER}: ${key} belongs to a file the ledger does not list; list ${path} first`);
    else if (!(facts.get(path)?.parserExports ?? []).includes(name))
      found.push(`${LEDGER}: ${key} no longer reaches a raw YAML parse (or is no longer exported); remove its line`);
  }

  // 3. Whoever loads a ledgered parser is a caller the ledger names: laundering is a use too.
  const known = new Set(ledger.files.keys());
  const called = new Set<string>();
  for (const [caller, scanned] of facts)
    for (const edge of scanned.edges) {
      const target = resolveSpecifier(caller, edge.specifier, known);
      if (target === undefined || target === caller) continue;
      const parsers = facts.get(target)?.parserExports ?? [];
      for (const name of edge.names === 'all' ? parsers : edge.names.filter(item => parsers.includes(item))) {
        const key = `${target}::${name}`;
        const entry = ledger.exports.get(key);
        if (entry === undefined) continue; // said in step 2
        if (entry.callers === '*') continue;
        called.add(`${key}<-${caller}`);
        if (!entry.callers.includes(caller))
          found.push(
            `${caller}:${String(edge.line)}: loads ${key}, a raw YAML parser the ledger does not open to it. ` +
              "Read the text with the kernel's bounded reader, or add the caller to that ledger line",
          );
      }
    }
  for (const [key, entry] of ledger.exports)
    if (entry.callers !== '*')
      for (const caller of entry.callers)
        if (!called.has(`${key}<-${caller}`))
          found.push(`${LEDGER}: ${caller} no longer loads ${key}; remove it from that line`);
  return found;
}

function main(root: string): number {
  const listed = spawnSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) {
    console.error('❌ git ls-files failed');
    return 2;
  }
  let ledgerText: string;
  try {
    ledgerText = readFileSync(resolve(root, LEDGER), 'utf8');
  } catch {
    console.error(`❌ missing ledger: ${LEDGER}`);
    return 2;
  }
  const files = listed.stdout
    .split('\0')
    .filter(path => path !== '' && inScope(path))
    .flatMap(path => {
      try {
        return [{ path, text: readFileSync(resolve(root, path), 'utf8') }];
      } catch {
        // Tracked but deleted in the working tree: nothing to read.
        return [];
      }
    });
  const found = findings(files, ledgerText);
  for (const finding of found) console.error(`❌ ${finding}`);
  return found.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main(resolve(process.argv[2] ?? '.')));
