/**
 * `guarantees` and `guarantee-owner` (§3.9, §7.9), reading the one guarantees table, `docs/rebuild/guarantees.tsv`
 * (written from Appendix D by `scripts/rebuild/guarantees.ts`; columns id · status · owner · with · enforcer · doc ·
 * test).
 *
 * `guarantees` fails when a kept row (or the kept half of a split row) has no test whose name STARTS with its id
 * (`test('G11 person route refuses …')`; `.skip` and `.todo` do not count), or when a REMOVED row still has a test (its
 * code remains). Rows owned by a package still in `ports-pending.json`, or cut from the release (`deferred.json`),
 * are skipped unless `--strict`.
 *
 * A test that EXISTS is not a test that PASSES: `guarantees` also reads the JUnit files the test tiers write
 * (every `junit.xml` under `coverage/`, or each `--results <path>`) and fails a kept row when a test named with its id, in its
 * owner's suite, failed, or when no run of one passed (it was skipped, or is in no report). With no report at all it
 * says so, rather than passing on titles alone; `--existence-only` (the commit hook, which runs no tests) opts out.
 * `--tier unit|int` (CI: each test job judges its own report) proves only the rows with a test in that tier, so a row
 * tested in the integration tier alone is never "missing" from the unit report, nor a unit row from the integration one.
 *
 * `guarantee-owner` fails when a row's tests all live outside its owner's suite, or when an identifier the row's
 * enforcer names (in backticks) resolves to no symbol in the owner package or a contract it consumes. Owners that are
 * not subsystems: `repo-tooling` (scripts/), `fy-shell` (packages/cli), `app-shell` (packages/app).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { type Check, type Finding, parseFile, runMain, walk } from '../gen/lib/check.ts';
import type { Workspace } from '../gen/lib/workspace.ts';
import { contractPath, loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';
import { readPending } from './ports-pending.ts';
import { GUARANTEE_HELPER, helperBinding, helperCallTitles, leadingIds } from './test-titles.ts';

export const GUARANTEES_TSV = 'docs/rebuild/guarantees.tsv';
const HEADER = 'id\tstatus\towner\twith\tenforcer\tdoc\ttest';

export interface GuaranteeRow {
  readonly id: string;
  readonly status: 'kept' | 'split' | 'removed';
  readonly owner: string;
  readonly with: readonly string[];
  readonly enforcer: string;
  readonly doc: string;
  readonly test: string;
}

export function parseTsv(text: string): GuaranteeRow[] {
  const [header, ...lines] = text.trimEnd().split('\n');
  if (header !== HEADER) throw new Error(`${GUARANTEES_TSV}: header is not "${HEADER.replaceAll('\t', ' ')}"`);
  const dash = (value: string | undefined): string => (value === undefined || value === '-' ? '' : value);
  return lines.map(line => {
    const [id = '', status = '', owner = '', withs = '', enforcer = '', doc = '', test = ''] = line.split('\t');
    if (status !== 'kept' && status !== 'split' && status !== 'removed')
      throw new Error(`${GUARANTEES_TSV}: ${id} has status "${status}"`);
    return {
      id,
      status,
      owner: dash(owner),
      with: dash(withs) === '' ? [] : withs.split(','),
      enforcer: dash(enforcer),
      doc,
      test: dash(test),
    };
  });
}

// The ids a literal title starts with: `'R42 R43 …'` names both (`leadingIds` splits them). The helper form is read
// from the AST (`test-titles.ts`), only in a file that imports the helper.
const TEST_NAME =
  /\b(?:test|it)(\.(?:only|skip|todo|failing|serial|concurrent|if\([^)]*\)))?\(\s*(['"`])([A-Z]+[0-9]+[a-z]?(?: [A-Z]+[0-9]+[a-z]?)*)(?=[\s'"`:.,])/g;

/** Every row id a test name starts with → the files holding such a test. */
export function testIds(root: string, ws: Workspace): Map<string, string[]> {
  const files = [
    ...ws.packages.flatMap(pkg =>
      sourceFiles(pkg).filter(file => /[/\\]tests[/\\]/.test(file) || /\.test\.tsx?$/.test(file)),
    ),
    ...[...new Bun.Glob('scripts/**/*.test.ts').scanSync({ cwd: root, onlyFiles: true })].map(rel => join(root, rel)),
  ];
  const ids = new Map<string, string[]>();
  for (const file of new Set(files)) {
    // Judged on the path INSIDE the root: a fixture workspace itself lives under a `.tmp` folder.
    const rel = relative(root, file).split(sep).join('/');
    if (rel.includes('node_modules/') || rel.includes('.tmp/')) continue;
    const source = readFileSync(file, 'utf8');
    const add = (id: string): void => {
      const list = ids.get(id) ?? [];
      if (!list.includes(rel)) list.push(rel);
      ids.set(id, list);
    };
    for (const match of source.matchAll(TEST_NAME)) {
      const modifier = match[1] ?? '';
      // `.failing` passes when the body THROWS: it is a known bug, never proof that a guarantee holds.
      if (modifier.startsWith('.skip') || modifier.startsWith('.todo') || modifier.startsWith('.failing')) continue;
      for (const id of leadingIds(match[3] as string)) add(id);
    }
    // The one helper, read by the shared parser: only a call of the function this file imports from the support module.
    if (source.includes(`${GUARANTEE_HELPER}(`) && source.includes('support/guarantee')) {
      const { program } = parseFile(file);
      const binding = helperBinding(program, file);
      if (binding !== undefined)
        walk(program, node => {
          for (const title of helperCallTitles(node, binding) ?? []) for (const id of leadingIds(title)) add(id);
        });
    }
  }
  return ids;
}

/** One test as a JUnit report records it. */
export interface TestResult {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly status: 'passed' | 'failed' | 'skipped';
}

const xmlText = (value: string): string =>
  value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/** Every test of one JUnit report whose name starts with a row id (`G11 …`). */
export function parseJunit(xml: string): TestResult[] {
  const out: TestResult[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = match[1] ?? '';
    const name = xmlText(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    const id = /^([A-Z]+[0-9]+[a-z]?)(?=[\s'"`:.,]|$)/.exec(name)?.[1];
    if (id === undefined) continue;
    const body = match[2] ?? '';
    const status = /<(?:failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    out.push({ id, name, file: xmlText(/\bfile="([^"]*)"/.exec(attrs)?.[1] ?? '').replace(/^\.\//, ''), status });
  }
  return out;
}

/** One test of a JUnit report, with the describe blocks around it in its full name. */
export interface JunitCase {
  readonly fullName: string;
  readonly file: string;
  readonly status: TestResult['status'];
}

/** Every test of one JUnit report (any name), its enclosing suites' names ahead of its own in `fullName`. */
export function junitCases(xml: string): JunitCase[] {
  const out: JunitCase[] = [];
  const suites: { name: string; file: string }[] = [];
  const attr = (attrs: string, key: string): string =>
    xmlText(new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)?.[1] ?? '');
  for (const match of xml.matchAll(
    /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    if (match[0].startsWith('</testsuite')) suites.pop();
    else if (match[0].startsWith('<testsuite')) {
      if (match[2] !== '/') suites.push({ name: attr(match[1] ?? '', 'name'), file: attr(match[1] ?? '', 'file') });
    } else {
      const attrs = match[3] ?? '';
      const body = match[4] ?? '';
      const file =
        attr(attrs, 'file') ||
        [...suites].reverse().find(s => s.file !== '')?.file ||
        suites.find(s => /\.test\.tsx?$/.test(s.name))?.name ||
        '';
      out.push({
        fullName: [...suites.map(s => s.name), attr(attrs, 'name')].join(' '),
        file: file.replace(/^\.\//, ''),
        status: /<(?:failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      });
    }
  }
  return out;
}

/** `--results` paths (files, or folders searched for `junit.xml` and the quarantine's `junit.rerun.xml`); default every tier's report under `coverage/`. */
export function resultFiles(root: string, paths: readonly string[] | undefined): string[] | undefined {
  const files = new Set<string>();
  for (const path of paths ?? ['coverage']) {
    const abs = resolve(root, path);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const rel of new Bun.Glob('**/junit{,.rerun}.xml').scanSync({ cwd: abs, onlyFiles: true })) {
        // The realworld tier gates nothing and holds machine-dependent tests: it proves no guarantee.
        if (paths === undefined && rel.startsWith('realworld/')) continue;
        files.add(join(abs, rel));
      }
    } else files.add(abs);
  }
  return files.size === 0 ? undefined : [...files];
}

export function readResults(root: string, paths: readonly string[] | undefined): TestResult[] | undefined {
  return resultFiles(root, paths)?.flatMap(file => parseJunit(readFileSync(file, 'utf8')));
}

/** The integration tier lives in `tests/integration/`; every other test file (unit, scripts, ...) is the unit report's. */
export const inTier = (file: string, tier: 'unit' | 'int'): boolean =>
  (tier === 'int') === /(?:^|\/)tests\/integration\//.test(file);

/** The id → files map narrowed to one tier (an id with no file in the tier is dropped). */
export function tierTests(
  tests: ReadonlyMap<string, readonly string[]>,
  tier: 'unit' | 'int' | undefined,
): ReadonlyMap<string, readonly string[]> {
  if (tier === undefined) return tests;
  const out = new Map<string, readonly string[]>();
  for (const [id, files] of tests) {
    const mine = files.filter(file => inTier(file, tier));
    if (mine.length > 0) out.set(id, mine);
  }
  return out;
}

export function readRows(root: string): GuaranteeRow[] | Finding {
  const file = join(root, GUARANTEES_TSV);
  if (!existsSync(file))
    return {
      check: 'guarantees',
      where: GUARANTEES_TSV,
      message: 'missing; it is written by `bun scripts/rebuild/guarantees.ts`',
    };
  return parseTsv(readFileSync(file, 'utf8'));
}

/** Packages cut from the release (`deferred.json`, created by the first cut, §10.6). */
function releaseCut(root: string): ReadonlySet<string> | undefined {
  const file = join(root, 'deferred.json');
  if (!existsSync(file)) return undefined;
  return new Set((JSON.parse(readFileSync(file, 'utf8')) as { deferred?: string[] }).deferred ?? []);
}

/** The folder whose tests count as an owner's suite. */
export function ownerFolder(ws: Workspace, owner: string): string | undefined {
  if (owner === 'repo-tooling') return 'scripts';
  if (owner === 'fy-shell') return ws.byName('fy')?.rel ?? 'packages/cli';
  if (owner === 'app-shell') return ws.byName('@ferretry/app')?.rel ?? 'packages/app';
  return ws.byId(owner)?.rel;
}

export function skipped(
  row: GuaranteeRow,
  pending: ReadonlySet<string>,
  cut: ReadonlySet<string> | undefined,
  strict: boolean,
): boolean {
  if (strict) return false;
  if (pending.has(row.owner)) return true;
  return cut !== undefined && cut.has(row.owner);
}

export function guaranteeFindings(
  rows: readonly GuaranteeRow[],
  tests: ReadonlyMap<string, readonly string[]>,
  pending: ReadonlySet<string>,
  cut: ReadonlySet<string> | undefined,
  strict: boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const has = (tests.get(row.id) ?? []).length > 0;
    if (row.status === 'removed') {
      if (has)
        findings.push({
          check: 'guarantees',
          where: row.id,
          message: `REMOVED row still has a test (${tests.get(row.id)?.join(', ')}); its code remains`,
        });
      continue;
    }
    if (skipped(row, pending, cut, strict)) continue;
    if (!has)
      findings.push({
        check: 'guarantees',
        where: row.id,
        message: `${row.status} row owned by ${row.owner || '?'} has no test named "${row.id} …"`,
      });
  }
  return findings;
}

/**
 * The kept rows whose id-named test, in the owner's suite, does not provably pass. A test counts once however many
 * reports hold it (a quarantine rerun writes the same test again): it passed when ANY run passed, and failed only
 * when none did. A kept row with no test at all is `guaranteeFindings`'s, not repeated here.
 */
export function passFindings(
  rows: readonly GuaranteeRow[],
  tests: ReadonlyMap<string, readonly string[]>,
  results: readonly TestResult[],
  folderOf: (owner: string) => string | undefined,
  pending: ReadonlySet<string>,
  cut: ReadonlySet<string> | undefined,
  strict: boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    if (row.status === 'removed' || skipped(row, pending, cut, strict)) continue;
    const folder = folderOf(row.owner);
    // Only the owner's own tests can prove a row (the results below are filtered the same way), so a row whose
    // tests in this tier all live in other packages has nothing for this tier to prove; guarantee-owner flags
    // a row tested only outside its owner, and an unrelated suite reusing the id is not the row's test.
    const owned = (tests.get(row.id) ?? []).filter(file => folder === undefined || file.startsWith(`${folder}/`));
    if (owned.length === 0) continue;
    const mine = results.filter(
      result =>
        result.id === row.id && (folder === undefined || result.file === '' || result.file.startsWith(`${folder}/`)),
    );
    const byTest = new Map<string, TestResult['status']>();
    for (const result of mine) {
      const key = `${result.file}\0${result.name}`;
      const was = byTest.get(key);
      if (was === 'passed' || result.status === 'passed') byTest.set(key, 'passed');
      else byTest.set(key, was === 'failed' || result.status === 'failed' ? 'failed' : 'skipped');
    }
    const failed = [...byTest]
      .filter(([, status]) => status === 'failed')
      .map(([key]) => key.split('\0').reverse().join(' in '));
    if (failed.length > 0)
      findings.push({
        check: 'guarantees',
        where: row.id,
        message: `${row.status} row owned by ${row.owner || '?'} has a FAILING test: ${failed.join('; ')}`,
      });
    else if (![...byTest.values()].includes('passed'))
      findings.push({
        check: 'guarantees',
        where: row.id,
        message: `${row.status} row owned by ${row.owner || '?'} has a test named "${row.id} …" but no passing run of it in the results (skipped, not run, or outside ${folder ?? 'its owner'})`,
      });
  }
  return findings;
}

/** Backticked identifiers in an enforcer phrase (paths, routes and prose are skipped). */
export function enforcerSymbols(enforcer: string): string[] {
  const out: string[] = [];
  for (const match of enforcer.matchAll(/`([^`]+)`/g)) {
    const token = (match[1] as string).replace(/\(\)$/, '');
    if (/^[A-Za-z_$][\w$]{2,}[A-Za-z0-9$]$/.test(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

async function ownerFindings(
  root: string,
  ws: Workspace,
  rows: readonly GuaranteeRow[],
  tests: ReadonlyMap<string, readonly string[]>,
  pending: ReadonlySet<string>,
  cut: ReadonlySet<string> | undefined,
  strict: boolean,
  consumed: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Finding[]> {
  const check = 'guarantee-owner';
  const findings: Finding[] = [];
  const sourceCache = new Map<string, string>();
  const textOf = (owner: string): string => {
    const cached = sourceCache.get(owner);
    if (cached !== undefined) return cached;
    const folder = ownerFolder(ws, owner);
    const parts: string[] = [];
    const pkg = ws.packages.find(p => p.rel === folder);
    if (pkg !== undefined)
      for (const file of sourceFiles(pkg, { tests: false })) parts.push(readFileSync(file, 'utf8'));
    for (const other of consumed.get(owner) ?? []) {
      const otherPkg = ws.byId(other);
      const contract = otherPkg === undefined ? undefined : contractPath(otherPkg);
      if (otherPkg !== undefined && contract !== undefined)
        for (const file of sourceFiles(otherPkg, { tests: false }))
          if (file.startsWith(join(otherPkg.dir, 'contract'))) parts.push(readFileSync(file, 'utf8'));
    }
    const text = parts.join('\n');
    sourceCache.set(owner, text);
    return text;
  };
  for (const row of rows) {
    if (row.status === 'removed' || skipped(row, pending, cut, strict)) continue;
    const files = tests.get(row.id) ?? [];
    if (files.length === 0) continue; // `guarantees` reports it
    const folder = ownerFolder(ws, row.owner);
    if (folder === undefined) {
      findings.push({ check, where: row.id, message: `owner "${row.owner}" is no package` });
      continue;
    }
    if (!files.some(file => file.startsWith(`${folder}/`)))
      findings.push({
        check,
        where: row.id,
        message: `tested only outside its owner's suite (${folder}): ${files.join(', ')}`,
      });
    const text = textOf(row.owner);
    for (const symbol of enforcerSymbols(row.enforcer))
      if (!new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`).test(text))
        findings.push({
          check,
          where: row.id,
          message: `enforcer \`${symbol}\` resolves to no symbol in ${row.owner} or a contract it consumes`,
        });
  }
  void root;
  return findings;
}

export const check: Check = {
  name: 'guarantees',
  summary: 'every kept Appendix D row has a test named with its id',
  async run(ctx) {
    const rows = readRows(ctx.root);
    if (!Array.isArray(rows)) return [rows];
    const ws = loadWorkspace(ctx.root);
    const pending = new Set(readPending(ctx.root).pending);
    const relevant = ctx.packageId === undefined ? rows : rows.filter(row => row.owner === ctx.packageId);
    const tests = testIds(ctx.root, ws);
    const cut = releaseCut(ctx.root);
    const strict = ctx.strict === true;
    // A tier judges its own rows' passes; "no test" and "REMOVED row left a test" are tier-independent, so the
    // unit job reports them once and the integration job does not repeat them.
    const found = ctx.tier === 'int' ? [] : guaranteeFindings(relevant, tests, pending, cut, strict);
    if (ctx.existenceOnly === true) return found;
    const results = readResults(ctx.root, ctx.results);
    if (results === undefined)
      return ctx.packageId !== undefined
        ? found
        : [
            ...found,
            {
              check: 'guarantees',
              where: 'results',
              message:
                'no JUnit report found (run the unit tier, or pass --results <junit.xml|folder>), so no test is proven to PASS; --existence-only checks titles alone',
            },
          ];
    return [
      ...found,
      ...passFindings(
        relevant,
        tierTests(tests, ctx.tier),
        results,
        owner => ownerFolder(ws, owner),
        pending,
        cut,
        strict,
      ),
    ];
  },
};

export const ownerCheck: Check = {
  name: 'guarantee-owner',
  summary: "each row is tested in its owner's suite and its enforcer lives there",
  async run(ctx) {
    const rows = readRows(ctx.root);
    if (!Array.isArray(rows)) return [rows];
    const model = await ctx.model();
    const pending = new Set(readPending(ctx.root).pending);
    const relevant = ctx.packageId === undefined ? rows : rows.filter(row => row.owner === ctx.packageId);
    return ownerFindings(
      ctx.root,
      model.ws,
      relevant,
      testIds(ctx.root, model.ws),
      pending,
      releaseCut(ctx.root),
      ctx.strict === true,
      model.consumed,
    );
  },
};

if (import.meta.main) {
  const owner = process.argv.includes('--owner');
  await runMain(
    owner ? ownerCheck : check,
    process.argv.slice(2).filter(arg => arg !== '--owner'),
  );
}
