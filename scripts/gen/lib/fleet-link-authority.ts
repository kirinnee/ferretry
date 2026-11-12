/**
 * The AUTHORITY SURFACE of the fleet / harness-home link exception: the set of facts that, if they change, widen who can
 * reach `RootHandle.linkTo` / `copyTree` on the fleet credential store or a host harness home WITHOUT the type-aware scan
 * (`./fleet-link-scan.ts`) seeing a new read. The scan sees reads of the kernel operations; it cannot see a caller of an
 * allowed module's own export that wraps one (`restoreFleetAlias(fleet, …)` exported from `fleet-disk.ts`, re-exported by a
 * barrel, called by a worker). So the surface is pinned, and a reviewer approves every change to it (&F3537):
 *
 * 1. `exports`: every export of each allowed module — name and kind, and the non-private members of an exported class,
 *    interface or object literal (a new METHOD on `FleetDisk` is a new wrapper);
 * 2. `importers`: every production module that imports an allowed module, directly or through a chain of re-exports
 *    (`export … from`, `export *`) — the only way to call an export you did not write;
 * 3. `handleOrigins`: every production module that asks the kernel for a `fleet` or `harness-home` handle
 *    (`RootsPort.root(name)` where `name` can be either — a name the checker cannot narrow counts, it could be);
 * 4. `handleReceivers`: every production module the handle VALUE then flows into — through variables, assignments, call
 *    arguments (the callee's parameter), returns (the callers), object-literal properties and class fields, followed with the
 *    checker's symbol references until no new module is reached.
 *
 * 5. `diskOperations` and `diskHolders`: the link-capable members of `FleetDisk` and every production module that holds a value
 *    the checker types as `FleetDisk` (declares a field, parameter, variable or return of that type, or reads one) — found
 *    from the class's own references, followed like a handle, plus every identifier named like such a carrier, verified by type;
 * 6. `handleApi`: the COMPLETE member list (name and kind) of the `RootHandle` interface and of every object literal or class
 *    that implements it. A new, removed or renamed operation changes the pin whatever it is called, so a reviewer decides its
 *    guard — the scan cannot infer link semantics from an unlisted name.
 *
 * Origins (3) are found by what a call RESOLVES to (the declaration of `RootsPort.root`), not by how the callee is spelled:
 * a destructuring, a rename, an element access, `.bind`/`.call`/`.apply` and passing `roots.root` as a value are all followed
 * until the calls they end in; a root name that cannot be resolved counts as a fleet root.
 *
 * NOT followed (declared): a handle put in a container (`array.push(fleet)`, `map.set(k, fleet)`, a spread) or returned
 * through a callable passed through more than one hop; the type-aware scan does not depend on this flow — it reads the
 * TYPE of every receiver wherever it is — so a handle that escapes this list is still caught the moment it is used for a
 * link operation outside the allowed modules.
 */
import {
  type Project,
  SignatureKind,
  type Symbol as CheckerSymbol,
  SymbolFlags,
  type Type,
  TypeFlags,
} from 'typescript/unstable/async';
import { type Expression, type Node, type SourceFile, SyntaxKind } from 'typescript/unstable/ast';
import {
  FLEET_DISK_CLASS,
  FLEET_DISK_MODULE,
  HandleOracle,
  handleFactsOf,
  diskOperationsOf,
  keyNamesOf,
} from './fleet-link-scan.ts';
import type { ProductionProgram } from './fleet-link-program.ts';

export interface HandleApi {
  /** `name: kind` of each member of the `RootHandle` interface (`?` marks an optional one). */
  readonly members: readonly string[];
  /** `file#name` of each implementation → its members, as written. */
  readonly implementations: Readonly<Record<string, readonly string[]>>;
}

export interface AuthoritySurface {
  readonly exports: Readonly<Record<string, readonly string[]>>;
  readonly importers: readonly string[];
  readonly handleOrigins: readonly string[];
  readonly handleReceivers: readonly string[];
  readonly diskOperations: readonly string[];
  readonly diskHolders: readonly string[];
  readonly handleApi: HandleApi;
}

/** The roots whose handle carries the declared link exception. */
const FLEET_ROOT_NAMES: ReadonlySet<string> = new Set(['fleet', 'harness-home']);
const KERNEL_PORTS = '/packages/core/kernel/contract/ports.ts';

const textOf = (node: Node | undefined): string | undefined => (node as { text?: string } | undefined)?.text;
const has = (node: Node, key: string): Node | undefined => (node as unknown as Record<string, Node | undefined>)[key];
const list = (node: Node, key: string): readonly Node[] =>
  ((node as unknown as Record<string, readonly Node[] | undefined>)[key] ?? []) as readonly Node[];
const nodeKey = (node: Node): string => `${node.getSourceFile().fileName}:${node.pos}:${node.end}:${node.kind}`;

function kindOf(flags: number): string {
  if (flags & SymbolFlags.Class) return 'class';
  if (flags & SymbolFlags.Interface) return 'interface';
  if (flags & SymbolFlags.TypeAlias) return 'type';
  if (flags & SymbolFlags.Function) return 'function';
  if (flags & SymbolFlags.Enum) return 'enum';
  if (flags & SymbolFlags.Variable) return 'const';
  if (flags & SymbolFlags.Alias) return 're-export';
  if (flags & (SymbolFlags.ValueModule | SymbolFlags.NamespaceModule)) return 'namespace';
  return `flags:${flags}`;
}

/** The members of a class / interface / object literal that a caller outside could reach (not `private`, not `#name`). */
function membersOf(declaration: Node): string[] {
  const out: string[] = [];
  for (const member of list(declaration, 'members')) {
    const name = has(member, 'name');
    if (name?.kind === SyntaxKind.PrivateIdentifier) continue;
    const modifiers = list(member, 'modifiers');
    if (modifiers.some(modifier => modifier.kind === SyntaxKind.PrivateKeyword)) continue;
    const label =
      member.kind === SyntaxKind.Constructor
        ? 'constructor'
        : name === undefined
          ? undefined
          : (textOf(name) ?? name.getText());
    if (label === undefined) continue;
    const staticMember = modifiers.some(modifier => modifier.kind === SyntaxKind.StaticKeyword) ? 'static ' : '';
    out.push(`${staticMember}${label}`);
  }
  const initializer = has(declaration, 'initializer');
  if (initializer?.kind === SyntaxKind.ObjectLiteralExpression)
    for (const property of list(initializer, 'properties')) {
      const name = has(property, 'name');
      if (name !== undefined) out.push(textOf(name) ?? name.getText());
    }
  return out;
}

async function exportsOf(project: Project, sf: SourceFile): Promise<string[]> {
  const module = await project.checker.getSymbolAtLocation(sf);
  if (module === undefined) return [`<no module symbol: ${sf.fileName}>`];
  const lines: string[] = [];
  for (const exported of await project.checker.getExportsOfModule(module)) {
    lines.push(`${exported.name}: ${kindOf(exported.flags)}`);
    let target: CheckerSymbol = exported;
    if (exported.flags & SymbolFlags.Alias) target = await project.checker.getAliasedSymbol(exported);
    for (const handle of target.declarations) {
      const declaration = await handle.resolve(project);
      if (declaration === undefined) continue;
      for (const member of membersOf(declaration)) lines.push(`${exported.name}.${member}`);
    }
  }
  return [...new Set(lines)].sort();
}

// ─── importers ────────────────────────────────────────────────────────────────────────────────────────────────

interface Edge {
  readonly from: string;
  readonly to: string;
  /** `export … from`, `export *`: the importer passes the target's exports on. */
  readonly reexport: boolean;
}

async function importEdges(program: ProductionProgram, project: Project, files: readonly string[]): Promise<Edge[]> {
  const sites: { file: string; specifier: Node; reexport: boolean }[] = [];
  for (const file of files) {
    const sf = await project.program.getSourceFile(file);
    if (sf === undefined) continue;
    for (const statement of sf.statements) {
      if (statement.kind === SyntaxKind.ImportDeclaration || statement.kind === SyntaxKind.ExportDeclaration) {
        const specifier = has(statement, 'moduleSpecifier');
        if (specifier !== undefined)
          sites.push({ file, specifier, reexport: statement.kind === SyntaxKind.ExportDeclaration });
      }
    }
    // `import('./x.ts')` and `import x = require('./x')` are imports as well.
    const walk = (node: Node): void => {
      if (node.kind === SyntaxKind.CallExpression) {
        const call = node as unknown as { expression: Node; arguments: readonly Node[] };
        const first = call.arguments[0];
        if (call.expression.kind === SyntaxKind.ImportKeyword && first !== undefined && textOf(first) !== undefined)
          sites.push({ file, specifier: first, reexport: false });
      }
      node.forEachChild(walk);
    };
    if (sf.text.includes('import(')) walk(sf);
  }
  const edges: Edge[] = [];
  for (let at = 0; at < sites.length; at += 400) {
    const batch = sites.slice(at, at + 400);
    const symbols = await project.checker.getSymbolAtLocation(batch.map(site => site.specifier));
    for (const [index, symbol] of symbols.entries()) {
      const site = batch[index];
      const target = symbol?.declarations[0];
      if (site === undefined || target === undefined) continue;
      // `Path` is the file name in canonical form (exact on a case-sensitive file system).
      edges.push({ from: program.rel(site.file), to: program.rel(String(target.path)), reexport: site.reexport });
    }
  }
  return edges;
}

/** Modules importing any of `allowed`, directly or through modules that re-export them; the allowed modules themselves excluded. */
function importersOf(edges: readonly Edge[], allowed: ReadonlySet<string>): string[] {
  const reached = new Set(allowed);
  const importers = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of edges) {
      if (!reached.has(edge.to) || importers.has(edge.from) || allowed.has(edge.from)) continue;
      importers.add(edge.from);
      grew = true;
      if (edge.reexport) reached.add(edge.from);
    }
  }
  return [...importers].sort();
}

// ─── handle flow ──────────────────────────────────────────────────────────────────────────────────────────────

const VALUE_WRAPPERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.AwaitExpression,
]);
const PASSES_BOTH: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.CommaToken,
]);
const FUNCTION_LIKE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
]);

/** Follows a handle value from where the kernel gives it out to every production module it is passed to. */
class HandleFlow {
  readonly modules = new Set<string>();
  readonly #project: Project;
  readonly #seenExpressions = new Set<string>();
  readonly #seenSymbols = new Set<string>();
  readonly #queue: (() => Promise<void>)[] = [];
  readonly #production: ReadonlySet<string>;

  constructor(project: Project, production: ReadonlySet<string>) {
    this.#project = project;
    this.#production = production;
  }

  async run(seeds: readonly Node[]): Promise<void> {
    for (const seed of seeds) this.#queue.push(() => this.value(seed));
    while (this.#queue.length > 0) await (this.#queue.shift() as () => Promise<void>)();
  }

  note(node: Node): void {
    const file = node.getSourceFile().fileName;
    if (this.#production.has(file)) this.modules.add(file);
  }

  /** A handle value is the result of this expression. */
  async value(start: Node): Promise<void> {
    let current = start;
    for (;;) {
      const key = nodeKey(current);
      if (this.#seenExpressions.has(key)) return;
      this.#seenExpressions.add(key);
      this.note(current);
      const parent = current.parent;
      if (VALUE_WRAPPERS.has(parent.kind)) {
        current = parent;
        continue;
      }
      switch (parent.kind) {
        case SyntaxKind.ConditionalExpression:
          if (has(parent, 'condition') === current) return;
          current = parent;
          continue;
        case SyntaxKind.BinaryExpression: {
          const operator = has(parent, 'operatorToken')?.kind;
          if (operator !== undefined && PASSES_BOTH.has(operator)) {
            current = parent;
            continue;
          }
          if (operator === SyntaxKind.EqualsToken && has(parent, 'right') === current) {
            const left = has(parent, 'left') as Node;
            await this.target(left.kind === SyntaxKind.PropertyAccessExpression ? (has(left, 'name') as Node) : left);
            current = parent;
            continue;
          }
          return;
        }
        case SyntaxKind.VariableDeclaration:
          if (has(parent, 'initializer') === current) await this.target(has(parent, 'name') as Node);
          return;
        case SyntaxKind.PropertyAssignment:
          if (has(parent, 'initializer') === current) await this.#property(parent);
          return;
        case SyntaxKind.ShorthandPropertyAssignment:
          await this.#property(parent);
          return;
        case SyntaxKind.CallExpression:
        case SyntaxKind.NewExpression: {
          const args = list(parent, 'arguments');
          const index = args.indexOf(current);
          if (index >= 0) await this.#argument(parent, index);
          return;
        }
        case SyntaxKind.ReturnStatement: {
          const fn = this.#enclosingFunction(parent);
          if (fn !== undefined) await this.returns(fn);
          return;
        }
        case SyntaxKind.ArrowFunction:
          if (has(parent, 'body') === current) await this.returns(parent);
          return;
        default:
          return;
      }
    }
  }

  #enclosingFunction(node: Node): Node | undefined {
    for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent)
      if (FUNCTION_LIKE.has(current.kind)) return current;
    return undefined;
  }

  /** The symbol a name node (identifier, binding, member name) binds, and everything that reads it. */
  async target(name: Node): Promise<void> {
    if (name.kind !== SyntaxKind.Identifier && name.kind !== SyntaxKind.PrivateIdentifier) return;
    const symbol = await this.#project.checker.getSymbolAtLocation(name);
    if (symbol !== undefined) await this.#symbol(symbol);
  }

  async #property(assignment: Node): Promise<void> {
    const name = has(assignment, 'name') as Node;
    const own = await this.#project.checker.getSymbolAtLocation(name);
    if (own !== undefined) await this.#symbol(own);
    const literal = assignment.parent;
    const contextual = await this.#project.checker.getContextualType(literal as unknown as Expression);
    const text = textOf(name);
    if (contextual !== undefined && text !== undefined) {
      const declared = await this.#project.checker.getPropertyOfType(contextual, text);
      if (declared !== undefined) await this.#symbol(declared);
    }
  }

  async #argument(call: Node, index: number): Promise<void> {
    const signature = await this.#project.checker.getResolvedSignature(call);
    if (signature === undefined) return;
    const parameters = await signature.getParameters();
    const parameter = parameters[Math.min(index, parameters.length - 1)];
    if (parameter !== undefined) await this.#symbol(parameter);
  }

  /** A function returns the handle: every call of it yields one. */
  async returns(fn: Node): Promise<void> {
    const holders: Node[] = [];
    const own = has(fn, 'name');
    if (own !== undefined) holders.push(own);
    const parent = fn.parent;
    if (parent.kind === SyntaxKind.VariableDeclaration) holders.push(has(parent, 'name') as Node);
    if (parent.kind === SyntaxKind.PropertyAssignment) holders.push(has(parent, 'name') as Node);
    for (const holder of holders) {
      const symbol = await this.#project.checker.getSymbolAtLocation(holder);
      if (symbol !== undefined) await this.#references(symbol, 'call');
    }
    if (parent.kind === SyntaxKind.CallExpression || parent.kind === SyntaxKind.NewExpression) {
      const index = list(parent, 'arguments').indexOf(fn);
      const signature = index < 0 ? undefined : await this.#project.checker.getResolvedSignature(parent);
      const parameters = (await signature?.getParameters()) ?? [];
      const parameter = parameters[Math.min(index, parameters.length - 1)];
      if (parameter !== undefined) await this.#references(parameter, 'call');
    }
  }

  async #symbol(symbol: CheckerSymbol): Promise<void> {
    await this.#references(symbol, 'value');
    // A constructor parameter property is also a field: `this.fleet` elsewhere in the class reads it.
    for (const handle of symbol.declarations) {
      const declaration = await handle.resolve(this.#project);
      if (declaration?.kind !== SyntaxKind.Parameter || declaration.parent.kind !== SyntaxKind.Constructor) continue;
      if (list(declaration, 'modifiers').length === 0) continue;
      const owner = declaration.parent.parent;
      const classSymbol = await this.#project.checker.getSymbolAtLocation(has(owner, 'name') as Node);
      const field = (await classSymbol?.getMembers())?.get(symbol.escapedName);
      if (field !== undefined) await this.#references(field, 'value');
    }
  }

  async #references(symbol: CheckerSymbol, as: 'value' | 'call'): Promise<void> {
    const key = `${symbol.id}:${as}`;
    if (this.#seenSymbols.has(key)) return;
    this.#seenSymbols.add(key);
    for (const handle of symbol.declarations) {
      const declaration = await handle.resolve(this.#project);
      if (declaration === undefined) continue;
      this.note(declaration);
      const name = (has(declaration, 'name') ?? declaration) as Node;
      const sf = declaration.getSourceFile();
      for (const entry of await this.#project.checker.getReferencedSymbolsForNode(name, name.getStart(sf))) {
        for (const reference of entry.references) {
          const node = await reference.resolve(this.#project);
          if (node === undefined) continue;
          this.#queue.push(() => this.#reference(node, as));
        }
      }
    }
  }

  async #reference(node: Node, as: 'value' | 'call'): Promise<void> {
    let expression = node;
    // `this.fleet`, `deps.fleet`: the value is the whole member access.
    if (expression.parent.kind === SyntaxKind.PropertyAccessExpression && has(expression.parent, 'name') === expression)
      expression = expression.parent;
    const parent = expression.parent;
    // The declaration's own name is not a read.
    if (
      (parent.kind === SyntaxKind.VariableDeclaration ||
        parent.kind === SyntaxKind.Parameter ||
        parent.kind === SyntaxKind.PropertyDeclaration ||
        parent.kind === SyntaxKind.PropertySignature ||
        parent.kind === SyntaxKind.PropertyAssignment ||
        parent.kind === SyntaxKind.ShorthandPropertyAssignment ||
        parent.kind === SyntaxKind.FunctionDeclaration ||
        parent.kind === SyntaxKind.MethodDeclaration ||
        parent.kind === SyntaxKind.BindingElement) &&
      has(parent, 'name') === expression
    )
      return;
    if (as === 'value') {
      await this.value(expression);
      return;
    }
    if (parent.kind === SyntaxKind.CallExpression && has(parent, 'expression') === expression) await this.value(parent);
  }
}

// ─── origins: RootsPort.root, found by what the call resolves to ─────────────────────────────────────────────

/** The same expression with any cast, `satisfies`, `!` or parenthesis stripped from around it still being the same value. */
const SAME_VALUE: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
]);

interface Origins {
  /** Modules that ask for (or may ask for) a fleet / harness-home handle. */
  readonly modules: Set<string>;
  /** The expressions that are (or may be) such a handle: where the value flow starts. */
  readonly seeds: Node[];
}

/** Follows the `RootsPort.root` FUNCTION from every reference to it until the calls it ends in; judges each call's root name. */
class OriginFlow {
  readonly origins: Origins = { modules: new Set(), seeds: [] };
  readonly #project: Project;
  readonly #production: ReadonlySet<string>;
  readonly #seenNodes = new Set<string>();
  readonly #seenSymbols = new Set<string>();
  readonly #queue: (() => Promise<void>)[] = [];

  constructor(project: Project, production: ReadonlySet<string>) {
    this.#project = project;
    this.#production = production;
  }

  async run(references: readonly Node[]): Promise<void> {
    for (const reference of references) this.#queue.push(() => this.#reference(reference));
    while (this.#queue.length > 0) await (this.#queue.shift() as () => Promise<void>)();
  }

  /** The value is (or may be) a fleet handle: its module is an origin and the flow starts at it. */
  #seed(node: Node): void {
    const file = node.getSourceFile().fileName;
    if (!this.#production.has(file)) return;
    this.origins.modules.add(file);
    this.origins.seeds.push(node);
  }

  /** One reference to the `root` member: a property access, a destructuring, a literal key; type positions are not uses. */
  async #reference(node: Node): Promise<void> {
    const parent = node.parent;
    if (!this.#production.has(node.getSourceFile().fileName)) return;
    // Definitions and implementations of `root` are not uses.
    if (
      (parent.kind === SyntaxKind.MethodSignature ||
        parent.kind === SyntaxKind.PropertySignature ||
        parent.kind === SyntaxKind.MethodDeclaration ||
        parent.kind === SyntaxKind.PropertyDeclaration ||
        parent.kind === SyntaxKind.PropertyAssignment ||
        parent.kind === SyntaxKind.ShorthandPropertyAssignment) &&
      has(parent, 'name') === node
    )
      return;
    if (parent.kind === SyntaxKind.LiteralType || parent.kind === SyntaxKind.IndexedAccessType) return;
    if (node.kind === SyntaxKind.StringLiteral && parent.kind !== SyntaxKind.ElementAccessExpression) return;
    if (parent.kind === SyntaxKind.BindingElement) {
      const element = parent;
      const bound = has(element, 'name') as Node;
      const key = has(element, 'propertyName') ?? bound;
      if (key !== node && bound !== node) return;
      if (bound.kind === SyntaxKind.Identifier) await this.#symbol(bound);
      else this.#seed(node);
      return;
    }
    if (parent.kind === SyntaxKind.PropertyAccessExpression && has(parent, 'name') === node) {
      await this.callable(parent);
      return;
    }
    if (parent.kind === SyntaxKind.ElementAccessExpression && has(parent, 'argumentExpression') === node) {
      await this.callable(parent);
      return;
    }
    // Anything else (a shorthand, a spread, a query): it may be the function; count it.
    this.#seed(node);
  }

  /** The value of this expression is the `root` function (or a bound copy of it): follow it to the calls. */
  async callable(start: Node): Promise<void> {
    let current = start;
    for (;;) {
      const key = nodeKey(current);
      if (this.#seenNodes.has(key)) return;
      this.#seenNodes.add(key);
      const parent = current.parent;
      if (SAME_VALUE.has(parent.kind)) {
        current = parent;
        continue;
      }
      switch (parent.kind) {
        case SyntaxKind.CallExpression:
        case SyntaxKind.NewExpression: {
          if (has(parent, 'expression') === current && parent.kind === SyntaxKind.CallExpression) {
            await this.#invoke(parent, 0);
            return;
          }
          const index = list(parent, 'arguments').indexOf(current);
          if (index < 0) {
            this.#seed(current);
            return;
          }
          const signature = await this.#project.checker.getResolvedSignature(parent);
          const parameters = (await signature?.getParameters()) ?? [];
          const parameter = parameters[Math.min(index, parameters.length - 1)];
          if (parameter === undefined) this.#seed(current);
          else await this.#symbolOf(parameter);
          return;
        }
        case SyntaxKind.PropertyAccessExpression: {
          const call = parent.parent;
          const member = textOf(has(parent, 'name'));
          if (
            has(parent, 'expression') === current &&
            call.kind === SyntaxKind.CallExpression &&
            has(call, 'expression') === parent
          ) {
            const args = list(call, 'arguments');
            // `root.bind(roots)`: the same function, bound to a receiver. Bound arguments are a root name, so unresolved.
            if (member === 'bind' && args.length <= 1) {
              current = call;
              continue;
            }
            if (member === 'call') {
              await this.#invoke(call, 1);
              return;
            }
          }
          this.#seed(current);
          return;
        }
        case SyntaxKind.VariableDeclaration: {
          const name = has(parent, 'name') as Node;
          if (has(parent, 'initializer') === current && name.kind === SyntaxKind.Identifier) await this.#symbol(name);
          else this.#seed(current);
          return;
        }
        case SyntaxKind.BinaryExpression: {
          const operator = has(parent, 'operatorToken')?.kind;
          if (operator === SyntaxKind.EqualsToken && has(parent, 'right') === current) {
            const left = has(parent, 'left') as Node;
            const name = left.kind === SyntaxKind.PropertyAccessExpression ? (has(left, 'name') as Node) : left;
            if (name.kind === SyntaxKind.Identifier) await this.#symbol(name);
            else this.#seed(current);
            return;
          }
          if (operator !== undefined && PASSES_BOTH.has(operator)) {
            current = parent;
            continue;
          }
          this.#seed(current);
          return;
        }
        case SyntaxKind.ConditionalExpression:
          if (has(parent, 'condition') === current) return;
          current = parent;
          continue;
        default:
          this.#seed(current);
          return;
      }
    }
  }

  /** A call of the function: its root name is the argument at `index`; no such argument, a spread or an unnamed type counts. */
  async #invoke(call: Node, index: number): Promise<void> {
    const argument = list(call, 'arguments')[index];
    if (argument === undefined || argument.kind === SyntaxKind.SpreadElement) {
      this.#seed(call);
      return;
    }
    const type = await this.#project.checker.getTypeAtLocation(argument);
    const keys = type === undefined ? { names: [], unresolved: true } : await keyNamesOf(this.#project, type);
    if (keys.unresolved || keys.names.some(name => FLEET_ROOT_NAMES.has(name))) this.#seed(call);
  }

  async #symbolOf(symbol: CheckerSymbol): Promise<void> {
    const key = String(symbol.id);
    if (this.#seenSymbols.has(key)) return;
    this.#seenSymbols.add(key);
    for (const handle of symbol.declarations) {
      const declaration = await handle.resolve(this.#project);
      if (declaration === undefined) continue;
      const name = (has(declaration, 'name') ?? declaration) as Node;
      const sf = declaration.getSourceFile();
      for (const entry of await this.#project.checker.getReferencedSymbolsForNode(name, name.getStart(sf))) {
        for (const reference of entry.references) {
          const node = await reference.resolve(this.#project);
          if (node === undefined || node === name) continue;
          this.#queue.push(() => this.#use(node));
        }
      }
    }
  }

  async #symbol(name: Node): Promise<void> {
    const symbol = await this.#project.checker.getSymbolAtLocation(name);
    if (symbol === undefined) this.#seed(name);
    else await this.#symbolOf(symbol);
  }

  /** A read of a variable / parameter / field that holds the function. */
  async #use(node: Node): Promise<void> {
    // A search from a destructured name also finds the property's other spellings (`roots['root']`): classify those as references.
    if (node.kind === SyntaxKind.StringLiteral) {
      await this.#reference(node);
      return;
    }
    let expression = node;
    if (expression.parent.kind === SyntaxKind.PropertyAccessExpression && has(expression.parent, 'name') === expression)
      expression = expression.parent;
    const parent = expression.parent;
    if (
      (parent.kind === SyntaxKind.VariableDeclaration ||
        parent.kind === SyntaxKind.Parameter ||
        parent.kind === SyntaxKind.PropertyDeclaration ||
        parent.kind === SyntaxKind.PropertySignature ||
        parent.kind === SyntaxKind.PropertyAssignment ||
        parent.kind === SyntaxKind.BindingElement) &&
      has(parent, 'name') === expression
    )
      return;
    await this.callable(expression);
  }
}

/** The calls to `RootsPort.root` whose name can be `fleet` or `harness-home`, however the function is reached. */
async function rootOrigins(
  project: Project,
  files: readonly string[],
  production: ReadonlySet<string>,
): Promise<Origins> {
  const ports = (await project.program.getSourceFileNames()).find(name =>
    name.replaceAll('\\', '/').endsWith(KERNEL_PORTS),
  );
  const sf = ports === undefined ? undefined : await project.program.getSourceFile(ports);
  const port = sf?.statements.find(
    statement =>
      statement.kind === SyntaxKind.InterfaceDeclaration &&
      textOf((statement as unknown as { name: Node }).name) === 'RootsPort',
  );
  const member =
    port === undefined ? undefined : list(port, 'members').find(each => textOf(has(each, 'name')) === 'root');
  if (sf === undefined || member === undefined) throw new Error(`${KERNEL_PORTS} no longer declares RootsPort.root`);
  const name = has(member, 'name') as Node;
  const references: Node[] = [];
  for (const entry of await project.checker.getReferencedSymbolsForNode(name, name.getStart(sf)))
    for (const reference of entry.references) {
      const node = await reference.resolve(project);
      if (node !== undefined) references.push(node);
    }
  const flow = new OriginFlow(project, production);
  await flow.run(references);
  // What a reference search cannot reach: a computed key on a port (`roots[key]`), or the function read off an `any`.
  const declared =
    (await project.checker.getSymbolAtLocation(name))?.declarations.map(d => `${d.path}#${d.index}`) ?? [];
  const candidates: { access: Node; receivers: Node[] }[] = [];
  for (const file of files) {
    const source = await project.program.getSourceFile(file);
    if (source === undefined || !source.text.includes('[')) continue;
    const walk = (node: Node): void => {
      if (node.kind === SyntaxKind.ElementAccessExpression) {
        const key = has(node, 'argumentExpression') as Node;
        if (key.kind !== SyntaxKind.NumericLiteral && key.kind !== SyntaxKind.StringLiteral) {
          const layers: Node[] = [];
          for (let current = has(node, 'expression') as Node; ; ) {
            layers.push(current);
            if (!SAME_VALUE.has(current.kind)) break;
            current = has(current, 'expression') as Node;
          }
          candidates.push({ access: node, receivers: layers });
        }
      }
      node.forEachChild(walk);
    };
    walk(source);
  }
  for (let at = 0; at < candidates.length; at += 400) {
    const batch = candidates.slice(at, at + 400);
    await Promise.all(
      batch.map(async ({ access, receivers }) => {
        for (const type of await project.checker.getTypeAtLocation(receivers)) {
          if (type === undefined) continue;
          const parts = type.flags & TypeFlags.UnionOrIntersection ? await partsOf(type) : [type];
          for (const part of parts) {
            const own = await project.checker.getPropertyOfType(part, 'root');
            if (own?.declarations.some(d => declared.includes(`${d.path}#${d.index}`))) {
              flow.origins.modules.add(access.getSourceFile().fileName);
              flow.origins.seeds.push(access);
              return;
            }
          }
        }
      }),
    );
  }
  return flow.origins;
}

const partsOf = async (type: Type): Promise<readonly Type[]> =>
  (await (type as unknown as { getTypes(): Promise<readonly Type[] | undefined> }).getTypes()) ?? [];

// ─── the disk: every module that holds a FleetDisk ───────────────────────────────────────────────────────────

const TYPE_CONTAINERS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.TypeReference,
  SyntaxKind.UnionType,
  SyntaxKind.IntersectionType,
  SyntaxKind.ArrayType,
  SyntaxKind.TupleType,
  SyntaxKind.ParenthesizedType,
  SyntaxKind.TypeOperator,
  SyntaxKind.OptionalType,
  SyntaxKind.RestType,
  SyntaxKind.NamedTupleMember,
  SyntaxKind.FunctionType,
  SyntaxKind.ExpressionWithTypeArguments,
  SyntaxKind.IndexedAccessType,
  SyntaxKind.ConditionalType,
]);

async function diskHolders(
  project: Project,
  files: readonly string[],
  production: ReadonlySet<string>,
): Promise<string[]> {
  const file = files.find(name => name.replaceAll('\\', '/').endsWith(FLEET_DISK_MODULE));
  const sf = file === undefined ? undefined : await project.program.getSourceFile(file);
  const declaration = sf?.statements.find(
    statement =>
      statement.kind === SyntaxKind.ClassDeclaration &&
      textOf((statement as unknown as { name?: Node }).name) === FLEET_DISK_CLASS,
  );
  if (sf === undefined || declaration === undefined) return [];
  const flow = new HandleFlow(project, production);
  const names = new Set<string>();
  const roots: Node[] = [has(declaration, 'name') as Node];
  const seenRoots = new Set<string>();
  for (let root = roots.shift(); root !== undefined; root = roots.shift()) {
    if (seenRoots.has(nodeKey(root))) continue;
    seenRoots.add(nodeKey(root));
    const source = root.getSourceFile();
    flow.note(root);
    for (const entry of await project.checker.getReferencedSymbolsForNode(root, root.getStart(source))) {
      for (const handle of entry.references) {
        const node = await handle.resolve(project);
        if (node === undefined || node === root) continue;
        flow.note(node);
        const parent = node.parent;
        if (parent.kind === SyntaxKind.NewExpression && has(parent, 'expression') === node) {
          await flow.value(parent);
          continue;
        }
        if (parent.kind === SyntaxKind.PropertyAccessExpression && has(parent, 'expression') === node) {
          // A static factory: `FleetDisk.create(...)`.
          const call = parent.parent;
          if (call.kind === SyntaxKind.CallExpression && has(call, 'expression') === parent) await flow.value(call);
          continue;
        }
        if (parent.kind === SyntaxKind.HeritageClause || parent.parent?.kind === SyntaxKind.HeritageClause) {
          const owner = (parent.kind === SyntaxKind.HeritageClause ? parent : parent.parent).parent;
          const ownName = has(owner, 'name');
          if (ownName !== undefined) roots.push(ownName);
          continue;
        }
        let carrier = parent;
        while (TYPE_CONTAINERS.has(carrier.kind) && carrier.parent !== undefined) carrier = carrier.parent;
        const name = has(carrier, 'name');
        switch (carrier.kind) {
          case SyntaxKind.Parameter:
          case SyntaxKind.PropertySignature:
          case SyntaxKind.PropertyDeclaration:
          case SyntaxKind.VariableDeclaration:
            if (name?.kind === SyntaxKind.Identifier) {
              names.add(textOf(name) as string);
              await flow.target(name);
            }
            break;
          case SyntaxKind.FunctionDeclaration:
          case SyntaxKind.FunctionExpression:
          case SyntaxKind.ArrowFunction:
          case SyntaxKind.MethodDeclaration:
          case SyntaxKind.MethodSignature:
          case SyntaxKind.GetAccessor:
            if (name !== undefined) names.add(textOf(name) ?? name.getText());
            await flow.returns(carrier);
            break;
          case SyntaxKind.TypeAliasDeclaration:
            if (name !== undefined) roots.push(name);
            break;
          default:
        }
      }
    }
  }
  // Every identifier named like a carrier found above (`host.disk` through `Pick<AdapterHost, 'disk'>`, a renamed
  // destructuring, a literal key), kept when the checker types it as a disk.
  const symbol = await project.checker.getSymbolAtLocation(has(declaration, 'name') as Node);
  if (symbol === undefined) throw new Error(`the checker has no symbol for ${FLEET_DISK_CLASS}`);
  const facts = await handleFactsOfDisk(project, symbol);
  const holders = new Set(flow.modules);
  if (names.size > 0) {
    const nodes: Node[] = [];
    for (const path of production) {
      const source = await project.program.getSourceFile(path);
      if (source === undefined || ![...names].some(name => source.text.includes(name))) continue;
      const walk = (node: Node): void => {
        const text =
          node.kind === SyntaxKind.Identifier || node.kind === SyntaxKind.StringLiteral ? textOf(node) : undefined;
        if (text !== undefined && names.has(text)) {
          nodes.push(node);
          const parent = node.parent;
          if (
            parent.kind === SyntaxKind.PropertyAccessExpression ||
            parent.kind === SyntaxKind.ElementAccessExpression
          ) {
            nodes.push(parent);
            if (parent.parent.kind === SyntaxKind.CallExpression) nodes.push(parent.parent);
          } else if (parent.kind === SyntaxKind.CallExpression) nodes.push(parent);
        }
        node.forEachChild(walk);
      };
      walk(source);
    }
    for (let at = 0; at < nodes.length; at += 400) {
      const batch = nodes.slice(at, at + 400);
      const types = await project.checker.getTypeAtLocation(batch);
      await Promise.all(
        batch.map(async (node, index) => {
          const type = types[index];
          if (type !== undefined && (await facts.isHandle(type))) holders.add(node.getSourceFile().fileName);
        }),
      );
    }
  }
  return [...holders].filter(path => production.has(path));
}

async function handleFactsOfDisk(project: Project, symbol: CheckerSymbol): Promise<HandleOracle> {
  const type = await project.checker.getDeclaredTypeOfSymbol(symbol);
  return new HandleOracle({
    project,
    handle: type,
    declarations: new Map(),
    operationTypes: new Map(),
    operations: new Set(),
    prefix: '',
    unresolved: '',
  });
}

// ─── the handle's whole API ──────────────────────────────────────────────────────────────────────────────────

/**
 * `name: kind` of every member of a type. An interface says what it declares (`method`, `property`); an implementation is
 * written many ways (`f() {}`, `f: () => …`), so it is described by what it IS (`function` or `value`).
 */
async function memberLabels(project: Project, type: Type, written: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const property of await project.checker.getPropertiesOfType(type)) {
    let kind: string;
    if (written) {
      const own = await project.checker.getTypeOfSymbol(property);
      const calls = own === undefined ? [] : await project.checker.getSignaturesOfType(own, SignatureKind.Call);
      kind =
        property.flags & (SymbolFlags.Method | SymbolFlags.GetAccessor | SymbolFlags.SetAccessor) || calls.length > 0
          ? 'function'
          : 'value';
      if (property.flags & (SymbolFlags.GetAccessor | SymbolFlags.SetAccessor)) kind = 'accessor';
    } else
      kind =
        property.flags & SymbolFlags.Method
          ? 'method'
          : property.flags & (SymbolFlags.GetAccessor | SymbolFlags.SetAccessor)
            ? 'accessor'
            : 'property';
    out.push(`${property.name}${property.flags & SymbolFlags.Optional ? '?' : ''}: ${kind}`);
  }
  return [...new Set(out)].sort();
}

/** The nearest declaration name above a node: what to call an anonymous implementation. */
function enclosingName(node: Node): string {
  for (let current: Node | undefined = node; current !== undefined; current = current.parent) {
    const name = has(current, 'name');
    if (
      name !== undefined &&
      (current.kind === SyntaxKind.VariableDeclaration ||
        current.kind === SyntaxKind.PropertyAssignment ||
        current.kind === SyntaxKind.FunctionDeclaration ||
        current.kind === SyntaxKind.MethodDeclaration ||
        current.kind === SyntaxKind.ClassDeclaration ||
        current.kind === SyntaxKind.PropertyDeclaration)
    )
      return textOf(name) ?? name.getText();
  }
  return '<anonymous>';
}

async function handleApi(program: ProductionProgram, project: Project, files: readonly string[]): Promise<HandleApi> {
  const facts = await handleFactsOf(project);
  if (facts === undefined)
    throw new Error(`the kernel contract (${KERNEL_PORTS}) is not part of the root TypeScript project`);
  const members = await memberLabels(project, facts.handle, false);
  const methodNames = new Set(
    (await project.checker.getPropertiesOfType(facts.handle))
      .filter(p => p.flags & SymbolFlags.Method)
      .map(p => p.name),
  );
  const oracle = new HandleOracle(facts);
  const candidates: { node: Node; typed: Node; file: string }[] = [];
  for (const file of files) {
    const sf = await project.program.getSourceFile(file);
    if (sf === undefined) continue;
    const walk = (node: Node): void => {
      if (node.kind === SyntaxKind.ObjectLiteralExpression) {
        if (list(node, 'properties').some(property => methodNames.has(textOf(has(property, 'name')) ?? '')))
          candidates.push({ node, typed: node, file });
      } else if (node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.ClassExpression) {
        candidates.push({ node, typed: has(node, 'name') ?? node, file });
      }
      node.forEachChild(walk);
    };
    walk(sf);
  }
  const implementations: Record<string, string[]> = {};
  for (let at = 0; at < candidates.length; at += 400) {
    const batch = candidates.slice(at, at + 400);
    const types = await project.checker.getTypeAtLocation(batch.map(each => each.typed));
    await Promise.all(
      batch.map(async (candidate, index) => {
        let type = types[index];
        if (type === undefined) return;
        if (candidate.node.kind === SyntaxKind.ClassDeclaration || candidate.node.kind === SyntaxKind.ClassExpression) {
          const symbol = await project.checker.getSymbolAtLocation(candidate.typed);
          if (symbol !== undefined && candidate.typed !== candidate.node)
            type = await project.checker.getDeclaredTypeOfSymbol(symbol);
        }
        if (!(await oracle.isHandle(type))) return;
        const key = `${program.rel(candidate.file)}#${enclosingName(candidate.node)}`;
        let unique = key;
        for (let n = 2; implementations[unique] !== undefined; n++) unique = `${key}~${n}`;
        implementations[unique] = await memberLabels(project, type, true);
      }),
    );
  }
  return { members, implementations };
}

export async function authoritySurface(
  program: ProductionProgram,
  allowedModules: readonly string[],
): Promise<AuthoritySurface> {
  const root = program.projects[0];
  if (root === undefined) throw new Error('no TypeScript project');
  const { project, files } = root;
  const absolute = new Map(files.map(file => [program.rel(file), file]));
  const exports: Record<string, readonly string[]> = {};
  for (const rel of allowedModules) {
    const file = absolute.get(rel);
    const sf = file === undefined ? undefined : await project.program.getSourceFile(file);
    if (sf === undefined) throw new Error(`${rel} is not a production module of the root TypeScript project`);
    exports[rel] = await exportsOf(project, sf);
  }
  const edges = await importEdges(program, project, files);
  const importers = importersOf(edges, new Set(allowedModules));
  const ports = [...(await project.program.getSourceFileNames())].find(name => name.endsWith(KERNEL_PORTS));
  if (ports === undefined)
    throw new Error(`the kernel contract (${KERNEL_PORTS}) is not part of the root TypeScript project`);
  const production = new Set(files);
  const origins = await rootOrigins(project, files, production);
  const flow = new HandleFlow(project, production);
  await flow.run(origins.seeds);
  const relative = (set: Iterable<string>): string[] =>
    [...set]
      .filter(file => production.has(file))
      .map(file => program.rel(file))
      .sort();
  return {
    exports,
    importers,
    handleOrigins: relative(origins.modules),
    handleReceivers: relative(flow.modules),
    diskOperations: await diskOperationsOf(program),
    diskHolders: relative(await diskHolders(project, files, production)),
    handleApi: await handleApi(program, project, files),
  };
}

const added = (now: readonly string[], approved: readonly string[]): string[] =>
  now.filter(item => !approved.includes(item));

/**
 * What changed between the approved surface (the committed snapshot) and the current one, one sentence per change, each
 * saying that a reviewer must approve it. Empty when nothing changed.
 */
export function describeSurfaceChange(approved: AuthoritySurface, now: AuthoritySurface, card: string): string[] {
  const out: string[] = [];
  const review = `A reviewer must approve this change to the fleet link authority surface (${card}, the dedicated credential link operation): re-run the test with FLEET_LINK_SNAPSHOT_UPDATE=1 and commit the snapshot only once approved.`;
  const guard = `A reviewer must approve this change to the RootHandle API and decide its guard (${card}): does the new or changed operation need the same guard as linkTo / copyTree? Then re-run the test with FLEET_LINK_SNAPSHOT_UPDATE=1 and commit the snapshot only once approved.`;
  for (const module of new Set([...Object.keys(approved.exports), ...Object.keys(now.exports)])) {
    const was = approved.exports[module] ?? [];
    const is = now.exports[module] ?? [];
    for (const item of added(is, was)) out.push(`${module} gained the export ${item}. ${review}`);
    for (const item of added(was, is)) out.push(`${module} lost the export ${item}. ${review}`);
  }
  const lists = [
    ['imports an allowed module (it can call what the module exports)', approved.importers, now.importers],
    ['asks the kernel for a fleet or harness-home handle', approved.handleOrigins, now.handleOrigins],
    ['receives the fleet or harness-home handle', approved.handleReceivers, now.handleReceivers],
    ['holds a FleetDisk (a value it can link through)', approved.diskHolders, now.diskHolders],
  ] as const;
  for (const [what, was, is] of lists) {
    for (const module of added(is, was)) out.push(`${module} is a new module that ${what}. ${review}`);
    for (const module of added(was, is))
      out.push(`${module} no longer ${what}: remove it from the snapshot. ${review}`);
  }
  for (const item of added(now.diskOperations, approved.diskOperations))
    out.push(`FleetDisk gained the link-capable member ${item}. ${review}`);
  for (const item of added(approved.diskOperations, now.diskOperations))
    out.push(`FleetDisk lost the link-capable member ${item}. ${review}`);
  for (const item of added(now.handleApi.members, approved.handleApi.members))
    out.push(`RootHandle gained the member ${item}. ${guard}`);
  for (const item of added(approved.handleApi.members, now.handleApi.members))
    out.push(`RootHandle lost the member ${item}. ${guard}`);
  const split = (key: string): string => {
    const at = key.indexOf('#');
    return `${key.slice(0, at)} (${key.slice(at + 1)})`;
  };
  const impls = new Set([
    ...Object.keys(approved.handleApi.implementations),
    ...Object.keys(now.handleApi.implementations),
  ]);
  for (const key of impls) {
    const was = approved.handleApi.implementations[key];
    const is = now.handleApi.implementations[key];
    const [file, name] = [key.slice(0, key.indexOf('#')), key.slice(key.indexOf('#') + 1)];
    if (was === undefined) out.push(`${file} is a new implementation of RootHandle (${name}). ${guard}`);
    else if (is === undefined)
      out.push(`${file} no longer holds the RootHandle implementation ${name}: remove it from the snapshot. ${guard}`);
    else {
      for (const item of added(is, was))
        out.push(`${split(key)} (an implementation of RootHandle) gained the member ${item}. ${guard}`);
      for (const item of added(was, is))
        out.push(`${split(key)} (an implementation of RootHandle) lost the member ${item}. ${guard}`);
    }
  }
  return out;
}
