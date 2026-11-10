/**
 * How a test file names the guarantee rows it proves, read the one way by `guarantees` (existence, owner) and
 * `parity-ticks` (the live title of a ticked row). Two forms count, and nothing else:
 *
 *   1. a LITERAL `test(` / `it(` title that starts with row ids, each id leading its own word: `'R42 …'` names R42,
 *      `'R42 R43 …'` names both. An id later in the title (`'… R42'`) names nothing here.
 *   2. a call of THE guarantee helper: `guarantee(['R42', 'R43'], 'name', run)`, which runs one `it('<id> <name>')` per
 *      id. It is one function with one meaning: it is `guarantee`, exported by the support module
 *      `tests/support/guarantee.ts` of the package, and the call counts only in a file that IMPORTS it from there. A call
 *      of any other name, or of a `guarantee` the file declares itself, is an ordinary call and counts as nothing.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AstNode } from '../gen/lib/check.ts';

/** The helper's exported name, and the support module (a path suffix) it must be imported from. */
export const GUARANTEE_HELPER = 'guarantee';
export const GUARANTEE_SUPPORT = 'tests/support/guarantee.ts';

/** One row id: letters, digits, an optional lowercase split letter (`R42`, `P135`, `G3a`). */
const ID = '[A-Z]+[0-9]+[a-z]?';
const BOUNDARY = '(?=[\\s\'"`:.,]|$)';
const LEADING_IDS = new RegExp(`^(${ID}(?: ${ID})*)${BOUNDARY}`);

/** Every row id a title starts with, each leading its own space-separated word: `R42 R43 holds` → R42, R43. */
export function leadingIds(title: string): string[] {
  const head = LEADING_IDS.exec(title)?.[1];
  return head === undefined ? [] : head.split(' ');
}

const str = (node: unknown): string | undefined => {
  const n = node as AstNode | undefined;
  return n?.type === 'Literal' && typeof n.value === 'string' ? n.value : undefined;
};

/** A title the helper calls its test with: a plain string, or a template whose holes become an alphanumeric sentinel. */
function literalTitle(node: unknown): string | undefined {
  const n = node as AstNode | undefined;
  if (str(n) !== undefined) return str(n);
  if (n?.type === 'TemplateLiteral')
    return (n.quasis as { value: { cooked?: string; raw: string } }[])
      .map(q => q.value.cooked ?? q.value.raw)
      .join('X');
  return undefined;
}

/**
 * The local name `guarantee` is bound to in this file when it is the helper: imported (a value import, no alias) from a
 * relative module that resolves to the package's `tests/support/guarantee.ts`, which exists. Otherwise `undefined`.
 */
export function helperBinding(
  program: AstNode,
  file: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  for (const stmt of (program.body as AstNode[]) ?? []) {
    if (stmt.type !== 'ImportDeclaration' || stmt.importKind === 'type') continue;
    const source = str(stmt.source);
    if (source === undefined || !source.startsWith('.')) continue;
    for (const spec of (stmt.specifiers as AstNode[]) ?? []) {
      if (spec.type !== 'ImportSpecifier' || spec.importKind === 'type') continue;
      const imported = (spec.imported as { name?: string; value?: string }) ?? {};
      const local = (spec.local as { name?: string }) ?? {};
      if ((imported.name ?? imported.value) !== GUARANTEE_HELPER || local.name !== GUARANTEE_HELPER) continue;
      const target = resolve(dirname(file), source);
      const path = /\.[cm]?[jt]sx?$/.test(target) ? target : `${target}.ts`;
      if (path.endsWith(`/${GUARANTEE_SUPPORT}`) && exists(path)) return GUARANTEE_HELPER;
    }
  }
  return undefined;
}

/**
 * The titles one call of the helper runs, `<id> <name>` per id, or `undefined` when the call is not one: the callee is
 * not the imported binding, or the arguments are not `([literal ids…], name, run)`.
 */
export function helperCallTitles(node: AstNode, binding: string | undefined): string[] | undefined {
  if (binding === undefined || node.type !== 'CallExpression') return undefined;
  const callee = node.callee as AstNode;
  if (callee.type !== 'Identifier' || callee.name !== binding) return undefined;
  const [idsArg, nameArg] = node.arguments as AstNode[];
  if (idsArg?.type !== 'ArrayExpression') return undefined;
  const ids: string[] = [];
  for (const element of idsArg.elements as AstNode[]) {
    const id = str(element);
    // A guarantee row (`R42`) or a parity row (`J-0052`): one token, nothing else.
    if (id === undefined || !/^[A-Z]+-?[0-9]+[a-z]?$/.test(id)) return undefined;
    ids.push(id);
  }
  const name = literalTitle(nameArg) ?? '';
  return ids.map(id => `${id} ${name}`);
}
