import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextFor } from '../lib/check.ts';
import { check, macrosIn } from '../../validate/no-macros.ts';

const root = mkdtempSync(join(tmpdir(), 'no-macros-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function file(rel: string, text: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('no-macros', () => {
  test('planted: an import, a named re-export and a star re-export with type macro are each found', () => {
    const found = macrosIn(
      file(
        'planted.ts',
        "import { a } from './a.ts' with { type: 'macro' };\n" +
          'export { b } from \'./b.ts\' with { type: "macro" };\n' +
          "export * from './c.ts' with { type: 'macro' };\n",
      ),
      'planted.ts',
    );
    expect(found.map(f => f.where)).toEqual(['planted.ts:1', 'planted.ts:2', 'planted.ts:3']);
    expect(found[0]?.message).toContain('"./a.ts"');
  });

  test('clean: json and text imports, a plain import, and the word macro in a string or comment', () => {
    const found = macrosIn(
      file(
        'clean.ts',
        "import data from './d.json' with { type: 'json' };\nimport text from './t.yaml' with { type: 'text' };\n" +
          "import { x } from './x.ts';\n// a macro import would be refused\n" +
          "export const source = \"import { y } from './y.ts' with { type: 'macro' }\";\nexport { data, text, x };\n",
      ),
    );
    expect(found).toEqual([]);
  });

  test('the whole check reads package tests and scripts/, not only product source', async () => {
    file('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/plugins/*'] }));
    file('packages/plugins/alpha/package.json', JSON.stringify({ name: '@fixture/alpha' }));
    file('packages/plugins/alpha/daemon/index.ts', 'export const alpha = 1;\n');
    file(
      'packages/plugins/alpha/tests/unit/a.test.ts',
      "import { alpha } from '../../daemon/index.ts' with { type: 'macro' };\nconsole.log(alpha);\n",
    );
    file('scripts/gen/inline.ts', "import { alpha } from '../x.ts' with { type: 'macro' };\nconsole.log(alpha);\n");

    const found = await check.run(contextFor(root));

    expect(found.map(f => f.where).sort()).toEqual([
      'packages/plugins/alpha/tests/unit/a.test.ts:1',
      'scripts/gen/inline.ts:1',
    ]);
  });

  test('the whole check reads every module Bun loads (an .mjs re-export, a .js import), never node_modules or dist/', async () => {
    file('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/plugins/*'] }));
    file('packages/plugins/beta/package.json', JSON.stringify({ name: '@fixture/beta' }));
    file('packages/plugins/beta/re-export.mjs', "export * from './a.ts' with { type: 'macro' };\n");
    file(
      'packages/plugins/beta/daemon/common.cjs',
      "const a = require('./a.ts');\nmodule.exports = { a, note: 'macro' };\n",
    );
    file(
      'packages/plugins/beta/dist/bundle.js',
      "import { a } from './a.ts' with { type: 'macro' };\nconsole.log(a);\n",
    );
    file(
      'packages/plugins/beta/node_modules/dep/index.js',
      "import { a } from './a.ts' with { type: 'macro' };\nconsole.log(a);\n",
    );
    file('scripts/entry.js', "import { a } from './a.ts' with { type: 'macro' };\nconsole.log(a);\n");

    const found = (await check.run(contextFor(root))).map(f => f.where);

    expect(found).toContain('packages/plugins/beta/re-export.mjs:1');
    expect(found).toContain('scripts/entry.js:1');
    expect(found.filter(where => where.startsWith('packages/plugins/beta/'))).toEqual([
      'packages/plugins/beta/re-export.mjs:1',
    ]);
  });
});
