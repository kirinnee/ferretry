import { expect, test } from 'bun:test';
import { join, relative } from 'node:path';
import { parseSync } from 'oxc-parser';

// Bun 1.3.x reads ANY statement that starts with the identifier `declare` (a call, an assignment, a member call or
// write, `++`, a tagged template) as the TypeScript modifier and erases it, so a script must never use that identifier
// at all. The real `declare` keyword is a flag in the syntax tree, not an identifier, and stays untouched. What stays
// allowed is the name where it is only a name: a non-computed property key or a non-computed member property.
const root = join(import.meta.dir, '..', '..');

type Node = { readonly type?: string; readonly [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

// The node types whose `key` is a name (not an expression) unless the node says `computed`.
const KEYED = new Set([
  'Property',
  'MethodDefinition',
  'PropertyDefinition',
  'AccessorProperty',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSEnumMember',
]);

function declareIdentifiers(file: string, source: string): readonly string[] {
  const program = parseSync(file, source).program as unknown as Node;
  const found: string[] = [];
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    if (node.type === 'Identifier' && node.name === 'declare') {
      found.push(`an identifier named declare (line ${lineOf(Number(node.start))})`);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const name =
        (KEYED.has(String(node.type)) && key === 'key' && node.computed !== true) ||
        (node.type === 'MemberExpression' && key === 'property' && node.computed !== true) ||
        (node.type === 'TSQualifiedName' && key === 'right');
      if (name) continue;
      visit(value);
    }
  };
  visit(program);
  return found;
}

test('the guard flags a declare call, an escaped spelling of the name and a bare statement, and lets a property name through', () => {
  expect(declareIdentifiers('a.ts', 'declare();')).toHaveLength(1);
  expect(declareIdentifiers('a.ts', 'd\\u0065clare();')).toHaveLength(1);
  expect(declareIdentifiers('a.ts', 'declare = 1;')).toHaveLength(1);
  expect(declareIdentifiers('a.ts', 'const o = { declare: 1 }; o.declare;')).toEqual([]);
});

test('no script under scripts/ uses an identifier named declare (Bun 1.3.x erases a statement that starts with it)', async () => {
  const offenders: string[] = [];
  for await (const path of new Bun.Glob('scripts/**/*.{ts,tsx}').scan({ cwd: root, absolute: true })) {
    for (const finding of declareIdentifiers(path, await Bun.file(path).text()))
      offenders.push(`${relative(root, path)}: ${finding}`);
  }
  expect(offenders).toEqual([]);
});

const FLAGGED: Readonly<Record<string, string>> = {
  'a binding': 'const declare = (a: number) => a;',
  'a function declaration': 'function declare() {}',
  'a class name': 'class declare {}',
  'a statement-position call': 'declare(1);',
  'a guarded call': 'if (x) declare(1);',
  'an optional call': 'declare?.(1);',
  'an assignment': 'declare = 5;',
  'a member write': 'declare.x = 5;',
  'a member call': 'declare.run();',
  'an increment': 'declare++;',
  'a tagged template': 'declare`x`;',
  'a sequence': 'declare(1), declare(2);',
  'a destructured binding': 'const { declare } = o; declare.run();',
  'an aliased destructuring target': 'const { a: declare } = o;',
  'an import binding': "import { declare } from './x'; declare.run();",
  'a default import': "import declare from './x';",
  'a parameter': 'function f(declare) { declare.x = 1; }',
  'an arrow parameter': 'const f = declare => declare.x;',
  'a catch parameter': 'try { f(); } catch (declare) { declare.message = ""; }',
  'a computed key': 'const o = { [declare]: 1 };',
  'a computed member': 'const v = o[declare];',
  'an argument': 'f(declare);',
  'a call in an expression': 'const x = [declare(1)];',
};
for (const [shape, source] of Object.entries(FLAGGED)) {
  test(`the guard flags ${shape}: ${source}`, () => {
    expect(declareIdentifiers('planted.ts', source).length).toBeGreaterThan(0);
  });
}

const ALLOWED: Readonly<Record<string, string>> = {
  'the TypeScript keyword on a const': 'declare const x: number;',
  'the TypeScript keyword on a function': 'declare function f(): void;',
  'the TypeScript keyword on a module': "declare module 'x' {}",
  'the TypeScript keyword on a global': 'declare global { interface Window { a: number } }',
  'a class field modifier': 'class A { declare x: number; }',
  'a member call': 'obj.declare(1);',
  'a member read': 'const v = obj.declare;',
  'an optional member call': 'obj?.declare(1);',
  'an object key': 'const o = { declare: 1 };',
  'a method key': 'const o = { declare() {} };',
  'a class method': 'class A { declare() {} }',
  'a class property': 'class A { declare = 1; }',
  'a type member': 'type T = { declare: string };',
  'an interface method': 'interface I { declare(): void }',
};
for (const [shape, source] of Object.entries(ALLOWED)) {
  test(`the guard leaves ${shape} alone: ${source}`, () => {
    expect(declareIdentifiers('keyword.ts', source)).toEqual([]);
  });
}
