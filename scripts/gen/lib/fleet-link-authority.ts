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
 * NOT followed (declared): a handle put in a container (`array.push(fleet)`, `map.set(k, fleet)`, a spread) or returned
 * through a callable passed through more than one hop; the type-aware scan does not depend on this flow — it reads the
 * TYPE of every receiver wherever it is — so a handle that escapes this list is still caught the moment it is used for a
 * link operation outside the allowed modules.
 */
import { type Project, type Symbol as CheckerSymbol, SymbolFlags, type Type } from 'typescript/unstable/async';
import { type Expression, type Node, type SourceFile, SyntaxKind } from 'typescript/unstable/ast';
import { keyNamesOf } from './fleet-link-scan.ts';
import type { ProductionProgram } from './fleet-link-program.ts';

export interface AuthoritySurface {
  readonly exports: Readonly<Record<string, readonly string[]>>;
  readonly importers: readonly string[];
  readonly handleOrigins: readonly string[];
  readonly handleReceivers: readonly string[];
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

  #note(node: Node): void {
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
      this.#note(current);
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
            await this.#target(left.kind === SyntaxKind.PropertyAccessExpression ? (has(left, 'name') as Node) : left);
            current = parent;
            continue;
          }
          return;
        }
        case SyntaxKind.VariableDeclaration:
          if (has(parent, 'initializer') === current) await this.#target(has(parent, 'name') as Node);
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
          if (fn !== undefined) await this.#returns(fn);
          return;
        }
        case SyntaxKind.ArrowFunction:
          if (has(parent, 'body') === current) await this.#returns(parent);
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
  async #target(name: Node): Promise<void> {
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
  async #returns(fn: Node): Promise<void> {
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
      this.#note(declaration);
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

/** The `RootsPort.root` calls whose name can be `fleet` or `harness-home`. */
async function handleSeeds(project: Project, files: readonly string[]): Promise<Node[]> {
  const calls: { call: Node; name: Node }[] = [];
  for (const file of files) {
    const sf = await project.program.getSourceFile(file);
    if (sf === undefined || !sf.text.includes('root')) continue;
    const walk = (node: Node): void => {
      if (node.kind === SyntaxKind.CallExpression) {
        const callee = has(node, 'expression');
        const first = list(node, 'arguments')[0];
        if (
          callee?.kind === SyntaxKind.PropertyAccessExpression &&
          textOf(has(callee, 'name')) === 'root' &&
          first !== undefined
        )
          calls.push({ call: node, name: first });
      }
      node.forEachChild(walk);
    };
    walk(sf);
  }
  const seeds: Node[] = [];
  for (let at = 0; at < calls.length; at += 200) {
    const batch = calls.slice(at, at + 200);
    const signatures = await Promise.all(batch.map(({ call }) => project.checker.getResolvedSignature(call)));
    const types = await project.checker.getTypeAtLocation(batch.map(({ name }) => name));
    for (const [index, entry] of batch.entries()) {
      const declaration = signatures[index]?.declaration;
      // `RootsPort.root` of the kernel contract (`Path` is the canonical file name).
      if (declaration === undefined || !String(declaration.path).endsWith(KERNEL_PORTS)) continue;
      const type: Type | undefined = types[index];
      const keys = type === undefined ? { names: [], unresolved: true } : await keyNamesOf(project, type);
      if (keys.unresolved || keys.names.some(name => FLEET_ROOT_NAMES.has(name))) seeds.push(entry.call);
    }
  }
  return seeds;
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
  const seeds = await handleSeeds(project, files);
  const production = new Set(files);
  const origins = new Set(seeds.map(seed => seed.getSourceFile().fileName).filter(file => production.has(file)));
  const flow = new HandleFlow(project, production);
  await flow.run(seeds);
  return {
    exports,
    importers,
    handleOrigins: [...origins].map(file => program.rel(file)).sort(),
    handleReceivers: [...flow.modules].map(file => program.rel(file)).sort(),
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
  ] as const;
  for (const [what, was, is] of lists) {
    for (const module of added(is, was)) out.push(`${module} is a new module that ${what}. ${review}`);
    for (const module of added(was, is))
      out.push(`${module} no longer ${what}: remove it from the snapshot. ${review}`);
  }
  return out;
}
