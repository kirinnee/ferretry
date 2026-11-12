/**
 * The scanner behind `scripts/gen/tests/fleet-link-callers.test.ts`: which production modules REACH a generic root link
 * operation (`RootHandle.linkTo`, `RootHandle.copyTree`).
 *
 * "Reach" means any of, in a module's own AST:
 *
 * - a member read: `root.linkTo`, `root?.linkTo`, `root['copyTree']`, `` root[`linkTo`] ``;
 * - a member read through a constant key: `const op = 'linkTo' as const; root[op]` (the constants are those declared in the
 *   same module with a plain string, `as const`, `satisfies` or a template with no holes);
 * - a destructuring of the name: `const { linkTo } = root`, `const { copyTree: copy } = root`, and the same through a
 *   constant computed key `const { [op]: link } = root`;
 * - FAIL CLOSED: a computed member read or computed destructuring whose key cannot be resolved (`root[name]`,
 *   `root[OPS.link]`, an imported constant) on a value this module types as a `RootHandle`, reported as
 *   {@link UNRESOLVED_OPERATION}. A key nothing here can read is a key that could be `linkTo`.
 *
 * Which values are "typed as a RootHandle" is syntactic, per module: a name (parameter, variable, property, class field)
 * annotated with the `RootHandle` type (or `as RootHandle`), and any name initialised from such a name (to a fixpoint).
 * The definitions of the operations themselves (`linkTo: async () => …` in an object, `linkTo(…): Promise<void>` in an
 * interface) are not member reads, so the kernel's host, testing host and contract need no exemption of their own.
 *
 * NOT handled (declared): a value that reaches a module as a `RootHandle` without that module naming the type (inferred
 * through a call, then indexed with an unresolvable key); reflection (`Reflect.get`, `Object.entries`); and a function
 * exported or re-exported from an allowed module under another name and called elsewhere (the allowed modules' own
 * exports — `FleetDisk`, `FileFleetProvisioner` — are Runtimes' provisioning surface by design).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AstNode, parseFile, walk } from './check.ts';
import { loadWorkspace, sourceFiles } from './workspace.ts';

export const LINK_OPERATIONS: ReadonlySet<string> = new Set(['linkTo', 'copyTree']);
/** What an unresolvable computed key on a `RootHandle` is reported as. */
export const UNRESOLVED_OPERATION = 'computed-key-on-RootHandle';

const ROOT_HANDLE_TYPE = 'RootHandle';
const MENTIONS: readonly string[] = [...LINK_OPERATIONS, ROOT_HANDLE_TYPE];

type Parents = readonly AstNode[];

const isNode = (value: unknown): value is AstNode =>
  value !== null && typeof value === 'object' && typeof (value as AstNode).type === 'string';

/** An expression with `as`, `satisfies`, `!`, parentheses and `?.` chains peeled off. */
function unwrap(node: unknown): AstNode | undefined {
  let current = isNode(node) ? node : undefined;
  while (
    current !== undefined &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'ChainExpression')
  )
    current = isNode(current.expression) ? current.expression : undefined;
  return current;
}

/** The string an expression is, when it is plainly one: `'linkTo'`, `'linkTo' as const`, `` `linkTo` ``. */
function stringOf(node: unknown): string | undefined {
  const expr = unwrap(node);
  if (expr === undefined) return undefined;
  if (expr.type === 'Literal' && typeof expr.value === 'string') return expr.value;
  if (expr.type === 'TemplateLiteral' && ((expr.expressions as unknown[] | undefined) ?? []).length === 0) {
    const first = (expr.quasis as AstNode[] | undefined)?.[0];
    const cooked = (first?.value as { cooked?: unknown } | undefined)?.cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  return undefined;
}

/** The last name of a value expression: `fleet`, `this.fleet`, `ctx.roots.fleet`, `(fleet as RootHandle)`. */
function tailName(node: unknown): string | undefined {
  const expr = unwrap(node);
  if (expr === undefined) return undefined;
  if (expr.type === 'Identifier') return expr.name as string;
  if (expr.type === 'MemberExpression') {
    if (expr.computed === true) return stringOf(expr.property);
    const property = expr.property as AstNode;
    return property.type === 'Identifier' ? (property.name as string) : undefined;
  }
  return undefined;
}

/** Whether a type (any depth: unions, arrays, generics) names the `RootHandle` type or one of its import aliases. */
function namesRootHandle(type: unknown, handleTypeNames: ReadonlySet<string>): boolean {
  let found = false;
  if (!isNode(type)) return false;
  walk(type, node => {
    if (found || node.type !== 'TSTypeReference') return;
    const typeName = node.typeName as AstNode | undefined;
    const name =
      typeName?.type === 'Identifier'
        ? (typeName.name as string)
        : typeName?.type === 'TSQualifiedName'
          ? ((typeName.right as AstNode | undefined)?.name as string | undefined)
          : undefined;
    if (name !== undefined && handleTypeNames.has(name)) found = true;
  });
  return found;
}

const annotationOf = (node: AstNode): unknown => (node.typeAnnotation as AstNode | undefined)?.typeAnnotation;

/** The name a declaration-ish node binds or declares: `fleet: X` (parameter, field, signature) -> `fleet`. */
function declaredName(node: AstNode): string | undefined {
  if (node.type === 'Identifier') return node.name as string;
  const key = node.key as AstNode | undefined;
  if (key?.type === 'Identifier' && node.computed !== true) return key.name as string;
  if (key?.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

interface ModuleFacts {
  /** Names (variables, parameters, properties, fields) this module types as a `RootHandle`. */
  readonly handles: ReadonlySet<string>;
  /** Every string a name is declared with, `const op = 'linkTo' as const` -> `op: {'linkTo'}`. */
  readonly constants: ReadonlyMap<string, ReadonlySet<string>>;
}

function factsOf(program: AstNode, source: string): ModuleFacts {
  // No handle can be typed in a module that never says the type's name (an import alias still contains it).
  const mentionsHandle = source.includes(ROOT_HANDLE_TYPE);
  const handleTypeNames = new Set<string>([ROOT_HANDLE_TYPE]);
  const constants = new Map<string, Set<string>>();
  const declarators: AstNode[] = [];
  const annotated: AstNode[] = [];
  walk(program, node => {
    if (node.type === 'ImportSpecifier') {
      const imported = node.imported as AstNode | undefined;
      const importedName = imported?.type === 'Identifier' ? imported.name : stringOf(imported);
      const local = (node.local as AstNode | undefined)?.name;
      if (importedName === ROOT_HANDLE_TYPE && typeof local === 'string') handleTypeNames.add(local);
    }
    if (node.type === 'VariableDeclarator') declarators.push(node);
    if (mentionsHandle && node.typeAnnotation !== undefined && node.typeAnnotation !== null) annotated.push(node);
  });
  const handles = new Set<string>();
  const markIfHandle = (name: string | undefined, type: unknown): void => {
    if (name !== undefined && namesRootHandle(type, handleTypeNames)) handles.add(name);
  };
  for (const node of annotated) markIfHandle(declaredName(node), annotationOf(node));
  for (const declarator of declarators) {
    const id = declarator.id as AstNode;
    if (id.type !== 'Identifier') continue;
    const value = stringOf(declarator.init);
    if (value !== undefined) {
      const known = constants.get(id.name as string) ?? new Set<string>();
      known.add(value);
      constants.set(id.name as string, known);
    }
    const init = isNode(declarator.init) ? declarator.init : undefined;
    // `const h = x as RootHandle`, `const h = <RootHandle>x`
    if (init?.type === 'TSAsExpression' || init?.type === 'TSSatisfiesExpression')
      markIfHandle(id.name as string, init.typeAnnotation);
    if (init?.type === 'TSTypeAssertion') markIfHandle(id.name as string, init.typeAnnotation);
  }
  // An alias of a handle is a handle: `const h = fleet`, `const h = this.fleet`.
  for (let grown = true; grown; ) {
    grown = false;
    for (const declarator of declarators) {
      const id = declarator.id as AstNode;
      const from = tailName(declarator.init);
      if (id.type === 'Identifier' && from !== undefined && handles.has(from) && !handles.has(id.name as string)) {
        handles.add(id.name as string);
        grown = true;
      }
    }
  }
  return { handles, constants };
}

/** What a computed key can be: the strings it resolves to, or `undefined` when nothing here can read it. */
function keysOf(key: unknown, constants: ModuleFacts['constants']): readonly string[] | undefined {
  const literal = stringOf(key);
  if (literal !== undefined) return [literal];
  const expr = unwrap(key);
  if (expr?.type === 'Identifier') {
    const known = constants.get(expr.name as string);
    return known === undefined ? undefined : [...known];
  }
  if (expr?.type === 'Literal') return [String(expr.value)]; // a number or bigint: an index, never an operation
  return undefined;
}

export interface Reach {
  readonly line: number;
  readonly operation: string;
}

/** The link operations one module reaches, in source order. */
export function reachesIn(file: string): Reach[] {
  // Sound shortcut: an operation is reached only through its name (spelled out, so also as a constant's value) or, failing
  // closed, through a computed key on a value typed `RootHandle`; a module saying neither has nothing to walk.
  const text = readFileSync(file, 'utf8');
  if (!MENTIONS.some(name => text.includes(name))) return [];
  const parsed = parseFile(file);
  const facts = factsOf(parsed.program, parsed.source);
  const reached: Reach[] = [];
  const note = (node: AstNode, operations: readonly string[]): void => {
    for (const operation of operations) reached.push({ line: parsed.line(node.start), operation });
  };
  /** A key that is, or could be, a link operation: the operations it names, or the fail-closed marker. */
  const operationsOf = (key: AstNode, computed: boolean, fromHandle: boolean): string[] => {
    if (!computed) {
      const name = key.type === 'Identifier' ? (key.name as string) : stringOf(key);
      return name !== undefined && LINK_OPERATIONS.has(name) ? [name] : [];
    }
    const keys = keysOf(key, facts.constants);
    if (keys === undefined) return fromHandle ? [UNRESOLVED_OPERATION] : [];
    return keys.filter(name => LINK_OPERATIONS.has(name));
  };
  walk(parsed.program, (node, parents: Parents) => {
    // `root.linkTo`, `root?.linkTo`, `root['copyTree']`, `root[op]`
    if (node.type === 'MemberExpression') {
      const fromHandle = tailName(node.object) !== undefined && facts.handles.has(tailName(node.object) as string);
      note(node, operationsOf(node.property as AstNode, node.computed === true, fromHandle));
      return;
    }
    // `const { linkTo } = root`, `const { copyTree: copy } = root`, `const { [op]: link } = root`
    if (node.type === 'ObjectPattern') {
      const parent = parents[parents.length - 1];
      const from =
        parent?.type === 'VariableDeclarator' && parent.id === node
          ? tailName(parent.init)
          : parent?.type === 'AssignmentExpression' && parent.left === node
            ? tailName(parent.right)
            : undefined;
      const fromHandle =
        (from !== undefined && facts.handles.has(from)) ||
        namesRootHandle(annotationOf(node), new Set([ROOT_HANDLE_TYPE]));
      for (const entry of (node.properties as AstNode[] | undefined) ?? []) {
        if (entry.type !== 'Property') continue;
        note(entry, operationsOf(entry.key as AstNode, entry.computed === true, fromHandle));
      }
    }
  });
  return reached;
}

/** Every `file:line operation` in the production source of the repo at `root` (tests excluded), keyed by file. */
export function reaches(root: string, relativeTo: (file: string) => string): Map<string, string[]> {
  const ws = loadWorkspace(root);
  const found = new Map<string, string[]>();
  const files = [
    ...ws.packages.flatMap(pkg => sourceFiles(pkg, { tests: false })),
    ...[...new Bun.Glob('migration/**/*.{ts,tsx,mts}').scanSync({ cwd: root, onlyFiles: true })]
      .filter(path => !path.includes('node_modules/') && !/(^|\/)(tests?|fixtures)\//.test(path))
      .map(path => join(root, path)),
  ];
  for (const file of files) {
    const rel = relativeTo(file);
    for (const { line, operation } of reachesIn(file))
      found.set(rel, [...(found.get(rel) ?? []), `${rel}:${line} ${operation}`]);
  }
  return found;
}
