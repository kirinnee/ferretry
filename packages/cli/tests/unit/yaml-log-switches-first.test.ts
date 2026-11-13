import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

// Merge-bar line 2: `LOG_TOKENS` / `LOG_STREAM` are cleared in `fy`. Unlike `fyd`, the `fy` shell parses no YAML in its own
// process (the daemon reads configuration), so no spawn can show the leak: there is nothing of `fy`'s own to print. What
// can be pinned is the call itself, read from the syntax tree (never a regex over the text): `clearYamlLogSwitches()` is
// the FIRST statement of the full program's `execute` (`bin/program.ts`, which `bin/fy.ts` loads for every invocation but a
// ferret's `mcp serve`), before anything is built or parsed. The slim `mcp serve` root (`bin/mcp-serve.ts`) loads no YAML
// library at all, which is why it has nothing to clear and why it must stay that way: the second pin below.

type Node = { readonly type?: string; readonly [key: string]: unknown };
const asNode = (value: unknown): Node | undefined =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string' ? (value as Node) : undefined;

/** The callee's name when `statement` is the expression statement `name();`, otherwise undefined. */
function calledName(statement: Node | undefined): string | undefined {
  if (statement?.type !== 'ExpressionStatement') return undefined;
  const call = asNode(statement.expression);
  const callee = asNode(call?.callee);
  return call?.type === 'CallExpression' && callee?.type === 'Identifier' ? String(callee.name) : undefined;
}

/** Whether `test` is `import.meta.main`. */
function isImportMetaMain(test: Node | undefined): boolean {
  const meta = asNode(test?.object);
  const property = asNode(test?.property);
  return (
    test?.type === 'MemberExpression' &&
    meta?.type === 'MetaProperty' &&
    property?.type === 'Identifier' &&
    property.name === 'main'
  );
}

/** The imports a file declares, by specifier. */
function importSpecifiers(file: string, source: string): readonly string[] {
  const body = (parseSync(file, source).program as unknown as { readonly body: readonly Node[] }).body;
  return body
    .map(asNode)
    .filter(node => node?.type === 'ImportDeclaration')
    .map(node => String(asNode(node?.source)?.value));
}

/** The call names of the statements of the exported function `name`, in order. */
function functionCalls(file: string, source: string, name: string): readonly (string | undefined)[] {
  const body = (parseSync(file, source).program as unknown as { readonly body: readonly Node[] }).body;
  const declared = body
    .map(asNode)
    .map(node => (node?.type === 'ExportNamedDeclaration' ? asNode(node.declaration) : node))
    .find(node => node?.type === 'FunctionDeclaration' && asNode(node.id)?.name === name);
  const block = asNode(declared?.body);
  expect(block?.type).toBe('BlockStatement');
  return ((block?.body as readonly unknown[]) ?? []).map(statement => calledName(asNode(statement)));
}

/** The call names of the main block's statements, in order. */
function mainBlockCalls(file: string, source: string): readonly (string | undefined)[] {
  const body = (parseSync(file, source).program as unknown as { readonly body: readonly Node[] }).body;
  const guard = body.map(asNode).find(node => node?.type === 'IfStatement' && isImportMetaMain(asNode(node.test)));
  const block = asNode(guard?.consequent);
  expect(block?.type).toBe('BlockStatement');
  return ((block?.body as readonly unknown[]) ?? []).map(statement => calledName(asNode(statement)));
}

test('the guard reads the first statement of the main block, so a moved or removed call is seen', () => {
  const calls = (text: string) => mainBlockCalls('x.ts', text);
  expect(calls('if (import.meta.main) { clearYamlLogSwitches(); build(); }')[0]).toBe('clearYamlLogSwitches');
  expect(calls('if (import.meta.main) { build(); clearYamlLogSwitches(); }')[0]).toBe('build');
  expect(calls('if (import.meta.main) { const w = build(); clearYamlLogSwitches(); }')[0]).toBeUndefined();
  expect(calls('if (import.meta.main) { build(); }')).not.toContain('clearYamlLogSwitches');
});

test('fy clears the yaml log switches FIRST in the full program', () => {
  const file = join(import.meta.dir, '../../bin/program.ts');
  expect(functionCalls(file, readFileSync(file, 'utf8'), 'execute')[0]).toBe('clearYamlLogSwitches');
});

test('the host file sends everything to a composition root and loads nothing that parses YAML itself', () => {
  const file = join(import.meta.dir, '../../bin/fy.ts');
  const source = readFileSync(file, 'utf8');
  expect(importSpecifiers(file, source).filter(specifier => specifier.includes('yaml'))).toEqual([]);
  expect(mainBlockCalls(file, source)).not.toContain('clearYamlLogSwitches');
});

test('the slim mcp serve root loads no YAML library, so it has no log switch to clear', () => {
  const file = join(import.meta.dir, '../../bin/mcp-serve.ts');
  expect(importSpecifiers(file, readFileSync(file, 'utf8')).filter(specifier => specifier.includes('yaml'))).toEqual(
    [],
  );
});
