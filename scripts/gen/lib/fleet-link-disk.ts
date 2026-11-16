/**
 * Which members of the `FleetDisk` class (Runtimes' `fleet-disk.ts`) are LINK-CAPABLE: reach a `RootHandle` link operation
 * (`linkTo`, `copyTree`), directly or through another member of the class or a function of the module that does. They are
 * the disk's link operations, guarded exactly like the handle's (`./fleet-link-scan.ts`).
 *
 * Syntax only, by design: it decides which NAMES the type-aware scan then asks the checker about, so it errs on the wide
 * side — a unit is capable when it contains a read or mentions (`this.x`, a bare `x`) a capable unit by name. A name that is
 * capable by accident only makes the scan stricter.
 */
import { type Node, SyntaxKind } from 'typescript/unstable/ast';

const textOf = (node: Node | undefined): string | undefined => (node as { text?: string } | undefined)?.text;
const has = (node: Node, key: string): Node | undefined => (node as unknown as Record<string, Node | undefined>)[key];
const list = (node: Node, key: string): readonly Node[] =>
  ((node as unknown as Record<string, readonly Node[] | undefined>)[key] ?? []) as readonly Node[];

interface Unit {
  readonly name: string;
  readonly node: Node;
  readonly member: boolean;
}

const unitsOf = (sf: Node, declaration: Node): Unit[] => {
  const units: Unit[] = [];
  for (const member of list(declaration, 'members')) {
    const name = textOf(has(member, 'name'));
    if (name !== undefined && member.kind !== SyntaxKind.Constructor) units.push({ name, node: member, member: true });
    else if (member.kind === SyntaxKind.Constructor) units.push({ name: 'constructor', node: member, member: false });
  }
  for (const statement of list(sf, 'statements')) {
    if (statement.kind === SyntaxKind.FunctionDeclaration) {
      const name = textOf(has(statement, 'name'));
      if (name !== undefined) units.push({ name, node: statement, member: false });
    }
    if (statement.kind === SyntaxKind.VariableStatement) {
      const declarations = has(has(statement, 'declarationList') as Node, 'declarations') as unknown as readonly Node[];
      for (const each of declarations) {
        const name = textOf(has(each, 'name'));
        if (name !== undefined) units.push({ name, node: each, member: false });
      }
    }
  }
  return units;
};

const contains = (outer: Node, inner: Node): boolean => inner.pos >= outer.pos && inner.end <= outer.end;

/** The names a unit mentions: `this.name`, `x.name`, a bare identifier. */
function mentions(unit: Node): Set<string> {
  const names = new Set<string>();
  const walk = (node: Node): void => {
    if (node.kind === SyntaxKind.Identifier) {
      const text = textOf(node);
      if (text !== undefined) names.add(text);
    }
    node.forEachChild(walk);
  };
  walk(unit);
  return names;
}

/** The names of the class members that reach one of `reads` (a read inside the member, or inside what it mentions). */
export function linkCapableMembers(sf: Node, declaration: Node, reads: readonly Node[]): Set<string> {
  const units = unitsOf(sf, declaration);
  const capable = new Set<Unit>(units.filter(unit => reads.some(read => contains(unit.node, read))));
  const mentioned = new Map(units.map(unit => [unit, mentions(unit.node)] as const));
  for (let grew = true; grew; ) {
    grew = false;
    for (const unit of units) {
      if (capable.has(unit)) continue;
      const names = mentioned.get(unit) ?? new Set<string>();
      // A unit is capable when it mentions a capable unit's name (never its own).
      if ([...capable].some(other => other !== unit && names.has(other.name))) {
        capable.add(unit);
        grew = true;
      }
    }
  }
  return new Set([...capable].filter(unit => unit.member).map(unit => unit.name));
}
