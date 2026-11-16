/**
 * The scanner behind `scripts/gen/tests/fleet-link-callers.test.ts`: which production modules REACH a generic root link
 * operation (`RootHandle.linkTo`, `RootHandle.copyTree`).
 *
 * It asks the TYPE CHECKER (`./fleet-link-program.ts`), not the spelling, so a type alias, an imported dispatch table, a
 * re-exported type, a wrapper, a scoped or reassigned key and a barrel re-export are all the same value to it. "Reach" means,
 * in any production module:
 *
 * - a property or element read, a destructuring (declaration, parameter or assignment) or a computed destructuring whose key
 *   is `linkTo` or `copyTree`, on a receiver the checker types as a handle: the kernel `RootHandle`, an alias of it, a union
 *   or intersection containing it, an interface extending it, or any type that CARRIES its operations (`Pick`, `Readonly`, a
 *   spread or a rest of a handle, a structural look-alike whose member is assignable to the operation). Casts are looked
 *   through: `(fleet as never as Record<string, Function>)[name]` is a read on `fleet`;
 * - the same on an `any`/`unknown` receiver (a name that cannot be proved harmless is a name that could be a handle);
 * - FAIL CLOSED: a computed key on a handle whose type is not a union of string literals (`string`, a template literal, a
 *   type parameter with no literal constraint), reported as {@link UNRESOLVED_OPERATION}. Keys are resolved from their TYPE,
 *   so `const`, `as const`, an imported table (`OPS.link`), a union, a parameter typed `'linkTo'` and a `let` narrowed by
 *   control flow all resolve; a key that is merely `string` does not;
 *
 * The definitions of the operations themselves (`linkTo: async () => …` in an object, `linkTo(…): Promise<void>` in an
 * interface) are not reads, so the kernel's host, testing host and contract need no exemption of their own.
 *
 * - an `any`/`unknown` receiver reading the operation by name, and — FAIL CLOSED — an `any` receiver with a non-literal key
 *   when a handle was put into it (`const h: any = fleet`, or a parameter typed `any` that a call passes a handle for).
 *
 * The same is asked of `FleetDisk` (Runtimes' `fleet-disk.ts`), by TYPE: its link-capable members (every member that reaches a
 * `RootHandle` link operation, directly or through another member or helper of the module, `./fleet-link-disk.ts`) are link
 * operations exactly like the handle's, reported as `FleetDisk.<member>`. A `Pick<AdapterHost, 'disk'>`, `host.disk.linkTo`, a
 * wrapper, an alias and a destructuring are the same value to the checker, so they are all seen.
 *
 * Every production project is scanned (the root, `packages/app`, the one-shot migration), each with the disk module as ITS program
 * holds it — the module is in a secondary project's program when that project imports `FleetDisk`, even though it is assigned
 * to the root project.
 *
 * NOT caught (declared): reflection (`Reflect.get`, `Object.entries`, `Object.getOwnPropertyDescriptor`) — a name that is
 * never a typed key — and a handle that reaches an `any` some other way (a property, a return, a container) and is then
 * indexed by a key that is not an operation's name.
 */
import { type Project, type Type, TypeFlags } from 'typescript/unstable/async';
import {
  type BindingElement,
  type ElementAccessExpression,
  type Node,
  type PropertyAccessExpression,
  type SourceFile,
  SyntaxKind,
} from 'typescript/unstable/ast';
import { linkCapableMembers } from './fleet-link-disk.ts';
import { type ProductionProgram } from './fleet-link-program.ts';

export const LINK_OPERATIONS: ReadonlySet<string> = new Set(['linkTo', 'copyTree']);
/** What a computed key on a handle that the checker cannot narrow to string literals is reported as. */
export const UNRESOLVED_OPERATION = 'computed-key-on-RootHandle';

const KERNEL_PORTS = '/packages/core/kernel/contract/ports.ts';
const ROOT_HANDLE = 'RootHandle';
/** The second authority module and its class: the disk Runtimes' provisioner links through. */
export const FLEET_DISK_MODULE = '/packages/plugins/runtimes/daemon/adapters/fleet-disk.ts';
export const FLEET_DISK_CLASS = 'FleetDisk';

/** What the checker knows about one link authority (the kernel `RootHandle`, Runtimes' `FleetDisk`): its type and its operations. */
export interface HandleFacts {
  readonly project: Project;
  readonly handle: Type;
  /** `path#index` of each declaration of each operation on the interface. */
  readonly declarations: ReadonlyMap<string, ReadonlySet<string>>;
  readonly operationTypes: ReadonlyMap<string, Type>;
  /** The operation names. */
  readonly operations: ReadonlySet<string>;
  /** What a reach is reported as: `linkTo` for the handle, `FleetDisk.linkTo` for the disk. */
  readonly prefix: string;
  /** What a computed key that cannot be narrowed is reported as. */
  readonly unresolved: string;
}

/** The constituents of a union or intersection type. */
const partsOf = async (type: Type): Promise<readonly Type[]> =>
  (await (type as unknown as { getTypes(): Promise<readonly Type[] | undefined> }).getTypes()) ?? [];
const textOf = (node: Node): string | undefined => (node as { text?: string }).text;
const asNode = (value: unknown): Node => value as Node;

/** The `RootHandle` of a project, or `undefined` when the kernel contract is not part of it (so no value can be one). */
export async function handleFactsOf(project: Project): Promise<HandleFacts | undefined> {
  const ports = (await project.program.getSourceFileNames()).find(name =>
    name.replaceAll('\\', '/').endsWith(KERNEL_PORTS),
  );
  if (ports === undefined) return undefined;
  const file = await project.program.getSourceFile(ports);
  const declaration = file?.statements.find(
    statement =>
      statement.kind === SyntaxKind.InterfaceDeclaration &&
      textOf(asNode((statement as unknown as { name: unknown }).name)) === ROOT_HANDLE,
  );
  if (declaration === undefined) throw new Error(`${ports} no longer declares the ${ROOT_HANDLE} interface`);
  const symbol = await project.checker.getSymbolAtLocation(asNode((declaration as unknown as { name: unknown }).name));
  if (symbol === undefined) throw new Error(`the checker has no symbol for ${ROOT_HANDLE}`);
  const handle = await project.checker.getDeclaredTypeOfSymbol(symbol);
  const declarations = new Map<string, Set<string>>();
  const operationTypes = new Map<string, Type>();
  for (const operation of LINK_OPERATIONS) {
    const member = await project.checker.getPropertyOfType(handle, operation);
    if (member === undefined)
      throw new Error(`${ROOT_HANDLE} no longer has ${operation}: this guard has nothing to guard`);
    declarations.set(operation, new Set(member.declarations.map(d => `${d.path}#${d.index}`)));
    const type = await project.checker.getTypeOfSymbol(member);
    if (type !== undefined) operationTypes.set(operation, type);
  }
  return {
    project,
    handle,
    declarations,
    operationTypes,
    operations: LINK_OPERATIONS,
    prefix: '',
    unresolved: UNRESOLVED_OPERATION,
  };
}

/**
 * The disk module as THIS project's program holds it, whichever project it is assigned to: a secondary project (the
 * migration) that imports `FleetDisk` has the module in its program without it being among its assigned files.
 */
export async function diskModuleOf(project: Project): Promise<string | undefined> {
  return (await project.program.getSourceFileNames()).find(name =>
    name.replaceAll('\\', '/').endsWith(FLEET_DISK_MODULE),
  );
}

/** The disk's facts in one project's program, with `operations` its link-capable members. */
async function diskFactsOf(
  project: Project,
  root: HandleFacts,
  rootOracle: HandleOracle,
): Promise<HandleFacts | undefined> {
  const file = await diskModuleOf(project);
  const sf = file === undefined ? undefined : await project.program.getSourceFile(file);
  if (file === undefined || sf === undefined) return undefined;
  const reads: Node[] = [];
  for (const candidate of candidatesIn(sf, file, LINK_OPERATIONS))
    if (candidate.named !== undefined && (await judgeOne(root, rootOracle, candidate)).length > 0)
      reads.push(candidate.named.name);
  const declaration = sf.statements.find(
    statement =>
      statement.kind === SyntaxKind.ClassDeclaration &&
      textOf(asNode((statement as unknown as { name?: unknown }).name)) === FLEET_DISK_CLASS,
  );
  if (declaration === undefined) throw new Error(`${file} no longer declares the ${FLEET_DISK_CLASS} class`);
  const operations = linkCapableMembers(sf, declaration, reads);
  if (operations.size === 0)
    throw new Error(`${FLEET_DISK_CLASS} has no member that reaches a link operation: this guard has nothing to guard`);
  const symbol = await project.checker.getSymbolAtLocation(asNode((declaration as unknown as { name: unknown }).name));
  if (symbol === undefined) throw new Error(`the checker has no symbol for ${FLEET_DISK_CLASS}`);
  const type = await project.checker.getDeclaredTypeOfSymbol(symbol);
  const declarations = new Map<string, Set<string>>();
  const operationTypes = new Map<string, Type>();
  for (const operation of operations) {
    const member = await project.checker.getPropertyOfType(type, operation);
    if (member === undefined) continue;
    declarations.set(operation, new Set(member.declarations.map(d => `${d.path}#${d.index}`)));
    const memberType = await project.checker.getTypeOfSymbol(member);
    if (memberType !== undefined) operationTypes.set(operation, memberType);
  }
  return {
    project,
    handle: type,
    declarations,
    operationTypes,
    operations,
    prefix: `${FLEET_DISK_CLASS}.`,
    unresolved: `computed-key-on-${FLEET_DISK_CLASS}`,
  };
}

/** The link-capable members of the disk, for the pinned surface. */
export async function diskOperationsOf(program: ProductionProgram): Promise<string[]> {
  const root = program.projects[0];
  if (root === undefined) return [];
  const facts = await handleFactsOf(root.project);
  if (facts === undefined) return [];
  const disk = await diskFactsOf(root.project, facts, new HandleOracle(facts));
  return [...(disk?.operations ?? [])].sort();
}

/** Answers "is this a handle?" for types, once per type. */
export class HandleOracle {
  readonly #facts: HandleFacts;
  readonly #seen = new Map<number, Promise<boolean>>();
  constructor(facts: HandleFacts) {
    this.#facts = facts;
  }

  isHandle(type: Type, depth = 0): Promise<boolean> {
    let known = this.#seen.get(type.id);
    if (known === undefined) {
      known = this.#decide(type, depth);
      this.#seen.set(type.id, known);
    }
    return known;
  }

  async #decide(type: Type, depth: number): Promise<boolean> {
    const { project, handle, declarations, operationTypes, operations } = this.#facts;
    if (type.id === handle.id) return true;
    if (
      depth > 8 ||
      type.flags & (TypeFlags.Primitive | TypeFlags.Never | TypeFlags.AnyOrUnknown | TypeFlags.NonPrimitive)
    )
      return false;
    if (type.flags & TypeFlags.UnionOrIntersection) {
      for (const part of await partsOf(type)) if (await this.isHandle(part, depth + 1)) return true;
      return false;
    }
    if (type.flags & (TypeFlags.Instantiable & ~TypeFlags.Index)) {
      const constraint = await project.checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint.id !== type.id ? this.isHandle(constraint, depth + 1) : false;
    }
    for (const operation of operations) {
      const member = await project.checker.getPropertyOfType(type, operation);
      if (member === undefined) continue;
      const own = declarations.get(operation);
      if (member.declarations.some(d => own?.has(`${d.path}#${d.index}`))) return true;
      const memberType = await project.checker.getTypeOfSymbol(member);
      const wanted = operationTypes.get(operation);
      if (
        memberType !== undefined &&
        wanted !== undefined &&
        (await project.checker.isTypeAssignableTo(memberType, wanted))
      )
        return true;
    }
    return false;
  }
}

/** The strings a key type is, and whether anything about it is not a plain string literal. */
export async function keyNamesOf(
  project: Project,
  type: Type,
  depth = 0,
): Promise<{ readonly names: readonly string[]; readonly unresolved: boolean }> {
  const flags = type.flags;
  if (flags & TypeFlags.StringLiteral)
    return { names: [String((type as { value?: unknown }).value)], unresolved: false };
  if (
    flags &
    (TypeFlags.NumberLiteral |
      TypeFlags.BigIntLiteral |
      TypeFlags.Number |
      TypeFlags.BigInt |
      TypeFlags.ESSymbol |
      TypeFlags.UniqueESSymbol |
      TypeFlags.Never |
      TypeFlags.Boolean |
      TypeFlags.BooleanLiteral |
      TypeFlags.Undefined |
      TypeFlags.Null |
      TypeFlags.Void)
  )
    return { names: [], unresolved: false };
  if (flags & TypeFlags.UnionOrIntersection) {
    const names: string[] = [];
    let unresolved = false;
    for (const part of await partsOf(type)) {
      const inner = await keyNamesOf(project, part, depth + 1);
      names.push(...inner.names);
      unresolved ||= inner.unresolved;
    }
    return { names, unresolved };
  }
  if (depth < 8 && flags & (TypeFlags.Instantiable & ~TypeFlags.Index)) {
    const constraint = await project.checker.getBaseConstraintOfType(type);
    if (constraint !== undefined && constraint.id !== type.id) return keyNamesOf(project, constraint, depth + 1);
  }
  return { names: [], unresolved: true };
}

const PEELED: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.TypeAssertionExpression,
]);

/** An expression and everything a cast, `satisfies`, `!` or parenthesis wrapped around it: each layer has its own type. */
function layersOf(expression: Node): Node[] {
  const layers = [expression];
  for (let current = expression; PEELED.has(current.kind); ) {
    current = (current as unknown as { expression: Node }).expression;
    layers.push(current);
  }
  return layers;
}

const isStringKey = (node: Node): boolean =>
  node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral;

export interface Candidate {
  readonly file: string;
  readonly line: number;
  /** A key spelled out as `linkTo`/`copyTree`. */
  readonly named?: { readonly operation: string; readonly name: Node; readonly access?: Node };
  /** A computed key that is not a literal. */
  readonly key?: Node;
  /** The receiver, and each layer of cast around it. */
  readonly receivers: readonly Node[];
}

class Lines {
  readonly #starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.#starts.push(i + 1);
  }
  at(position: number): number {
    let low = 0;
    let high = this.#starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((this.#starts[mid] ?? 0) <= position) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }
}

/** Every place in one source file where an operation is, or could be, named. */
export function candidatesIn(sf: SourceFile, file: string, names: ReadonlySet<string>): Candidate[] {
  const lines = new Lines(sf.text);
  const out: Candidate[] = [];
  const lineOf = (node: Node): number => lines.at(node.getStart(sf));
  const named = (node: Node, operation: string, name: Node, receivers: Node[], access?: Node): void => {
    out.push({
      file,
      line: lineOf(node),
      named: { operation, name, ...(access === undefined ? {} : { access }) },
      receivers,
    });
  };
  const computed = (node: Node, key: Node, receivers: Node[]): void => {
    out.push({ file, line: lineOf(node), key, receivers });
  };
  /** A property key in a destructuring: `linkTo`, `'linkTo'`, `[expr]`. */
  const fromPattern = (node: Node, key: Node | undefined, receivers: Node[], access?: Node): void => {
    if (key === undefined) return;
    if (key.kind === SyntaxKind.ComputedPropertyName) {
      const inner = (key as unknown as { expression: Node }).expression;
      if (isStringKey(inner)) {
        const text = textOf(inner);
        if (text !== undefined && names.has(text)) named(node, text, inner, receivers, access);
      } else if (inner.kind !== SyntaxKind.NumericLiteral) computed(node, inner, receivers);
      return;
    }
    const text = textOf(key);
    if (text !== undefined && names.has(text)) named(node, text, key, receivers, access);
  };
  const walk = (node: Node): void => {
    switch (node.kind) {
      case SyntaxKind.PropertyAccessExpression: {
        const access = node as PropertyAccessExpression;
        const text = textOf(access.name);
        if (text !== undefined && names.has(text)) named(node, text, access.name, layersOf(access.expression), node);
        break;
      }
      case SyntaxKind.ElementAccessExpression: {
        const access = node as ElementAccessExpression;
        const key = access.argumentExpression;
        if (key.kind === SyntaxKind.NumericLiteral) break;
        if (isStringKey(key)) {
          const text = textOf(key);
          if (text !== undefined && names.has(text)) named(node, text, key, layersOf(access.expression), node);
        } else computed(node, key, layersOf(access.expression));
        break;
      }
      case SyntaxKind.BindingElement: {
        const element = node as BindingElement;
        const pattern = element.parent;
        if (pattern.kind !== SyntaxKind.ObjectBindingPattern || element.dotDotDotToken !== undefined) break;
        // The pattern's own type, and (looking through casts) the initializer it destructures.
        const declaration = pattern.parent as { initializer?: Node } | undefined;
        const source = pattern.parent.kind === SyntaxKind.VariableDeclaration ? declaration?.initializer : undefined;
        fromPattern(
          node,
          element.propertyName ?? element.name,
          [pattern, ...(source === undefined ? [] : layersOf(source))],
          element.name,
        );
        break;
      }
      case SyntaxKind.ObjectLiteralExpression: {
        // `({ linkTo } = fleet)`: an object literal on the left of an assignment is a destructuring.
        const parent = node.parent;
        if (parent.kind !== SyntaxKind.BinaryExpression) break;
        const assignment = parent as unknown as { left: Node; right: Node; operatorToken: Node };
        if (assignment.left !== node || assignment.operatorToken.kind !== SyntaxKind.EqualsToken) break;
        for (const property of (node as unknown as { properties: readonly Node[] }).properties) {
          if (
            property.kind === SyntaxKind.ShorthandPropertyAssignment ||
            property.kind === SyntaxKind.PropertyAssignment
          )
            fromPattern(property, (property as unknown as { name: Node }).name, layersOf(assignment.right));
        }
        break;
      }
      default:
    }
    node.forEachChild(walk);
  };
  walk(sf);
  return out;
}

export interface Reach {
  readonly line: number;
  readonly operation: string;
}

const isAnyLike = (type: Type): boolean => (type.flags & TypeFlags.AnyOrUnknown) !== 0;

/** One link authority and the oracle that recognises its values. */
interface Authority {
  readonly facts: HandleFacts;
  readonly oracle: HandleOracle;
}

/** What one authority makes of one candidate: the operations (reported with the authority's prefix) it is a read of. */
async function judgeOne(facts: HandleFacts, oracle: HandleOracle, candidate: Candidate): Promise<string[]> {
  const { project } = facts;
  const types = (await project.checker.getTypeAtLocation(candidate.receivers)).filter(
    (t): t is Type => t !== undefined,
  );
  let handle = false;
  for (const type of types) handle ||= await oracle.isHandle(type);
  const loose = types.some(isAnyLike);
  if (candidate.named !== undefined) {
    const { operation, name, access } = candidate.named;
    if (!facts.operations.has(operation)) return [];
    const reported = `${facts.prefix}${operation}`;
    if (handle || loose) return [reported];
    const member = await project.checker.getSymbolAtLocation(name);
    const own = facts.declarations.get(operation);
    if (member?.declarations.some(d => own?.has(`${d.path}#${d.index}`))) return [reported];
    if (access !== undefined) {
      const memberType = await project.checker.getTypeAtLocation(access);
      const wanted = facts.operationTypes.get(operation);
      if (
        memberType !== undefined &&
        wanted !== undefined &&
        (await project.checker.isTypeAssignableTo(memberType, wanted))
      )
        return [reported];
    }
    return [];
  }
  if (candidate.key === undefined) return [];
  // An `any` receiver is a handle when a handle was put in it (see `launderedHandle`); otherwise only an operation NAME counts.
  const laundered = !handle && loose && (await launderedHandle(facts, oracle, candidate.receivers));
  if (!handle && !loose) return [];
  const keyType = await project.checker.getTypeAtLocation(candidate.key);
  const keys = keyType === undefined ? { names: [], unresolved: true } : await keyNamesOf(project, keyType);
  const hit = keys.names.filter(name => facts.operations.has(name)).map(name => `${facts.prefix}${name}`);
  if (!keys.unresolved) return hit;
  return handle || laundered ? [...hit, facts.unresolved] : hit;
}

async function judge(authorities: readonly Authority[], candidate: Candidate): Promise<string[]> {
  const out = new Set<string>();
  for (const { facts, oracle } of authorities)
    for (const operation of await judgeOne(facts, oracle, candidate)) out.add(operation);
  return [...out];
}

/**
 * Whether an `any`/`unknown` receiver is a name a handle was put into: `const h: any = fleet`, or a parameter typed `any`
 * that a call is passed a handle for (`launch(fleet)` against `launch(h: any)`). Followed through a few hops; a handle that
 * reaches an `any` any other way (a property, a return, a container) is the declared limit.
 */
async function launderedHandle(
  facts: HandleFacts,
  oracle: HandleOracle,
  receivers: readonly Node[],
  depth = 0,
): Promise<boolean> {
  const { project } = facts;
  const inner = receivers[receivers.length - 1];
  if (inner === undefined || depth > 3) return false;
  const symbol = await project.checker.getSymbolAtLocation(inner);
  if (symbol === undefined) return false;
  const holdsHandle = async (expressions: readonly Node[]): Promise<boolean> => {
    const types = (await project.checker.getTypeAtLocation(expressions)).filter((t): t is Type => t !== undefined);
    for (const type of types) if (await oracle.isHandle(type)) return true;
    return types.some(isAnyLike) && (await launderedHandle(facts, oracle, expressions, depth + 1));
  };
  for (const handle of symbol.declarations) {
    const declaration = await handle.resolve(project);
    if (declaration === undefined) continue;
    if (declaration.kind === SyntaxKind.VariableDeclaration) {
      const initializer = (declaration as { initializer?: Node }).initializer;
      if (initializer !== undefined && (await holdsHandle(layersOf(initializer)))) return true;
    }
    if (declaration.kind === SyntaxKind.Parameter) {
      const owner = declaration.parent as { parameters?: readonly Node[] };
      const index = owner.parameters?.indexOf(declaration) ?? -1;
      if (index < 0) continue;
      for (const usage of await project.checker.getSignatureUsage(declaration.parent)) {
        const call = (await usage.call?.resolve(project)) as { arguments?: readonly Node[] } | undefined;
        const argument = call?.arguments?.[index];
        if (argument !== undefined && (await holdsHandle(layersOf(argument)))) return true;
      }
    }
  }
  return false;
}

/** Every `file:line operation` reached in the production source of a program, keyed by root-relative file. */
export async function reachesIn(program: ProductionProgram): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const [index, { project, files }] of program.projects.entries()) {
    const facts = await handleFactsOf(project);
    if (facts === undefined && index === 0)
      throw new Error(
        `the kernel contract (${KERNEL_PORTS}) is not part of the root TypeScript project: nothing to scan for`,
      );
    const oracle = facts === undefined ? undefined : new HandleOracle(facts);
    const authorities: Authority[] = [];
    if (facts !== undefined && oracle !== undefined) {
      authorities.push({ facts, oracle });
      const disk = await diskFactsOf(project, facts, oracle);
      if (disk !== undefined) authorities.push({ facts: disk, oracle: new HandleOracle(disk) });
    }
    const names = new Set(authorities.flatMap(({ facts: each }) => [...each.operations]));
    let pending: Candidate[] = [];
    const flush = async (): Promise<void> => {
      const batch = pending;
      pending = [];
      // Types of every receiver in one round trip; the oracle answers repeated types from memory.
      await Promise.all(
        batch.map(async candidate => {
          for (const operation of await judge(authorities, candidate)) {
            const rel = program.rel(candidate.file);
            found.set(rel, [...(found.get(rel) ?? []), `${rel}:${candidate.line} ${operation}`]);
          }
        }),
      );
    };
    for (const file of files) {
      const sf = await project.program.getSourceFile(file);
      if (sf === undefined) continue;
      pending.push(...candidatesIn(sf, file, names));
      if (pending.length >= 250) await flush();
    }
    await flush();
  }
  for (const [rel, places] of found) found.set(rel, places.sort());
  return found;
}
