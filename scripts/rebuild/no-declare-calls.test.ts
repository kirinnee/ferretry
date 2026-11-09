import { expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';

// Bun 1.3.x reads a statement that calls a function named `declare` as the TypeScript modifier and erases it, so the
// rebuild scripts must never define or call an identifier with that name. The real `declare` keyword is untouched.
const root = join(import.meta.dir, '..', '..');

type Node = { readonly type?: string; readonly [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

function declareIdentifiers(file: string, source: string): readonly string[] {
  const program = parseSync(file, source).program as unknown as Node;
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    const named = (identifier: unknown) =>
      isNode(identifier) && identifier.type === 'Identifier' && identifier.name === 'declare';
    if (node.type === 'CallExpression' && named(node.callee)) found.push('a call to declare(...)');
    if (node.type === 'VariableDeclarator' && named(node.id)) found.push('a binding named declare');
    if (node.type === 'FunctionDeclaration' && named(node.id)) found.push('a function named declare');
    for (const value of Object.values(node)) visit(value);
  };
  visit(program);
  return found;
}

test('no script under scripts/rebuild defines or calls an identifier named declare (Bun 1.3.x erases it)', async () => {
  const offenders: string[] = [];
  for await (const path of new Bun.Glob('scripts/rebuild/**/*.ts').scan({ cwd: root, absolute: true })) {
    for (const finding of declareIdentifiers(path, await Bun.file(path).text()))
      offenders.push(`${relative(root, path)}: ${finding}`);
  }
  expect(offenders).toEqual([]);
});

test('the guard flags the old shape and leaves the TypeScript keyword alone', () => {
  const old = 'const declare = (a: number) => a;\ndeclare(1);\nfunction declare() {}';
  expect(declareIdentifiers('planted.ts', old)).toEqual([
    'a binding named declare',
    'a call to declare(...)',
    'a function named declare',
  ]);
  expect(declareIdentifiers('keyword.ts', 'declare const x: number;\ndeclare function f(): void;')).toEqual([]);
});
