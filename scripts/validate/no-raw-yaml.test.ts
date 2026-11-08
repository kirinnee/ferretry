import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findings, inScope, LEDGER, parseLedger, rawYamlUses } from './no-raw-yaml.ts';

// The shapes are built, so this file reads as what it is: a test of the gate, not a parse of its own.
const BUN_YAML = ['Bun', 'YAML', 'parse'].join('.');
const FROM_YAML = `from '${'yaml'}'`;

describe('the raw-YAML gate', () => {
  test('the repository is clean against its own ledger', () => {
    const root = join(import.meta.dir, '../..');
    const run = spawnSync('bash', [join(root, 'scripts/validate/no-raw-yaml.sh')], { cwd: root, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  });

  test('every shape of a YAML reader of its own is found', () => {
    for (const line of [
      `const v = ${BUN_YAML}(text);`,
      `const v = Bun .YAML. parse(text);`,
      `const { YAML } = Bun;`,
      `const v = Bun['YAML'].parse(text);`,
      `const r = Bun.YAML;`,
      `import { parse } ${FROM_YAML};`,
      `import type { Document } ${FROM_YAML};`,
      `import * as y from "js-yaml";`,
      `const y = await import('yaml');`,
      `const y = require('yaml');`,
      `} ${FROM_YAML};`,
      `const v = YAML.parse(text);`,
    ])
      expect(rawYamlUses(`a\n${line}\nb`), line).toEqual([{ line: 2, text: line }]);
    // Writing YAML reads nothing, and a word in prose is not a parse.
    for (const line of ['Bun.YAML.stringify(value, null, 2)', '// a YAML file', "const name = 'yaml';"])
      expect(rawYamlUses(line), line).toEqual([]);
  });

  test('tests, fixtures and test support are out of scope; product code anywhere under packages is in', () => {
    expect(inScope('packages/core/gate/daemon/index.ts')).toBe(true);
    expect(inScope('packages/plugins/x/app/a.tsx')).toBe(true);
    expect(inScope('packages/core/gate/tests/unit/a.test.ts')).toBe(false);
    expect(inScope('packages/core/kernel/testing/host.ts')).toBe(false);
    expect(inScope('packages/plugins/x/daemon/a.test.ts')).toBe(false);
    expect(inScope('packages/plugins/x/tests/fixtures/a.ts')).toBe(false);
    expect(inScope('scripts/ci/gate-hooks.ts')).toBe(false);
  });

  test('a planted parse in daemon code fails, and so does a stale or reasonless ledger line', () => {
    const planted = { path: 'packages/core/gate/daemon/index.ts', text: `x\nconst v = ${BUN_YAML}(read.text);\n` };
    expect(findings([planted], '')).toEqual([expect.stringContaining('packages/core/gate/daemon/index.ts:2:')]);
    // Listed with a reason: allowed.
    expect(findings([planted], 'packages/core/gate/daemon/index.ts  # why it is safe\n')).toEqual([]);
    // Listed without one: refused.
    expect(findings([planted], 'packages/core/gate/daemon/index.ts\n')).toEqual([
      expect.stringContaining('every entry is "path  # reason"'),
      expect.stringContaining('packages/core/gate/daemon/index.ts:2:'),
    ]);
    // Listed but no longer parsing: refused, so the ledger stays the true inventory.
    expect(findings([{ path: planted.path, text: 'x\n' }], `${planted.path}  # was safe\n`)).toEqual([
      `${LEDGER}: ${planted.path} no longer parses YAML itself; remove its line`,
    ]);
  });

  test('the ledger reads one "path  # reason" per line, comments and blanks skipped, twice refused', () => {
    const { allowed, problems } = parseLedger('# head\n\na.ts  # one\na.ts  # two\n');
    expect([...allowed]).toEqual([['a.ts', 'two']]);
    expect(problems).toEqual([`${LEDGER}:4: a.ts is listed twice`]);
  });
});
