/**
 * The flaky-test quarantine: a red unit or int tier stays green ONLY when every test that failed is
 * on the committed list, and every one of those tests then passes when its file runs again.
 *
 * ## WHY IT EXISTS
 *
 * One flaky test blocked a release. The tier is one `bun test` over hundreds of files, so a test that
 * fails one run in fifty fails the whole job one run in fifty, and a release cut on that commit waits
 * for somebody to press re-run. The remedy is to fix the test. This is what stops the next one from
 * holding a release hostage WHILE it is being fixed.
 *
 * ## WHAT IT REFUSES TO DO, because that is the whole design
 *
 * A blanket `bun test --retry` would also keep the job green, and it would keep it green over every
 * NEW flake as well, silently. So a rerun happens only when ALL of these hold, and anything else
 * leaves the tier exactly as red as it was:
 *
 *   1. Every failing test is named — by file AND full `describe > … > it` name — in
 *      `config/test-quarantine.json`. One failure that is not on the list is a real failure.
 *   2. Bun's own summary agrees with the JUnit report: every `fail` it counted is a test the report
 *      names, and there are no `errors`. An unhandled error between tests, or a file that failed to
 *      load, is reported by Bun but attributed to no test — so it can never be matched against the
 *      list, and is never excused by a quarantined test that happened to fail in the same run.
 *   3. The rerun of just those files passes in full, and each quarantined test is in its report as
 *      passed. A quarantined test that fails twice in a row is not a flake for this run.
 *
 * A rescued run still says so out loud: a `::warning::` annotation per test naming its issue, and a
 * line in the job summary, so a flake that is being carried is never mistaken for a fixed one.
 *
 * ## THE COVERAGE LEDGER
 *
 * The 100% gate (`scripts/ci/coverage-ledger.sh`) runs AFTER this, on the merged ledger. A test that failed part
 * way through executed only part of what it covers, so the first run's ledger can be short of lines
 * that only that test reaches. The rerun executes those files again and its hits are merged into the
 * first run's line set (`mergeLcov` says why it is not a plain union). That is no weaker than the gate already
 * is — a failing test's executed lines count today too — and the rerun's lines come from a PASSING
 * run of the same files at the same commit. The rerun is coverage-instrumented exactly like the first
 * run, because `--coverage-dir` is ignored in favour of the bunfig's `coverageDir`; the first ledger
 * is moved aside before the rerun overwrites it.
 *
 * Usage (from `scripts/ci/test.sh`, after the tier ran with a JUnit report and a teed console log):
 *   bun scripts/ci/quarantine.ts <unit|int> <exit-status> <bunfig> <coverage-dir> <console-log> [bun test flags…]
 * It exits 0 when the tier is green (it was, or it was rescued), and with the tier's own status
 * otherwise. Run with no failures it only validates the list, so a malformed entry fails every run.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const QUARANTINE_FILE = 'config/test-quarantine.json';
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** An entry older than this still works, and says it has outstayed a quarantine. */
const STALE_DAYS = 14;

interface Entry {
  readonly tier: 'unit' | 'int';
  readonly file: string;
  readonly test: string;
  readonly issue: string;
  readonly added: string;
}

interface TestResult {
  readonly file: string;
  /** `describe > … > it`, exactly as Bun prints it after `(fail)`. */
  readonly name: string;
  readonly failed: boolean;
}

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(2);
};

const keyOf = (file: string, name: string): string => `${file}\u0000${name}`;

/** Parse, don't validate: an entry the gate cannot read is a broken gate, never an empty list. */
function readQuarantine(tier: string): Entry[] {
  if (!existsSync(QUARANTINE_FILE)) fail(`${QUARANTINE_FILE} is missing`);
  const raw: unknown = JSON.parse(readFileSync(QUARANTINE_FILE, 'utf8'));
  if (typeof raw !== 'object' || raw === null || (raw as { schemaVersion?: unknown }).schemaVersion !== 1)
    fail(`${QUARANTINE_FILE}: expected { "schemaVersion": 1, "tests": [...] }`);
  const tests = (raw as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) fail(`${QUARANTINE_FILE}: "tests" must be an array`);
  const entries = (tests as unknown[]).map((value, index): Entry => {
    const where = `${QUARANTINE_FILE} tests[${index}]`;
    if (typeof value !== 'object' || value === null) return fail(`${where} is not an object`);
    const entry = value as Record<string, unknown>;
    const allowed = new Set(['tier', 'file', 'test', 'issue', 'added']);
    for (const key of Object.keys(entry)) if (!allowed.has(key)) fail(`${where} has an unknown field "${key}"`);
    if (entry.tier !== 'unit' && entry.tier !== 'int') fail(`${where}.tier must be "unit" or "int"`);
    if (typeof entry.file !== 'string' || !existsSync(entry.file))
      fail(`${where}.file is not a file in this checkout: ${String(entry.file)}`);
    if (typeof entry.test !== 'string' || entry.test.trim() === '') fail(`${where}.test must name the test`);
    if (typeof entry.issue !== 'string' || !ISSUE_URL.test(entry.issue))
      fail(`${where}.issue must be a GitHub issue URL — a quarantine nobody is tracking is a deletion`);
    if (typeof entry.added !== 'string' || !ISO_DATE.test(entry.added)) fail(`${where}.added must be YYYY-MM-DD`);
    return entry as unknown as Entry;
  });
  return entries.filter(entry => entry.tier === tier);
}

const decode = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(tag);
  return match?.[1] === undefined ? undefined : decode(match[1]);
};

/**
 * Bun's JUnit report: one `<testsuite>` per file, a nested `<testsuite>` per `describe`, and a
 * `<testcase>` per `it` with a `<failure>` child when it failed. The full name is rebuilt from the
 * describe nesting, NOT from `classname` — Bun writes that one double-escaped and in reverse order.
 */
function readJunit(path: string): TestResult[] {
  if (!existsSync(path)) fail(`no JUnit report at ${path}`);
  const xml = readFileSync(path, 'utf8');
  const results: TestResult[] = [];
  const suites: string[] = [];
  let open: { file: string; name: string; failed: boolean } | null = null;
  for (const match of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error)\b([^>]*?)(\/?)>/gu)) {
    const [, closing, tag, body = '', selfClosing] = match;
    if (tag === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attribute(body, 'name') ?? '');
    } else if (tag === 'testcase') {
      if (closing) {
        if (open) results.push(open);
        open = null;
        continue;
      }
      const name = [...suites.slice(1), attribute(body, 'name') ?? ''].join(' > ');
      const file = attribute(body, 'file') ?? '';
      if (selfClosing) results.push({ file, name, failed: false });
      else open = { file, name, failed: false };
    } else if (!closing && open) {
      open.failed = true;
    }
  }
  return results;
}

/** The two numbers Bun prints at the end of a run: ` 3 fail` and ` 2 errors`. */
function readSummary(path: string): { fail: number; errors: number } {
  if (!existsSync(path)) fail(`no console log at ${path}`);
  const log = readFileSync(path, 'utf8');
  const count = (pattern: RegExp): number => {
    const all = [...log.matchAll(pattern)];
    return all.length === 0 ? 0 : Number(all.at(-1)?.[1]);
  };
  return { fail: count(/^\s*(\d+) fail$/gmu), errors: count(/^\s*(\d+) errors?$/gmu) };
}

/**
 * Merge the rerun's ledger into the first run's. The FIRST run owns the line set; the rerun can only
 * turn lines to hit, and adds a line only when it hit it.
 *
 * Not a plain union, and the reason was measured: Bun 1.3.13 reports a function that a run loaded but
 * never called COARSELY — every line of its range as `DA:n,0`, comments and blanks included. A rerun of
 * one or two files loads many modules it never exercises, so a union would add those coarse zeros to
 * files the full run measured finely, and a rescue would turn red at the ledger for lines that are not
 * code. A rerun line that is 0 and absent from the first run is such an artefact and is dropped.
 *
 * The residual, said out loud: a function ONLY the quarantined test reaches appears coarsely in the
 * first run (its test died), and the coarse report can omit that function's last line. The rerun hits
 * it but the first run never listed it, so it is added as hit — the ledger may then count one line the
 * fine report would not have. It can never hide a line the first run listed as missed and nothing hit.
 */
function mergeLcov(first: string, second: string): string {
  type Record = { lines: Map<number, number>; fnf: number; fnh: number };
  const parse = (text: string): Map<string, Record> => {
    const records = new Map<string, Record>();
    let current: Record | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('SF:')) {
        current = { lines: new Map(), fnf: 0, fnh: 0 };
        records.set(line.slice(3), current);
      } else if (current && line.startsWith('DA:')) {
        const [number, hits] = line.slice(3).split(',').map(Number);
        if (number !== undefined && hits !== undefined) current.lines.set(number, hits);
      } else if (current && line.startsWith('FNF:')) {
        current.fnf = Number(line.slice(4));
      } else if (current && line.startsWith('FNH:')) {
        current.fnh = Number(line.slice(4));
      } else if (line === 'end_of_record') {
        current = null;
      }
    }
    return records;
  };
  const merged = parse(first);
  for (const [file, rerun] of parse(second)) {
    const record = merged.get(file);
    if (record === undefined) {
      // A file the full run never loaded cannot be in its ledger; keep only what the rerun hit.
      merged.set(file, { ...rerun, lines: new Map([...rerun.lines].filter(([, hits]) => hits > 0)) });
      continue;
    }
    for (const [number, hits] of rerun.lines)
      if (hits > 0) record.lines.set(number, Math.max(record.lines.get(number) ?? 0, hits));
    record.fnh = Math.min(record.fnf, Math.max(record.fnh, rerun.fnh));
  }
  const out: string[] = [];
  for (const [file, record] of merged) {
    const lines = [...record.lines].sort(([a], [b]) => a - b);
    out.push('TN:', `SF:${file}`, `FNF:${record.fnf}`, `FNH:${record.fnh}`);
    for (const [number, hits] of lines) out.push(`DA:${number},${hits}`);
    out.push(`LF:${lines.length}`, `LH:${lines.filter(([, hits]) => hits > 0).length}`, 'end_of_record');
  }
  return `${out.join('\n')}\n`;
}

const daysSince = (date: string): number => Math.floor((Date.now() - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);

/** One line per rescued test in the job summary, so a carried flake is visible on the run page. */
function report(tier: string, rescued: readonly Entry[]): void {
  const lines = rescued.map(entry => {
    const age = daysSince(entry.added);
    const stale = age > STALE_DAYS ? ` — quarantined ${age} days, past the ${STALE_DAYS}-day budget` : '';
    process.stdout.write(
      `::warning file=${entry.file},title=Quarantined flaky test (${tier})::${entry.test} failed, then passed on a rerun. Tracked in ${entry.issue}${stale}\n`,
    );
    return `| \`${entry.file}\` | ${entry.test} | ${entry.issue} | ${age}d |`;
  });
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary === undefined || summary === '') return;
  appendFileSync(
    summary,
    [
      `### ⚠️ ${tier}: ${rescued.length} quarantined flaky test(s) failed and passed on a rerun`,
      '',
      'The tier is green because every failure was a known flake. These are still broken — see the issue.',
      '',
      '| File | Test | Issue | Quarantined |',
      '| --- | --- | --- | --- |',
      ...lines,
      '',
    ].join('\n'),
  );
}

const USAGE = 'usage: quarantine.ts <unit|int> <exit-status> <bunfig> <coverage-dir> <console-log> [flags…]';
const [tierArgument, statusText, bunfigArgument, coverageArgument, consoleArgument, ...testFlags] =
  process.argv.slice(2);
const tier = tierArgument === 'unit' || tierArgument === 'int' ? tierArgument : fail(USAGE);
const bunfig = bunfigArgument ?? fail(USAGE);
const coverageDir = coverageArgument ?? fail(USAGE);
const consoleLog = consoleArgument ?? fail(USAGE);
const status = Number(statusText);
const quarantine = readQuarantine(tier);
if (status === 0) process.exit(0);

const junitPath = join(coverageDir, 'junit.xml');
const lcovPath = join(coverageDir, 'lcov.info');
const failures = readJunit(junitPath).filter(result => result.failed);
const summary = readSummary(consoleLog);
const listed = new Map(quarantine.map(entry => [keyOf(entry.file, entry.test), entry]));
const unlisted = failures.filter(result => !listed.has(keyOf(result.file, result.name)));

const refuse = (why: string): never => {
  process.stderr.write(`🔒 quarantine: not rescuing the ${tier} tier — ${why}\n`);
  process.exit(status);
};
if (failures.length === 0) refuse('no failing test in the JUnit report, so the failure is not a test failure');
if (summary.errors > 0) refuse(`Bun reported ${summary.errors} error(s) outside any test`);
if (summary.fail !== failures.length)
  refuse(`Bun counted ${summary.fail} failure(s) but the report names ${failures.length}`);
if (unlisted.length > 0)
  refuse(
    `${unlisted.length} failing test(s) are not quarantined:\n${unlisted.map(r => `     ${r.file} › ${r.name}`).join('\n')}`,
  );

const rescued = failures.map(result => listed.get(keyOf(result.file, result.name)) as Entry);
const files = [...new Set(rescued.map(entry => entry.file))];
process.stdout.write(
  `🔁 quarantine: every ${tier} failure is a quarantined flake; rerunning ${files.length} file(s) once:\n${files.map(file => `     ${file}`).join('\n')}\n`,
);

const firstLedger = join(coverageDir, 'lcov.first.info');
renameSync(lcovPath, firstLedger);
const rerun = Bun.spawnSync(
  [
    'bun',
    'test',
    `--config=${bunfig}`,
    ...testFlags,
    '--coverage',
    '--reporter=junit',
    `--reporter-outfile=${join(coverageDir, 'junit.rerun.xml')}`,
    ...files.map(file => `./${file}`),
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
if (!existsSync(lcovPath)) refuse('the rerun wrote no coverage ledger');
const rerunLedger = join(coverageDir, 'lcov.rerun.info');
renameSync(lcovPath, rerunLedger);
writeFileSync(lcovPath, mergeLcov(readFileSync(firstLedger, 'utf8'), readFileSync(rerunLedger, 'utf8')));

if (rerun.exitCode !== 0) refuse(`the rerun of the quarantined files failed too (exit ${rerun.exitCode})`);
const passed = new Set(
  readJunit(join(coverageDir, 'junit.rerun.xml'))
    .filter(result => !result.failed)
    .map(result => keyOf(result.file, result.name)),
);
const missing = rescued.filter(entry => !passed.has(keyOf(entry.file, entry.test)));
if (missing.length > 0) refuse(`the rerun did not report ${missing.map(entry => entry.test).join(', ')} as passed`);

report(tier, rescued);
process.stdout.write(
  `⚠️ quarantine: ${rescued.length} quarantined flake(s) passed on the rerun; the ${tier} tier is green\n`,
);
process.exit(0);
