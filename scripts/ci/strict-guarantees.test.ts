import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Fixture, fixture } from '../gen/tests/fixture.ts';
import { contextFor } from '../gen/lib/check.ts';
import { byOwner, NO_OWNER, ownerOf, strictFindings, summary } from './strict-guarantees.ts';

const miss = (where: string, message: string) => ({ check: 'guarantees', where, message });
const NO_TEST = (id: string, owner: string) => miss(id, `kept row owned by ${owner} has no test named "${id} …"`);

test('the misses are grouped by owner, sorted, one id once', () => {
  const findings = [
    NO_TEST('G9', 'warden'),
    NO_TEST('G2', 'access'),
    miss('G9', 'kept row owned by warden has a FAILING test: x'),
    miss('G5', 'split row owned by access has a test named "G5 …" but no passing run of it in the results'),
    miss('G3', 'REMOVED row still has a test (a.test.ts); its code remains'),
  ];
  expect(ownerOf(findings[4]!)).toBe(NO_OWNER);
  expect([...byOwner(findings)]).toEqual([
    [NO_OWNER, ['G3']],
    ['access', ['G2', 'G5']],
    ['warden', ['G9']],
  ]);
});

test('every guarantee-owner finding names its owner too: the enforcer symbol and the no-package ones', () => {
  const symbol = {
    check: 'guarantee-owner',
    where: 'P88',
    message: 'enforcer `x` resolves to no symbol in connections or a contract it consumes',
  };
  const noPackage = { check: 'guarantee-owner', where: 'G7', message: 'owner "ghost" is no package' };
  const outside = {
    check: 'guarantee-owner',
    where: 'G8',
    message: "kept row owned by access is tested only outside its owner's suite (p): a.test.ts",
  };
  expect([symbol, noPackage, outside].map(ownerOf)).toEqual(['connections', 'ghost', 'access']);
  expect([...byOwner([symbol, outside, noPackage, { ...symbol, message: `${symbol.message} again` }])]).toEqual([
    ['access', ['G8']],
    ['connections', ['P88']],
    ['ghost', ['G7']],
  ]);
});

test('the summary leads with the count and says whether it blocks', () => {
  const text = summary([NO_TEST('G2', 'access'), NO_TEST('G9', 'warden')], false);
  expect(text.split('\n')[0]).toContain('2 missing');
  expect(text).toContain('report only');
  expect(text).toContain('| access | 1 | G2 |');
  expect(summary([NO_TEST('G2', 'access')], true)).toContain('BLOCKING');
  expect(summary([], false)).toContain('0 missing');
});

test('no report at all is reported as unknown, not as a miss', () => {
  const text = summary([miss('results', 'no JUnit report found')], false);
  expect(text).toContain('unknown');
  expect(text).not.toContain('1 missing');
});

// ─── the script itself: the switch and the job summary, against a fixture root ───────────────────────────────────────
const TSV = 'id\tstatus\towner\twith\tenforcer\tdoc\ttest\n';
const TEST_FILE = 'packages/plugins/alpha/tests/unit/a.test.ts';
const fixtures: Fixture[] = [];
afterAll(() => {
  for (const f of fixtures) f.dispose();
});

/** A fixture root holding one kept row, its id test and a JUnit report in which that test passed or was skipped. */
function plant(passes: boolean): Fixture {
  const f = fixture([{ id: 'alpha' }], { pending: ['alpha'] });
  fixtures.push(f);
  f.write('docs/rebuild/guarantees.tsv', `${TSV}G1\tkept\talpha\t-\t-\tgrants\tG1\n`);
  f.write(TEST_FILE, `import { test } from 'bun:test';\ntest('${'G1'} holds', () => {});\n`);
  const inner = passes ? '' : '<skipped />';
  f.write(
    'coverage/unit/junit.xml',
    `<testsuites><testcase name="G1 holds" file="${TEST_FILE}">${inner}</testcase></testsuites>`,
  );
  return f;
}

function runScript(
  f: Fixture,
  blocking: string | undefined,
  reports: readonly string[] = ['coverage/unit'],
): { code: number; summary: string } {
  const summaryFile = join(f.root, 'step-summary.md');
  const env: Record<string, string | undefined> = { ...process.env, GITHUB_STEP_SUMMARY: summaryFile };
  if (blocking === undefined) delete env.FY_STRICT_GUARANTEES_BLOCKING;
  else env.FY_STRICT_GUARANTEES_BLOCKING = blocking;
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, 'strict-guarantees.ts'),
      '--root',
      f.root,
      ...reports.flatMap(report => ['--results', report]),
    ],
    { env, stdout: 'pipe', stderr: 'pipe' },
  );
  return { code: result.exitCode, summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '' };
}

test('the switch: exit 1 only when it is true AND findings exist; the step summary is written either way', () => {
  const missing = plant(false);
  const blocking = runScript(missing, 'true');
  expect(blocking.code).toBe(1);
  expect(blocking.summary).toContain('1 missing');
  expect(blocking.summary).toContain('BLOCKING');
  for (const value of ['false', '', undefined, 'TRUE']) {
    const quiet = runScript(missing, value);
    expect(quiet.code).toBe(0);
    expect(quiet.summary).toContain('1 missing');
    expect(quiet.summary).toContain('| alpha | 1 | G1 |');
    expect(quiet.summary).toContain('report only');
  }
  // True with no findings is still a pass.
  const clean = runScript(plant(true), 'true');
  expect(clean.code).toBe(0);
  expect(clean.summary).toContain('0 missing');
});

const INT_FILE = 'packages/plugins/alpha/tests/integration/a.test.ts';
const SYMBOL_FILE = 'packages/plugins/alpha/daemon/lib/enforcer.ts';

/** A fixture root: one kept row whose only test is in the integration tier and passed there, with one enforcer symbol. */
function plantIntegration(symbolInOwner: boolean): Fixture {
  const f = fixture([{ id: 'alpha' }], { pending: ['alpha'] });
  fixtures.push(f);
  f.write('docs/rebuild/guarantees.tsv', `${TSV}G1\tkept\talpha\t-\t\`keepsTheGuarantee\`\tgrants\tG1\n`);
  f.write(INT_FILE, `import { test } from 'bun:test';\ntest('G1 holds', () => {});\n`);
  f.write(SYMBOL_FILE, symbolInOwner ? 'export const keepsTheGuarantee = true;\n' : 'export const other = true;\n');
  f.write(
    'coverage/int/junit.xml',
    `<testsuites><testcase name="G1 holds" file="${INT_FILE}"></testcase></testsuites>`,
  );
  return f;
}

test('a row proven only in the integration tier is no miss, whichever reports are read', () => {
  const proven = plantIntegration(true);
  const both = runScript(proven, 'true', ['coverage/unit', 'coverage/int']);
  expect(both.code).toBe(0);
  expect(both.summary).toContain('0 missing');
  // The int report alone is enough: no tier splits the tests from the results.
  expect(runScript(proven, 'true', ['coverage/int']).summary).toContain('0 missing');
});

test('an enforcer symbol that resolves to nothing in the owner is counted, though the row is tested and passes', () => {
  const lost = plantIntegration(false);
  const blocking = runScript(lost, 'true', ['coverage/unit', 'coverage/int']);
  expect(blocking.code).toBe(1);
  expect(blocking.summary).toContain('1 missing');
  expect(blocking.summary).toContain('| alpha | 1 | G1 |');
  const report = runScript(lost, undefined, ['coverage/int']);
  expect(report.code).toBe(0);
  expect(report.summary).toContain('1 missing');
});

test('strictFindings is every finding of both checks: the two together, none filtered', async () => {
  const lost = plantIntegration(false);
  const ctx = contextFor(lost.root, { strict: true, results: ['coverage/int'] });
  const found = await strictFindings(ctx);
  expect(found.map(finding => `${finding.check}:${finding.where}`)).toEqual(['guarantee-owner:G1']);
  expect(found[0]?.message).toContain('resolves to no symbol in alpha');
});
