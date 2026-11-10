import { afterAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Fixture, fixture } from '../gen/tests/fixture.ts';
import { byOwner, NO_OWNER, ownerOf, summary } from './strict-guarantees.ts';

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

function runScript(f: Fixture, blocking: string | undefined): { code: number; summary: string } {
  const summaryFile = join(f.root, 'step-summary.md');
  const env: Record<string, string | undefined> = { ...process.env, GITHUB_STEP_SUMMARY: summaryFile };
  if (blocking === undefined) delete env.FY_STRICT_GUARANTEES_BLOCKING;
  else env.FY_STRICT_GUARANTEES_BLOCKING = blocking;
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, 'strict-guarantees.ts'), '--root', f.root, '--results', 'coverage/unit'],
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
