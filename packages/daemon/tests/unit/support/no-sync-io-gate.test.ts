import { describe, it } from 'bun:test';
import should from 'should';
import { parseLedger, scanSource } from '../../../../../scripts/validate/no-sync-io.ts';

/**
 * The synchronous-IO gate's counter, on the code shapes that fooled the line-matching version in review: what it
 * counts is what `scripts/validate/no-sync-io.sh` enforces, so these are its planted violations.
 */

const uses = (code: string): readonly string[] => scanSource('example.ts', code).uses.map(use => use.name);
const aliases = (code: string): number => scanSource('example.ts', code).aliases.length;

describe('the synchronous-IO counter', () => {
  it('should count each of two nested calls', () => {
    should(uses('statSync(realpathSync(p)).isDirectory();')).deepEqual(['statSync', 'realpathSync']);
  });

  it('should count every call on one line, and a function a fixed list would have missed', () => {
    should(uses('const c = existsSync(p) && readFileSync(p).length; statfsSync(".");')).deepEqual([
      'existsSync',
      'readFileSync',
      'statfsSync',
    ]);
  });

  it('should count a call through a namespace, a native variant, and a spawn on the runtime', () => {
    should(uses('fs.readFileSync(p); realpathSync.native(p); Bun.spawnSync(["true"]);')).deepEqual([
      'readFileSync',
      'realpathSync',
      'spawnSync',
    ]);
  });

  it('should count a function handed on as a value, which runs wherever it is called', () => {
    should(uses('const options = { exists: existsSync }; const short = { existsSync };')).deepEqual([
      'existsSync',
      'existsSync',
    ]);
  });

  it('should count a call inside a destructuring default or a computed key, however deep the pattern', () => {
    should(uses('const { config: { text = readFileSync(p, "utf8") } } = input;')).deepEqual(['readFileSync']);
    should(uses('const [first = statSync(p)] = list; const { [realpathSync(p)]: value } = input;')).deepEqual([
      'statSync',
      'realpathSync',
    ]);
    should(uses('function f({ a = existsSync(p) } = {}) {}')).deepEqual(['existsSync']);
  });

  it('should count a member spelled as a string, which names the function as surely as an identifier', () => {
    should(uses('fs["readFileSync"](p); fs[`statSync`](p); fs[readSync](d);')).deepEqual([
      'readFileSync',
      'statSync',
      'readSync',
    ]);
  });

  it('should count nothing that only names, declares or describes a type', () => {
    const code = [
      "import { readFileSync, writeSync } from 'node:fs';",
      '// readFileSync(p) in a comment',
      'interface Writes { writeSync(descriptor: number): number }',
      'type Reader = typeof readFileSync;',
      'const keys = { readFileSync: 1 };',
      'class C { writeSync(): void {} }',
      "const text = 'readFileSync(p)';",
    ].join('\n');
    should(uses(code)).deepEqual([]);
  });

  it('should refuse a blocking function bound to another name, however the import is laid out', () => {
    should(aliases("import {\n  readFileSync\n  as read\n} from 'node:fs';")).equal(1);
    should(aliases('const { readFileSync: read } = fs;')).equal(1);
    should(aliases('const { readFileSync: read = fallback } = fs;')).equal(1);
    should(aliases('const { exports: { readFileSync: read } } = { exports: fs };')).equal(1);
    should(aliases('const { "readFileSync": read } = fs;')).equal(1);
    should(aliases('import { "readFileSync" as read } from "node:fs";')).equal(1);
    should(aliases("import { readFileSync } from 'node:fs'; const { existsSync } = fs;")).equal(0);
  });

  it('should refuse a file it cannot parse rather than call it clean', () => {
    should(scanSource('broken.ts', 'const = ;').unparsable).be.a.String();
  });

  it('should sum several ledger lines for one file and name a malformed one', () => {
    const { allowed, malformed } = parseLedger('# header\n2 a.ts  # boot: x\n1 a.ts  # gap: y\n\nnot a line\n');
    should(allowed.get('a.ts')).equal(3);
    should(malformed).deepEqual(['line 5: not a line']);
  });
});
