import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSync } from 'oxc-parser';

// Merge-bar line 2: `LOG_TOKENS` / `LOG_STREAM` are cleared in `fyd`. The `yaml` library prints every token it parses
// when either is set, and a configuration text may carry a credential, so `clearYamlLogSwitches()` must be the FIRST
// statement of `main()`, before the command line, the settings or the config are read.
//
// Why the syntax tree and not a spawn: `fyd --check` is the cheapest path that parses YAML, and it prints the token dump
// whether or not the call is there (that parse runs outside what deleting the variable from `process.env` reaches: the
// output is the same with the call removed), so a spawn of it cannot tell the call is gone. Booting the daemon for the
// proof would be slow and timing-dependent. So the call is read from the tree (oxc-parser, never a regex over the text).

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

/** The call names of `function main`'s statements, in order (undefined for a statement that is not `name();`). */
function mainCalls(file: string, source: string): readonly (string | undefined)[] {
  const body = (parseSync(file, source).program as unknown as { readonly body: readonly Node[] }).body;
  const main = body.map(asNode).find(node => node?.type === 'FunctionDeclaration' && asNode(node.id)?.name === 'main');
  const block = asNode(main?.body);
  expect(block?.type).toBe('BlockStatement');
  return ((block?.body as readonly unknown[]) ?? []).map(statement => calledName(asNode(statement)));
}

test('the guard reads the first statement of main(), so a moved or removed call is seen', () => {
  const calls = (text: string) => mainCalls('x.ts', text);
  expect(calls('async function main() { clearYamlLogSwitches(); build(); }')[0]).toBe('clearYamlLogSwitches');
  expect(calls('async function main() { build(); clearYamlLogSwitches(); }')[0]).toBe('build');
  expect(calls('async function main() { const a = 1; clearYamlLogSwitches(); }')[0]).toBeUndefined();
  expect(calls('async function main() { build(); }')).not.toContain('clearYamlLogSwitches');
});

test('fyd clears the yaml log switches FIRST in main()', () => {
  const file = join(import.meta.dir, '../../../host/fyd.ts');
  expect(mainCalls(file, readFileSync(file, 'utf8'))[0]).toBe('clearYamlLogSwitches');
});
