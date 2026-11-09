import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findings, inScope, KERNEL_READER, LEDGER, parseLedger, scanFile } from './no-raw-yaml.ts';

const root = join(import.meta.dir, '../..');
const PATH = 'packages/plugins/x/daemon/a.ts';

/** The findings for one planted product file with no ledger at all. */
const planted = (text: string, path = PATH): readonly string[] => findings([{ path, text }], '');

/**
 * The files on the ledger that are still there after the five plugin readers (logins, browsers, usage x2, voice) were
 * routed through the shared reader: the reader itself, board's write-only `stringify`, and the two chart fences.
 */
const ORIGINAL_LEDGER = [
  'packages/std/src/yaml-text.ts',
  'packages/plugins/board/cli/lib/patch-document.ts',
  'packages/plugins/conversation/app/render/fy-render-chart-model.ts',
  'packages/plugins/conversation/app/render/fy-render-map-model.ts',
];

/**
 * The whole-tree scan parses every tracked product file (~8000) into a syntax tree: about 3 s on a developer machine
 * and more than bun's 5 s default on a loaded CI runner, where the test was killed (status null) with NO finding. The
 * bound is explicit so a slow runner is not a failed gate, and a real hang still fails.
 */
const WHOLE_TREE_SCAN_MS = 120_000;

describe('the raw-YAML gate on this repository', () => {
  test(
    'is clean against its own ledger',
    () => {
      const run = spawnSync('bash', [join(root, 'scripts/validate/no-raw-yaml.sh')], {
        cwd: root,
        encoding: 'utf8',
        timeout: WHOLE_TREE_SCAN_MS - 10_000,
      });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
    },
    WHOLE_TREE_SCAN_MS,
  );

  test('still lists the entries that remain, and no reason claims a text was "already checked"', () => {
    const { files, problems } = parseLedger(readFileSync(join(root, LEDGER), 'utf8'));
    expect(problems).toEqual([]);
    for (const path of ORIGINAL_LEDGER) expect(files.has(path), path).toBe(true);
    // A text the daemon SERVES is a refused text too: "checked" was never true.
    for (const [path, reason] of files) expect(reason, path).not.toMatch(/already checked/iu);
  });

  test('the five plugin readers are gone from the ledger: they read through @ferretry/std/yaml', () => {
    const { files } = parseLedger(readFileSync(join(root, LEDGER), 'utf8'));
    for (const gone of [
      'packages/plugins/logins/daemon/lib/shared/yaml-text.ts',
      'packages/plugins/browsers/app/lib/browsers-config.ts',
      'packages/plugins/usage/app/lib/config-text.ts',
      'packages/plugins/usage/cli/lib/config-text.ts',
      'packages/plugins/voice/app/lib/config-text.ts',
    ])
      expect(files.has(gone), gone).toBe(false);
  });
});

describe('every way past the old line matcher is found', () => {
  // Each fixture is one bypass shape R9 (m2) listed or implied; each must FAIL the guard.
  const SHAPES: Readonly<Record<string, string>> = {
    'Bun.YAML.parse': 'const v = Bun.YAML.parse(text);',
    'spaces in the chain': 'const v = Bun .YAML. parse(text);',
    'member chain split over lines': 'const v = Bun\n  .YAML\n  .parse(text);',
    'optional chain': 'const v = Bun?.YAML.parse(text);',
    'string key': "const v = Bun['YAML'].parse(text);",
    'template key': 'const v = Bun[`YAML`].parse(text);',
    'key that cannot be read': 'const v = Bun[name].parse(text);',
    'globalThis.Bun': 'const v = globalThis.Bun.YAML.parse(text);',
    'bare YAML handed on': 'export const reader = Bun.YAML;',
    'a name for Bun': 'const b = Bun; const v = b.YAML.parse(text);',
    'a name for a name for Bun': 'const a = Bun; const b = a; const v = b.YAML.parse(text);',
    'a name for Bun.YAML': 'const Y = Bun.YAML; const v = Y.parse(text);',
    'import { YAML } from bun': "import { YAML } from 'bun';\nconst v = YAML.parse(text);",
    'import { YAML as Y } from bun': "import { YAML as Y } from 'bun';\nconst v = Y.parse(text);",
    'aliased import, parse taken out': "import { YAML as Y } from 'bun';\nconst { parse } = Y;\nparse(text);",
    'aliased import handed on': "import { YAML as Y } from 'bun';\nexport { Y };",
    'namespace import of bun': "import * as B from 'bun';\nconst v = B.YAML.parse(text);",
    'default import of bun': "import B from 'bun';\nconst v = B.YAML.parse(text);",
    'namespace import, bracket key': "import * as B from 'bun';\nconst v = B['YAML'].parse(text);",
    'destructure out of Bun': 'const { YAML } = Bun;\nYAML.parse(text);',
    'destructure with a new name': 'const { YAML: Y } = Bun;\nY.parse(text);',
    'multi-line destructure': 'const {\n  YAML: Y,\n} = Bun;\nY.parse(text);',
    'destructure by string key': "const { 'YAML': Y } = Bun;\nY.parse(text);",
    'destructure with a computed key': 'const { [key]: Y } = Bun;',
    'destructure with a rest element': 'const { file, ...rest } = Bun;',
    'destructure of globalThis.Bun': 'const { YAML } = globalThis.Bun;',
    'destructure of a name for Bun': 'const b = Bun;\nconst { YAML } = b;',
    'destructure by assignment': 'let Y;\n({ YAML: Y } = Bun);',
    'nested destructure': 'const { YAML: { parse } } = Bun;\nparse(text);',
    'destructure from the default export': "const { default: { YAML } } = await import('bun');",
    're-export of YAML from bun': "export { YAML } from 'bun';",
    're-export of YAML from bun, renamed': "export { YAML as Y } from 'bun';",
    'export * from bun': "export * from 'bun';",
    'dynamic import of bun, awaited': "const B = await import('bun');\nB.YAML.parse(text);",
    'dynamic import of bun, inline': "const v = (await import('bun')).YAML.parse(text);",
    'dynamic import of bun, destructured': "const { YAML } = await import('bun');",
    'dynamic import of bun, then': "const v = import('bun').then(m => m.YAML.parse(text));",
    'require of bun': "const v = require('bun').YAML.parse(text);",
    'bare YAML.parse': 'const v = YAML.parse(text);',
    'yaml: named import': "import { parse } from 'yaml';",
    'yaml: type-only import': "import type { Document } from 'yaml';",
    'yaml: multi-line import': "import {\n  parseDocument,\n  isMap,\n} from\n  'yaml';",
    'yaml: namespace import': "import * as y from 'yaml';",
    'yaml: default import': "import y from 'yaml';",
    'yaml: side-effect import': "import 'yaml';",
    'yaml: subpath': "import { parse } from 'yaml/browser/dist/index.js';",
    'yaml: dynamic import': "const y = await import('yaml');",
    'yaml: dynamic import, template literal': 'const y = await import(`yaml`);',
    'yaml: require': "const y = require('yaml');",
    'yaml: import equals': "import y = require('yaml');",
    'yaml: re-export': "export { parse } from 'yaml';",
    'yaml: export *': "export * from 'yaml';",
    'js-yaml': "import jsYaml from 'js-yaml';",
    '@std/yaml': "import { parse } from '@std/yaml';",
    'jsr: @std/yaml': "import { parse } from 'jsr:@std/yaml';",
    yamljs: "import YAML from 'yamljs';",
    'another yaml package': "import { load } from 'some-yaml-reader';",
    // Bun's module loader parses YAML itself (guard review M1): a path read off the disk, or a YAML file it loads.
    'a module name built at run time': 'const m = await import(path);',
    'a module name built at run time, template': 'const m = await import(`${home}/gate.yaml`);',
    'a module name built at run time, require': 'const m = require(path);',
    'a module name built at run time, import.meta.require': 'const m = import.meta.require(path);',
    'a view loader that climbs out of its folder': 'const v = await import(`./views/${name}/../../x.tsx`);',
    'a view loader that is not a tsx file': 'const v = await import(`./views/${name}`);',
    'a static .yaml import': "import cfg from './gate.yaml';",
    'a static .yml require': "const cfg = require('./gate.yml');",
    'a static .yaml dynamic import': "const cfg = await import('./gate.yaml');",
    'a static .yaml re-export': "export { default } from './gate.yaml';",
    'an import with type yaml': "import cfg from './gate.txt' with { type: 'yaml' };",
    'a dynamic import with type yaml': "const cfg = await import('./gate.txt', { with: { type: 'yaml' } });",
    'import attributes it cannot read': "const cfg = await import('./gate.txt', options);",
    // The plain loaders besides a bare `require` (guard review M2).
    'import.meta.require of bun': "const v = import.meta.require('bun').YAML.parse(text);",
    'import.meta.require of yaml': "const y = import.meta.require('yaml');",
    'module.require of yaml': "const y = module.require('yaml');",
    // pm2 #2 / BG-069: the loader's name spelled in pieces, and the entry module's own `require`.
    "module['req' + 'uire'] of a built path": "const r = module['req' + 'uire'];\nr(path);",
    "import.meta['req' + 'uire'] of a built path": "const r = import.meta['req' + 'uire'];\nr(path);",
    "module['req' + 'uire'] called at once": "module['req' + 'uire'](path);",
    'a member of module whose name cannot be read': 'const r = module[key];\nr(path);',
    'process.mainModule.require of a built path': 'process.mainModule.require(path);',
    'process.mainModule?.require of yaml': "process.mainModule?.require('yaml');",
    "Bun['YA' + 'ML']": "const v = Bun['YA' + 'ML'].parse(text);",
    'createRequire, called at once':
      "import { createRequire } from 'node:module';\nconst y = createRequire(import.meta.url)('yaml');",
    'createRequire, renamed and bound':
      "import { createRequire as cr } from 'node:module';\nconst r = cr(import.meta.url);\nr('yaml');",
    'createRequire, through a namespace':
      "import * as m from 'node:module';\nm.createRequire(import.meta.url)('yaml');",
    'a require declared as a createRequire loader and called with a run-time path':
      "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst m = require(path);",
    'a name for require': "const r = require;\nr('yaml');",
    'a name for import.meta.require, of bun':
      "const r = import.meta.require;\nconst B = r('bun');\nB.YAML.parse(text);",
    'a required bun bound to a name': "const B = require('bun');\nB.YAML.parse(text);",
    'a required bun bound by import.meta.require': "const B = import.meta.require('bun');\nconst { YAML } = B;",
    // Guard R2 chores: a view loader outside app code, a loader handed on as a value, and the forms of loader names.
    'a view loader in daemon code (a hole can be ../gate.yaml?)':
      'const v = (name: string) => import(`./views/${name}.tsx`);',
    'require.call with a run-time path': 'const m = require.call(null, path);',
    'require.apply': 'const m = require.apply(null, [path]);',
    'require.bind': 'const load = require.bind(null);\nload(path);',
    'import.meta.require.call': 'const m = import.meta.require.call(null, path);',
    'module.require.call': 'const m = module.require.call(module, path);',
    'a loader mapped over paths': 'const all = paths.map(require);',
    'import.meta.require mapped over paths': 'const all = paths.map(import.meta.require);',
    'a loader handed to a function in brackets': 'run((require as NodeRequire));',
    'a createRequire loader handed on':
      "import { createRequire } from 'node:module';\nrun(createRequire(import.meta.url));",
    'a name for a loader handed on': 'const r = require;\nrun(r);',
    'createRequire renamed by a destructure of a dynamic import':
      "const { createRequire: cr } = await import('node:module');\ncr(import.meta.url)('yaml');",
    'createRequire renamed by a destructure of a dynamic import, run-time path':
      "const { createRequire: cr } = await import('node:module');\nconst m = cr(import.meta.url)(path);",
    'createRequire renamed by a destructure of a require':
      "const { createRequire: cr } = require('node:module');\ncr(import.meta.url)(path);",
    'createRequire given another name':
      "import { createRequire } from 'node:module';\nconst cr = createRequire;\ncr(import.meta.url)(path);",
    'import.meta in brackets': "const y = (import.meta).require('bun').YAML.parse(text);",
    'import.meta in brackets, run-time path': 'const m = (import.meta).require(path);',
    'module in brackets': 'const m = (module).require(path);',
    'a require parameter in ANOTHER function does not hide the loader':
      'function g(require: unknown) {\n  return require;\n}\nconst m = require(path);',
    'a require declared in another block does not hide the loader':
      'function g() {\n  const require = (x: string) => x;\n  return require;\n}\nconst m = require(path);',
    'a let require given a loader afterwards':
      "import { createRequire } from 'node:module';\nlet require;\nrequire = createRequire(import.meta.url);\nconst m = require(path);",
    'a var require given a loader afterwards':
      "import { createRequire } from 'node:module';\nvar require;\nrequire = createRequire(import.meta.url);\nconst m = require(path);",
    'a let require given a loader by ||=':
      "import { createRequire } from 'node:module';\nlet require = null;\nrequire ||= createRequire(import.meta.url);\nexport const f = p => require(p);",
    'a let require given a loader by ??=':
      "import { createRequire } from 'node:module';\nlet require = null;\nrequire ??= createRequire(import.meta.url);\nexport const f = p => require(p);",
    'a let require given a loader by &&=':
      "import { createRequire } from 'node:module';\nlet require = null;\nrequire &&= createRequire(import.meta.url);\nexport const f = p => require(p);",
    'a loader kept in a property':
      "import { createRequire } from 'node:module';\nconst box = {};\nbox.r = createRequire(u);\nbox.r(p);",
    'an escaped require handed to call': 'const m = r\\u0065quire.call(null, p);',
    'an escaped require handed on as a value': 'const ms = ps.map(r\\u0065quire);',
  };
  for (const [shape, text] of Object.entries(SHAPES))
    test(shape, () => {
      const found = planted(`x\n${text}\ny`);
      expect(found.length, text).toBeGreaterThan(0);
      for (const finding of found) expect(finding).toContain(`${PATH}:`);
    });

  // Writing YAML reads nothing, and a word in prose or a path is not a parse.
  const FINE: Readonly<Record<string, string>> = {
    'Bun.YAML.stringify': 'Bun.YAML.stringify(value, null, 2);',
    'imported YAML, stringify only': "import { YAML } from 'bun';\nYAML.stringify(value);",
    'yaml-text as a comment': '// a YAML file, parsed elsewhere',
    'the word as a string': "const name = 'yaml';",
    'a relative path to a yaml-named file': "import { readConfigText } from './yaml-text.ts';",
    'a relative path, dynamic': "const t = await import('../yaml-text.ts');",
    'the shared bounded reader, by its package subpath':
      "import { readConfigText, setConfigKey } from '@ferretry/std/yaml';\nreadConfigText('');",
    'other Bun members': "const f = Bun.file('x'); const { spawn } = Bun;",
    'a property that is only named YAML': 'const o = { YAML: 1 }; o.YAML;',
    'a type that mentions it': "type T = typeof import('yaml');\nconst x: typeof Bun.YAML = 1 as never;",

    'a .yaml read as text': "import catalog from './catalog.yaml' with { type: 'text' };",
    'a .yaml path as a file': "import where from './catalog.yaml' with { type: 'file' };",
    'a .yaml read as text, dynamic': "const t = await import('./catalog.yaml', { with: { type: 'text' } });",
    'a method that is only named require': 'await this.require(file);\npanes.require(ferret);',
    'import.meta.url': 'const here = new URL(import.meta.url);',
    'a function of its own named require': 'const require = async (id: string) => id;\nawait require(ferretId);',
    'a parameter named require, used inside its function':
      'function g(require: (id: string) => string) {\n  return require(path);\n}',
    'an arrow parameter named require': 'const g = (require: (id: string) => string) => require(path);',
    'a block-scoped require used inside its block': '{\n  const require = (x: string) => x;\n  require(path);\n}',
    'a function declaration named require': 'function require(id: string) {\n  return id;\n}\nrequire(path);',
    'a require in a catch clause': 'try {\n  run();\n} catch (require) {\n  require(path);\n}',
    'typeof require': "if (typeof require !== 'undefined') run();",
    'require.resolve': "const where = require.resolve('x');",
    'a loader given a name': "const r = require;\nr('./x.ts');",
    'createRequire called at once with a literal path':
      "import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)('./x.ts');",
    'a type-only import of a .yaml path': "import type Gate from './gate.yaml';",
  };
  for (const [name, text] of Object.entries(FINE))
    test(`not a parse: ${name}`, () => {
      expect(planted(text), text).toEqual([]);
    });

  test('a view loader is fine in code that runs in a browser (a bundled chunk, never a file on a disk)', () => {
    const load = 'export const v = (name: string) => import(`./views/${name}.tsx`);';
    for (const app of [
      'packages/plugins/x/app/index.ts',
      'packages/core/ferrets/app/index.ts',
      'packages/app/src/shells/index.ts',
    ])
      expect(planted(load, app), app).toEqual([]);
    // The same text outside app code can be handed ../gate.yaml? (Bun drops the query and parses the file).
    for (const daemon of [
      'packages/plugins/x/daemon/index.ts',
      'packages/plugins/x/cli/index.ts',
      'packages/core/kernel/host/a.ts',
    ])
      expect(planted(load, daemon), daemon).toHaveLength(1);
    // A folder that merely ends in "app" is not app code.
    expect(planted(load, 'packages/plugins/x/daemon/webapp/index.ts')).toHaveLength(1);
  });

  test('a file that would not parse is refused, never counted as clean', () => {
    expect(planted('const = ;')).toEqual([expect.stringContaining('would not parse')]);
  });

  test('a parse in testing/ support is a use: product code may import it', () => {
    const at = 'packages/core/kernel/testing/host.ts';
    expect(planted("import { parse as parseYaml } from 'yaml';\nparseYaml(edit);", at)).toEqual([
      expect.stringContaining(`${at}:1:`),
    ]);
    expect(planted('const v = Bun.YAML.parse(edit);', 'packages/app/src/testing/dom.ts')).toHaveLength(1);
  });

  test('uses are located by line, once per line', () => {
    const facts = scanFile(PATH, 'a;\nconst v = Bun.YAML.parse(Bun.YAML.parse(t));\nconst {\n YAML } = Bun;');
    expect(facts.uses.map(use => use.line)).toEqual([2, 4]);
    expect(facts.uses[0]?.text).toBe('const v = Bun.YAML.parse(Bun.YAML.parse(t));');
  });

  test('tests and fixtures are out of scope; product code, and the testing/ support it may import, are in', () => {
    expect(inScope('packages/core/gate/daemon/index.ts')).toBe(true);
    expect(inScope('packages/plugins/x/app/a.tsx')).toBe(true);
    expect(inScope('packages/plugins/x/app/a.mjs')).toBe(true);
    expect(inScope('packages/core/gate/tests/unit/a.test.ts')).toBe(false);
    // context-imports lets a kernel area import kernel/testing, and the app shell its src/testing (guard review M3).
    expect(inScope('packages/core/kernel/testing/host.ts')).toBe(true);
    expect(inScope('packages/app/src/testing/dom.ts')).toBe(true);
    expect(inScope('packages/plugins/x/contract/testing/index.ts')).toBe(true);
    expect(inScope('packages/plugins/x/daemon/a.test.ts')).toBe(false);
    expect(inScope('packages/plugins/x/tests/fixtures/a.ts')).toBe(false);
    expect(inScope('scripts/ci/gate-hooks.ts')).toBe(false);
    expect(inScope('packages/plugins/x/README.md')).toBe(false);
  });
});

describe('the ledger', () => {
  const planted2 = { path: 'packages/core/gate/daemon/index.ts', text: 'x\nconst v = Bun.YAML.parse(read.text);\n' };

  test('a planted parse fails, and so does a stale or reasonless line', () => {
    expect(findings([planted2], '')).toEqual([expect.stringContaining('packages/core/gate/daemon/index.ts:2:')]);
    expect(findings([planted2], 'packages/core/gate/daemon/index.ts  # why it is safe\n')).toEqual([]);
    expect(findings([planted2], 'packages/core/gate/daemon/index.ts\n')).toEqual([
      expect.stringContaining('every entry is'),
      expect.stringContaining('packages/core/gate/daemon/index.ts:2:'),
    ]);
    expect(findings([{ path: planted2.path, text: 'x\n' }], `${planted2.path}  # was safe\n`)).toEqual([
      `${LEDGER}: ${planted2.path} no longer parses YAML itself; remove its line`,
    ]);
  });

  test('a static .yaml import of a committed file passes once the ledger says so', () => {
    const file = { path: 'packages/plugins/x/daemon/defaults.ts', text: "import defaults from './defaults.yaml';\n" };
    expect(findings([file], '')).toEqual([expect.stringContaining(`${file.path}:1:`)]);
    expect(
      findings([file], `${file.path}  # a YAML file committed in this repository, never a person's text\n`),
    ).toEqual([]);
  });

  test('reads path, path::export and callers; comments and blanks skipped; twice and malformed refused', () => {
    const { files, exports, problems } = parseLedger(
      [
        '# head',
        '',
        'a.ts  # one',
        'a.ts::read  <- b.ts, c.ts  # two',
        'a.ts::none  # no callers',
        'a.ts::x::y  # bad',
      ].join('\n'),
    );
    expect([...files]).toEqual([['a.ts', 'one']]);
    expect(exports.get('a.ts::read')).toEqual({ callers: ['b.ts', 'c.ts'], reason: 'two' });
    expect(exports.get('a.ts::none')).toEqual({ callers: [], reason: 'no callers' });
    expect(problems).toEqual([expect.stringContaining('"a.ts::x::y" is not path::export')]);
    expect(parseLedger('a.ts  # one\na.ts  # two\n').problems).toEqual([`${LEDGER}:2: a.ts is listed twice`]);
    expect(parseLedger('a.ts::f  <- b.ts  # r\na.ts::f  <- b.ts  # r\n').problems).toEqual([
      `${LEDGER}:2: a.ts::f is listed twice`,
    ]);
    expect(parseLedger('a.ts  <- b.ts  # r\n').problems).toEqual([
      expect.stringContaining('a file line has no callers'),
    ]);
  });

  test('"<- *" is the kernel reader alone', () => {
    expect(parseLedger(`${KERNEL_READER}::readConfigText  <- *  # the door\n`).problems).toEqual([]);
    expect(parseLedger('packages/plugins/x/daemon/r.ts::read  <- *  # open\n').problems).toEqual([
      expect.stringContaining('only packages/std/src/yaml-text.ts is open to every caller'),
    ]);
  });
});

describe('laundering through a ledgered parser', () => {
  const READER = 'packages/plugins/x/daemon/reader.ts';
  const OK = 'packages/plugins/x/daemon/ok.ts';
  const NEW = 'packages/plugins/x/daemon/new.ts';
  const reader = (body: string): string => `import { parseDocument } from 'yaml';\n${body}\n`;
  const LEDGER_TEXT = [
    `${READER}  # parses its own built-in text`,
    `${READER}::readIt  <- ${OK}  # only the built-in caller`,
  ].join('\n');
  const READER_TEXT = reader('export function readIt(t: string) { return parseDocument(t); }');
  const run = (callerText: string, ledger = LEDGER_TEXT, readerText = READER_TEXT, caller = NEW): readonly string[] =>
    findings(
      [
        { path: READER, text: readerText },
        { path: caller, text: callerText },
        { path: OK, text: "import { readIt } from './reader.ts';\nreadIt('a');" },
      ],
      ledger,
    );

  test('the real shape passes: a listed caller of a listed parser', () => {
    expect(run('export const unrelated = 1;')).toEqual([]);
  });

  const LAUNDERERS: Readonly<Record<string, string>> = {
    'named import': "import { readIt } from './reader.ts';\nreadIt('x');",
    'renamed import': "import { readIt as r } from './reader.ts';\nr('x');",
    'multi-line import': "import {\n  readIt,\n} from\n  './reader.ts';",
    'namespace import': "import * as reader from './reader.ts';\nreader.readIt('x');",
    'dynamic import': "const r = await import('./reader.ts');",
    'dynamic import, no extension': "const r = await import('./reader');",
    require: "const r = require('./reader.ts');",
    're-export by name': "export { readIt } from './reader.ts';",
    're-export renamed': "export { readIt as read } from './reader.ts';",
    're-export *': "export * from './reader.ts';",
    'a js specifier for a ts file': "import { readIt } from './reader.js';\nreadIt('x');",
    'import.meta.require': "const r = import.meta.require('./reader.ts');",
    'module.require': "const r = module.require('./reader.ts');",
    "module['req' + 'uire']": "const r = module['req' + 'uire']('./reader.ts');",
    'process.mainModule.require': "const r = process.mainModule.require('./reader.ts');",
    createRequire:
      "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url)('./reader.ts');",
    'a name for require': "const load = require;\nconst r = load('./reader.ts');",
  };
  for (const [shape, text] of Object.entries(LAUNDERERS))
    test(`an unlisted importer is flagged: ${shape}`, () => {
      expect(run(text)).toEqual([expect.stringContaining(`${NEW}:`)]);
      expect(run(text)[0]).toContain(`${READER}::readIt`);
    });

  test('a listed caller passes, and a type-only import is erased and passes', () => {
    expect(run("import { readIt } from './reader.ts';\nreadIt('x');", LEDGER_TEXT, READER_TEXT, OK)).toEqual([]);
    expect(run("import type { readIt } from './reader.ts';")).toEqual([]);
    expect(run("import { type readIt } from './reader.ts';")).toEqual([]);
    expect(run("export type { readIt } from './reader.ts';")).toEqual([]);
  });

  test('a name that is not a parser is free to import', () => {
    const text = reader('export const LIMIT = 4;\nexport function readIt(t: string) { return parseDocument(t); }');
    expect(run("import { LIMIT } from './reader.ts';", LEDGER_TEXT, text)).toEqual([]);
  });

  test('an exported function that reaches a parse must be on the ledger itself', () => {
    const direct = reader(
      'export function a(t: string) { return parseDocument(t); }\nexport function b() { return 1; }',
    );
    expect(run('', `${READER}  # r\n`, direct)).toEqual([expect.stringContaining(`${READER}: exports a,`)]);
    // Through a local helper, an arrow, a class, an object, a default, and an `export { local as exported }`.
    for (const body of [
      'const inner = (t: string) => parseDocument(t);\nexport const outer = (t: string) => inner(t);',
      'function inner(t: string) { return parseDocument(t); }\nfunction mid(t: string) { return inner(t); }\nexport function outer(t: string) { return mid(t); }',
      'export class Outer { read(t: string) { return parseDocument(t); } }',
      'export const api = { read: (t: string) => parseDocument(t) };',
      'export default function (t: string) { return parseDocument(t); }',
      'const inner = (t: string) => parseDocument(t);\nexport { inner as outer };',
    ]) {
      const found = run('', `${READER}  # r\n`, reader(body));
      expect(found, body).toHaveLength(1);
      expect(found[0], body).toContain('reaches a raw YAML parse');
    }
  });

  test('a stale export line, a stale caller and a line for an unlisted file are refused', () => {
    expect(run('', `${LEDGER_TEXT}\n${READER}::gone  <- ${OK}  # r`)).toEqual([
      expect.stringContaining(`${READER}::gone no longer reaches a raw YAML parse`),
      expect.stringContaining(`${OK} no longer loads ${READER}::gone`),
    ]);
    expect(run('', `${LEDGER_TEXT}\n`.replace(`<- ${OK}`, `<- ${OK}, ${NEW}`))).toEqual([
      `${LEDGER}: ${NEW} no longer loads ${READER}::readIt; remove it from that line`,
    ]);
    expect(run('', `${READER}::readIt  <- ${OK}  # r`)).toEqual(
      expect.arrayContaining([expect.stringContaining('belongs to a file the ledger does not list')]),
    );
  });

  test("the kernel's bounded reader is open to every caller; a file that is not it cannot be", () => {
    const kernel = reader('export function readConfigText(t: string) { return parseDocument(t); }');
    const door = `${KERNEL_READER}  # the reader\n${KERNEL_READER}::readConfigText  <- *  # the door`;
    const call = {
      path: 'packages/core/gate/daemon/index.ts',
      text: "import { readConfigText } from '../../../std/src/yaml-text.ts';\nreadConfigText('');",
    };
    expect(findings([{ path: KERNEL_READER, text: kernel }, call], door)).toEqual([]);
    // Without the line, the export is unlisted: the door is a ledger entry like any other.
    expect(findings([{ path: KERNEL_READER, text: kernel }], `${KERNEL_READER}  # the reader`)).toEqual([
      expect.stringContaining('exports readConfigText'),
    ]);
  });

  test('a call from a file that is itself on the ledger still needs the line', () => {
    const second = 'packages/plugins/x/daemon/second.ts';
    const ledger = `${LEDGER_TEXT}\n${second}  # parses too`;
    const found = findings(
      [
        { path: READER, text: READER_TEXT },
        { path: second, text: "import { readIt } from './reader.ts';\nBun.YAML.parse(readIt(''));" },
        { path: OK, text: "import { readIt } from './reader.ts';\nreadIt('a');" },
      ],
      ledger,
    );
    expect(found).toEqual([expect.stringContaining(`${second}:1: loads ${READER}::readIt`)]);
  });
});
