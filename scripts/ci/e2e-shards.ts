/**
 * The e2e tier's split: which journeys run on a pull request, and which of N parallel runners runs each.
 *
 * ## WHY BY TEST, NOT BY FILE
 *
 * `bun test --shard=i/N` splits by FILE, and this tier's time is not spread over its files: one file of
 * product journeys holds about five minutes of it. A split by file leaves that file's runner as the
 * whole wall clock whatever N is. So the unit here is the test — `describe > … > it` — and a runner is
 * handed its files plus one anchored `--test-name-pattern` naming exactly its tests.
 *
 * ## WHERE THE NAMES COME FROM
 *
 * Bun itself: a run whose pattern matches nothing still loads every file and writes every test, as
 * skipped, into its JUnit report (~0.5 s, no journey runs). Nothing here parses TypeScript, so a test
 * added to any file is in the plan the moment it exists.
 *
 * ## HOW IT IS BALANCED
 *
 * `tests/e2e/timings.json` records each test's seconds from a real run's JUnit report (`timings`,
 * below). The plan is longest-first onto the least-loaded runner, ties broken by name and then by the
 * lowest runner, so every runner computes the same plan from the same checkout without talking to the
 * others. A test with no recorded time counts as {@link UNKNOWN_SECONDS}.
 *
 * ## THE SLOW TIER
 *
 * A test whose own title ends in `[slow]` waits on purpose — an idle page, a frozen tab, a relay
 * restarted again and again. `fast` leaves those out (every pull request), `slow` runs only those
 * (`E2E Slow`: nightly, `main`, and pull requests touching the connection code), `all` runs both.
 *
 * Usage:
 *   bun scripts/ci/e2e-shards.ts plan <fast|slow|all> <i/N>
 *     One argument per line for `bun test`: the shard's files, then `--test-name-pattern=<regex>`.
 *     Nothing at all when the shard is empty. The plan, with each test's expected seconds, goes to stderr.
 *   bun scripts/ci/e2e-shards.ts timings <junit.xml>…
 *     Rewrites tests/e2e/timings.json from the reports: their tests' times replace the recorded ones,
 *     a test they did not run keeps its time, and a test that no longer exists is dropped.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMINGS_FILE = 'tests/e2e/timings.json';
const E2E_ROOT = 'tests/e2e';
const E2E_CONFIG = '--config=bunfig.e2e.toml';
/** The title suffix that moves a journey to the slow tier. */
const SLOW_TAG = '[slow]';
/** About the median of the tier's recorded journeys: a new test is planned as an ordinary one. */
const UNKNOWN_SECONDS = 10;
/** Bun joins the describe names and the test's own with single spaces when it matches `-t`. */
const NEVER_MATCHES = '^ferretry-e2e-shards-lists-only$';

type Tier = 'fast' | 'slow' | 'all';

interface Journey {
  readonly file: string;
  /** Every describe name, outermost first, then the test's own title. */
  readonly path: readonly string[];
  readonly seconds: number | undefined;
}

/** `{ file: { "describe > it": seconds } }`, the shape of {@link TIMINGS_FILE}. */
type Timings = Record<string, Record<string, number>>;

const fail = (message: string): never => {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(2);
};

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

const display = (path: readonly string[]): string => path.join(' > ');

/**
 * Bun's JUnit report: one `<testsuite>` per file, a nested `<testsuite>` per `describe`, a `<testcase>`
 * per `it`. The name is rebuilt from the nesting, as `scripts/ci/quarantine.ts` does and for its reason:
 * `classname` is double-escaped and reversed.
 */
function readJunit(path: string): Journey[] {
  if (!existsSync(path)) fail(`no JUnit report at ${path}`);
  const xml = readFileSync(path, 'utf8');
  const journeys: Journey[] = [];
  const suites: string[] = [];
  for (const match of xml.matchAll(/<(\/?)(testsuite|testcase)\b([^>]*?)(\/?)>/gu)) {
    const [, closing, tag, body = '', selfClosing] = match;
    if (tag === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attribute(body, 'name') ?? '');
    } else if (!closing) {
      const time = Number(attribute(body, 'time'));
      journeys.push({
        file: attribute(body, 'file') ?? '',
        path: [...suites.slice(1), attribute(body, 'name') ?? ''],
        seconds: Number.isFinite(time) ? time : undefined,
      });
    }
  }
  return journeys;
}

/** Every journey in the tier, named by Bun, with none of them run. */
function listJourneys(): Journey[] {
  const scratch = mkdtempSync(join(tmpdir(), 'fy-e2e-shards-'));
  try {
    const report = join(scratch, 'listing.xml');
    // Exit 1 is expected — Bun reports a pattern that matched nothing — so the report is the verdict.
    const listing = Bun.spawnSync(
      [
        'bun',
        'test',
        E2E_ROOT,
        E2E_CONFIG,
        `--test-name-pattern=${NEVER_MATCHES}`,
        '--reporter=junit',
        `--reporter-outfile=${report}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (!existsSync(report))
      fail(`listing the e2e journeys wrote no report (exit ${String(listing.exitCode)})\n${listing.stderr.toString()}`);
    const journeys = readJunit(report).map(journey => ({ ...journey, seconds: undefined }));
    if (journeys.length === 0) fail('listing the e2e journeys found none; a plan of nothing would pass vacuously');
    for (const journey of journeys)
      if (journey.path.some(part => /[\r\n]/u.test(part)))
        fail(`a journey's name spans lines, which the plan cannot pass to bun test: ${display(journey.path)}`);
    return journeys;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function readTimings(): Timings {
  if (!existsSync(TIMINGS_FILE)) return {};
  const raw: unknown = JSON.parse(readFileSync(TIMINGS_FILE, 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    fail(`${TIMINGS_FILE}: expected { "<file>": { "<describe > it>": seconds } }`);
  for (const [file, tests] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof tests !== 'object' || tests === null || Array.isArray(tests))
      fail(`${TIMINGS_FILE}: ${file} is not an object`);
    for (const [name, seconds] of Object.entries(tests as Record<string, unknown>))
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0)
        fail(`${TIMINGS_FILE}: ${file} › ${name} is not a number of seconds`);
  }
  return raw as Timings;
}

const isSlow = (journey: Journey): boolean => (journey.path.at(-1) ?? '').trimEnd().endsWith(SLOW_TAG);

const inTier = (tier: Tier) => (journey: Journey) =>
  tier === 'all' || (tier === 'slow' ? isSlow(journey) : !isSlow(journey));

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');

function parseShard(spec: string): { readonly index: number; readonly total: number } {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(spec);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (match === null || index > total) return fail(`a shard is <i>/<N> with 1 ≤ i ≤ N, not "${spec}"`);
  return { index, total };
}

function plan(tierArg: string | undefined, shardArg: string | undefined): void {
  if (tierArg !== 'fast' && tierArg !== 'slow' && tierArg !== 'all')
    fail(`the tier is fast, slow or all, not "${String(tierArg)}"`);
  const tier = tierArg as Tier;
  const { index, total } = parseShard(shardArg ?? '1/1');
  const timings = readTimings();
  const journeys = listJourneys()
    .filter(inTier(tier))
    .map(journey => ({ ...journey, seconds: timings[journey.file]?.[display(journey.path)] ?? UNKNOWN_SECONDS }))
    .sort(
      (a, b) => b.seconds - a.seconds || a.file.localeCompare(b.file) || display(a.path).localeCompare(display(b.path)),
    );

  const loads = Array.from({ length: total }, () => 0);
  const mine: Journey[] = [];
  for (const journey of journeys) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] = (loads[lightest] ?? 0) + (journey.seconds ?? UNKNOWN_SECONDS);
    if (lightest === index - 1) mine.push(journey);
  }

  const summary = loads.map((load, at) => `${String(at + 1)}: ~${load.toFixed(0)}s`).join(', ');
  process.stderr.write(
    `🧩 e2e ${tier} tier, shard ${String(index)}/${String(total)}: ${String(mine.length)} of ${String(journeys.length)} journeys (expected per shard — ${summary})\n`,
  );
  for (const journey of mine)
    process.stderr.write(
      `   ~${(journey.seconds ?? 0).toFixed(1).padStart(6)}s  ${journey.file} › ${display(journey.path)}\n`,
    );
  if (mine.length === 0) return;

  // File order as Bun would discover them, and tests within a file in their own order: the plan picks
  // WHICH journeys a shard runs, never the order they run in.
  const files = [...new Set(mine.map(journey => journey.file))].sort();
  const pattern = `^(?:${mine.map(journey => escapeRegex(journey.path.join(' '))).join('|')})$`;
  process.stdout.write(`${[...files, `--test-name-pattern=${pattern}`].join('\n')}\n`);
}

function timingsFrom(reports: readonly string[]): void {
  if (reports.length === 0) fail('name at least one JUnit report to read times from');
  const existing = readTimings();
  const measured = new Map<string, number>();
  for (const report of reports)
    for (const journey of readJunit(report))
      // A skipped test reports 0 s: it says nothing about how long the journey takes.
      if (journey.seconds !== undefined && journey.seconds > 0)
        measured.set(`${journey.file}\u0000${display(journey.path)}`, journey.seconds);

  const next: Timings = {};
  const journeys = listJourneys().sort(
    (a, b) => a.file.localeCompare(b.file) || display(a.path).localeCompare(display(b.path)),
  );
  for (const journey of journeys) {
    const name = display(journey.path);
    const seconds = measured.get(`${journey.file}\u0000${name}`) ?? existing[journey.file]?.[name];
    if (seconds === undefined) continue;
    next[journey.file] ??= {};
    (next[journey.file] as Record<string, number>)[name] = Math.round(seconds * 10) / 10;
  }
  writeFileSync(TIMINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  const recorded = Object.values(next).reduce((count, tests) => count + Object.keys(tests).length, 0);
  process.stderr.write(
    `✅ ${TIMINGS_FILE}: ${String(recorded)} of ${String(journeys.length)} journeys timed (${String(measured.size)} measured now)\n`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'plan') plan(rest[0], rest[1]);
else if (command === 'timings') timingsFrom(rest);
else fail('usage: e2e-shards.ts plan <fast|slow|all> <i/N> | timings <junit.xml>…');
