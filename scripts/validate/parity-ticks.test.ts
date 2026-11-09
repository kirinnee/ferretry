import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DescriptorRow } from '../../packages/core/kernel/testing/parity.ts';
import { movedFindings, movedPairs, readChanges } from './descriptor-parity.ts';
import { junitCases } from './guarantees.ts';
import {
  FROZEN_IDS,
  type LedgerRow,
  type TickContext,
  liveTitles,
  readKnown,
  routeWorld,
  statusProofFindings,
  tickFindings,
} from './parity-ticks.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'parity-ticks-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const TEST = 'pkg/tests/unit/a.test.ts';
const row = (over: Partial<LedgerRow>): LedgerRow => ({
  id: 'F-0019',
  kind: 'F',
  what: 'x',
  name5: 'x',
  check: TEST,
  status: '[x]',
  ...over,
});
const routeRow = (id: string, what: string, check = TEST): LedgerRow =>
  row({ id, kind: 'R', what, name5: what, check });

const todayRow = (key: string, extra: Record<string, unknown> = {}): DescriptorRow => ({
  table: 'route',
  key,
  minimum: 'operator',
  caller: 'any',
  ...extra,
});
const noWorld = () => routeWorld([], [], new Map());
const ctx = (root: string, world = noWorld, more: Partial<TickContext> = {}): TickContext => ({ root, world, ...more });
const run = (
  rows: LedgerRow[],
  tc: TickContext,
  known = new Map<string, string>(),
  frozen: ReadonlySet<string> = new Set(known.keys()),
) => tickFindings(rows, tc, known, frozen).map(f => `${f.where}: ${f.message}`);
const rec = (change: string) => ({ change, reason: 'why' });

describe('parity-ticks: the test that names a row', () => {
  test('an id in a passing test title passes', () => {
    const root = fixture({ [TEST]: "test('F-0019 does it', () => {})" });
    expect(run([row({})], ctx(root))).toEqual([]);
  });

  test('an id only in a describe title fails: a describe runs nothing, so no case can turn red for the row', () => {
    for (const source of [
      "describe('F-0019 group', () => { test('does it', () => {}) })",
      "describe.each([1])('F-0019 group', () => { test('does it', () => {}) })",
    ]) {
      const root = fixture({ [TEST]: source });
      expect(run([row({})], ctx(root))[0], source).toContain('no live test() or it() title');
    }
  });

  test('an id in a case title passes inside a describe, and moving it up to the describe makes the row fail', () => {
    const inCase = fixture({ [TEST]: "describe('group', () => { test('F-0019 does it', () => {}) })" });
    expect(run([row({})], ctx(inCase))).toEqual([]);
    const moved = fixture({ [TEST]: "describe('F-0019 group', () => { test('does it', () => {}) })" });
    expect(run([row({})], ctx(moved))[0]).toContain('names F-0019');
  });

  test('an id only in a comment fails', () => {
    const root = fixture({ [TEST]: "// F-0019\ntest('something else', () => {})" });
    expect(run([row({})], ctx(root))[0]).toContain('names F-0019');
  });

  test('an id only in a string elsewhere in the file fails', () => {
    const root = fixture({
      [TEST]: "const table = ['F-0019'];\ntest('unrelated', () => { expect(table).toBeTruthy() })",
    });
    expect(run([row({})], ctx(root))[0]).toContain('names F-0019');
  });

  test('an id in a skipped, todo, only or skipped-describe title fails', () => {
    for (const source of [
      "test.skip('F-0019 x', () => {})",
      "it.todo('F-0019 x')",
      "test.only('F-0019 x', () => {})",
      "describe.skip('group', () => { test('F-0019 x', () => {}) })",
      "test.skipIf(true)('F-0019 x', () => {})",
    ]) {
      const root = fixture({ [TEST]: source });
      expect(run([row({})], ctx(root))[0], source).toContain('names F-0019');
    }
  });

  test('a title with an expression in it does not read as the id, and a literal if(false) is dead', () => {
    for (const source of [
      "const x = 'z'; test(`F-00${x}19 x`, () => {})",
      "const x = 'z'; test(`F-0019${x} x`, () => {})",
      "test.if(false)('F-0019 x', () => {})",
      "describe.if(false)('group', () => { test('F-0019 x', () => {}) })",
    ]) {
      const root = fixture({ [TEST]: source });
      expect(run([row({})], ctx(root))[0], source).toContain('names F-0019');
    }
    const live = fixture({ [TEST]: "test.if(process.platform === 'linux')('F-0019 x', () => {})" });
    expect(run([row({})], ctx(live))).toEqual([]);
  });

  test('a longer id does not stand for a shorter one', () => {
    const root = fixture({ [TEST]: "test('F-00191 x', () => {})" });
    expect(run([row({})], ctx(root))[0]).toContain('names F-0019');
  });

  test('a check that is a directory, a non-test file or a test outside tests/ fails', () => {
    const root = fixture({ 'pkg/tests/notes.md': 'F-0019', 'pkg/x.test.ts': "test('F-0019 x', () => {})" });
    expect(run([row({ check: 'pkg/tests' })], ctx(root))[0]).toContain('not a *.test.ts(x) file under a tests/ folder');
    expect(run([row({ check: 'pkg/tests/notes.md' })], ctx(root))[0]).toContain('not a *.test.ts(x) file');
    expect(run([row({ check: 'pkg/x.test.ts' })], ctx(root))[0]).toContain('not a *.test.ts(x) file');
    // a directory named like a test file is still not a regular file
    const dir = fixture({ 'pkg/tests/d.test.ts/inner.txt': 'F-0019' });
    expect(run([row({ check: 'pkg/tests/d.test.ts' })], ctx(dir))[0]).toContain('not a regular file');
  });

  test('a missing check file or an empty check fails; an open row is never checked', () => {
    const root = fixture({});
    expect(run([row({}), row({ id: 'F-0021', check: '' })], ctx(root))).toEqual([
      `F-0019: check path does not exist: ${TEST}`,
      'F-0021: empty check cell',
    ]);
    expect(run([row({ status: '[ ]', check: '' })], ctx(root))).toEqual([]);
  });

  test('a test that failed or did not run in the results fails, a passing one passes', () => {
    const root = fixture({ [TEST]: "test('F-0019 does it', () => {})" });
    const xml = (inner: string) =>
      junitCases(`<testsuites><testsuite name="a.test.ts" file="${TEST}">${inner}</testsuite></testsuites>`);
    const pass = ctx(root, noWorld, { results: xml('<testcase name="F-0019 does it"/>') });
    const fail = ctx(root, noWorld, {
      results: xml('<testcase name="F-0019 does it"><failure message="x"/></testcase>'),
    });
    const skipped = ctx(root, noWorld, { results: xml('<testcase name="F-0019 does it"><skipped/></testcase>') });
    const absent = ctx(root, noWorld, { results: xml('<testcase name="other"/>') });
    expect(run([row({})], pass)).toEqual([]);
    expect(run([row({})], fail)[0]).toContain('FAILED');
    expect(run([row({})], skipped)[0]).toContain('no passing run');
    expect(run([row({})], absent)[0]).toContain('no passing run');
    // a case with no file attribute does not satisfy any check path
    const nofile = ctx(root, noWorld, {
      results: junitCases('<testsuites><testsuite name="x"><testcase name="F-0019 does it"/></testsuite></testsuites>'),
    });
    expect(run([row({})], nofile)[0]).toContain('no passing run');
    // the other tier's report cannot judge a unit file
    expect(run([row({})], { ...absent, tier: 'int' })).toEqual([]);
  });
});

describe('parity-ticks: a route also needs descriptor-parity', () => {
  const R = routeRow('R-0001', 'GET /v1/a');
  let named = '';
  beforeEach(() => {
    named = fixture({ [TEST]: "test('R-0001 serves it', () => {})" });
  });

  test('proven by a test and an equal descriptor passes; a route 5.0 lacks fails', () => {
    const same = () => routeWorld([todayRow('GET /v1/a')], [todayRow('GET /v1/a')], new Map());
    expect(run([R], ctx(named, same))).toEqual([]);
    const gone = () => routeWorld([todayRow('GET /v1/a')], [], new Map());
    expect(run([R], ctx(named, gone))[0]).toContain('route missing');
  });

  test('descriptor-parity alone (no test) never ticks a route', () => {
    const same = () => routeWorld([todayRow('GET /v1/a')], [todayRow('GET /v1/a')], new Map());
    expect(run([routeRow('R-0001', 'GET /v1/a', 'descriptor-parity')], ctx(named, same))[0]).toContain(
      'not a *.test.ts(x) file',
    );
  });

  test('a changed record with a loosening fails, with only tightenings passes', () => {
    const records = new Map([['route\tGET /v1/a', rec('changed')]]);
    const loose = {
      ...todayRow('GET /v1/a', {
        minimum: 'operator',
        caller: 'person',
        capability: { capability: 'fleet', axis: 'use' },
      }),
      minimum: 'none',
      caller: 'any',
    };
    delete (loose as Record<string, unknown>).capability;
    const wasStrict = () =>
      routeWorld(
        [todayRow('GET /v1/a', { caller: 'person', capability: { capability: 'fleet', axis: 'use' } })],
        [loose],
        records,
      );
    expect(run([R], ctx(named, wasStrict))[0]).toContain('not a tightening');
    const tight = {
      ...todayRow('GET /v1/a'),
      minimum: 'admin-token',
      caller: 'person',
      noStore: true,
      privilegedOnly: true,
      capability: { capability: 'fleet', axis: 'use' },
    };
    const ok = () => routeWorld([todayRow('GET /v1/a')], [tight], records);
    expect(run([R], ctx(named, ok))).toEqual([]);
    const bare = () => routeWorld([todayRow('GET /v1/a')], [tight], new Map());
    expect(run([R], ctx(named, bare))[0]).toContain('no record');
  });

  test('a moved route passes only with both halves recorded, and a recorded difference must be a tightening', () => {
    const r = routeRow('R-0001', 'GET /v1/sessions/:sessionId/q');
    const today = [todayRow('GET /v1/sessions/:sessionId/q')];
    const next = [todayRow('GET /v1/ferrets/:ferretId/q')];
    const both = new Map([
      ['route\tGET /v1/sessions/:sessionId/q', rec('removed')],
      ['route\tGET /v1/ferrets/:ferretId/q', rec('added')],
    ]);
    const named2 = fixture({ [TEST]: "test('R-0001 q', () => {})" });
    expect(
      run(
        [r],
        ctx(named2, () => routeWorld(today, next, both)),
      ),
    ).toEqual([]);
    const half = new Map([...both].slice(0, 1));
    expect(
      run(
        [r],
        ctx(named2, () => routeWorld(today, next, half)),
      )[0],
    ).toContain('no single counterpart');
    const noStoreLost = [todayRow('GET /v1/sessions/:sessionId/q', { noStore: true })];
    expect(
      run(
        [r],
        ctx(named2, () => routeWorld(noStoreLost, next, both)),
      )[0],
    ).toContain('no record');
    const recorded = new Map(both).set('route\tGET /v1/ferrets/:ferretId/q', rec('moved-changed'));
    expect(
      run(
        [r],
        ctx(named2, () => routeWorld(noStoreLost, next, recorded)),
      )[0],
    ).toContain('not a tightening');
  });
});

describe('parity-ticks: a status that says "proved by test X" names a live test', () => {
  const STATUS = 'removed by design (§9.1: the converter renders it, proved by its tests J-0052)';
  const rows = [row({ id: 'J-0052', kind: 'J', status: STATUS })];
  const findings = (source: string | undefined): string[] => {
    const root = fixture(source === undefined ? {} : { 'migration/tests/unit/p.test.ts': source });
    const files = source === undefined ? [] : ['migration/tests/unit/p.test.ts'];
    return statusProofFindings(
      rows,
      files,
      file => readFileSync(join(root, file), 'utf8'),
      file => liveTitles(join(root, file)),
    ).map(f => `${f.where}: ${f.message}`);
  };

  test('a live test or it title naming the id passes', () => {
    expect(findings("test('J-0052 renders it', () => {})")).toEqual([]);
    expect(findings("describe('g', () => { it('J-0052 renders it', () => {}) })")).toEqual([]);
  });

  test('a skipped, todo, untitled, describe-only or missing test fails', () => {
    for (const source of [
      "test.skip('J-0052 renders it', () => {})",
      "it.todo('J-0052 renders it')",
      "test('renders it', () => {})",
      "describe('J-0052 renders it', () => { test('x', () => {}) })",
      undefined,
    ])
      expect(findings(source)[0], String(source)).toContain('proved by test J-0052');
  });

  test('a status that names no test is left alone, and every id of a list is checked', () => {
    const plain = [row({ id: 'J-0009', kind: 'J', status: 'removed by design (§9.1: the daemon runs no sweep)' })];
    expect(
      statusProofFindings(
        plain,
        [],
        () => '',
        () => [],
      ),
    ).toEqual([]);
    const two = [row({ id: 'J-0052', kind: 'J', status: 'proved by tests J-0052, J-0053' })];
    const out = statusProofFindings(
      two,
      ['t.test.ts'],
      () => 'J-0052 J-0053',
      () => ['J-0052 renders it'],
    );
    expect(out.map(f => f.message).join('\n')).toContain('J-0053');
    expect(out.map(f => f.message).join('\n')).not.toContain('test J-0052,');
  });
});

describe('parity-ticks: a rescued flake is a pass', () => {
  test('a first run that failed and a rerun that passed passes; only failed runs fail', () => {
    const root = fixture({ [TEST]: "test('F-0019 does it', () => {})" });
    const xml = (inner: string) =>
      junitCases(`<testsuites><testsuite name="a.test.ts" file="${TEST}">${inner}</testsuite></testsuites>`);
    const failed = '<testcase name="F-0019 does it"><failure message="x"/></testcase>';
    const passed = '<testcase name="F-0019 does it"/>';
    expect(run([row({})], ctx(root, noWorld, { results: xml(failed + passed) }))).toEqual([]);
    expect(run([row({})], ctx(root, noWorld, { results: xml(failed) }))[0]).toContain('FAILED');
  });
});

describe('descriptor-parity-changes: one record per key', () => {
  test('a key recorded twice is refused', () => {
    const line = 'route\tGET /v1/a\tchanged\twhy\n';
    expect(readChanges(line).size).toBe(1);
    expect(() => readChanges(line + line)).toThrow('recorded twice');
  });
});

describe('parity-ticks: the known list only shrinks', () => {
  test('FROZEN_IDS holds no R row and at most 42 ids (the 64 descriptor-only R rows are open again)', () => {
    expect(FROZEN_IDS.size).toBeLessThanOrEqual(42);
    expect([...FROZEN_IDS].filter(id => id.startsWith('R-'))).toEqual([]);
  });

  test('a frozen id that is no longer listed fails (the two sets are equal)', () => {
    const root = fixture({ [TEST]: "test('F-0019 ok', () => {})" });
    expect(run([row({})], ctx(root), new Map(), new Set(['F-0019']))).toEqual([
      'F-0019: in FROZEN_IDS but not listed in scripts/validate/parity-ticks-known.tsv: delete it from FROZEN_IDS (the two sets must be equal)',
    ]);
  });

  test('an id added to the known list that FROZEN_IDS does not hold fails', () => {
    const root = fixture({ [TEST]: "test('unrelated', () => {})" });
    const known = readKnown('# note\nF-0019\tstill being fixed\n');
    expect(run([row({})], ctx(root), known, new Set())).toEqual([
      expect.stringContaining('F-0019: listed in scripts/validate/parity-ticks-known.tsv but not in FROZEN_IDS'),
    ]);
  });

  test('a frozen row is skipped while it fails; an entry that passes or is not ticked fails', () => {
    const root = fixture({ [TEST]: "test('F-0030 ok', () => {})" });
    const known = readKnown('F-0019\tstill being fixed\nF-0030\tfixed\nF-0077\tgone\n');
    expect(run([row({}), row({ id: 'F-0030' })], ctx(root), known)).toEqual([
      'F-0030: passes now; remove it from scripts/validate/parity-ticks-known.tsv and FROZEN_IDS',
      'F-0077: not a ticked row; remove it from scripts/validate/parity-ticks-known.tsv and FROZEN_IDS',
    ]);
  });
});

describe('descriptor-parity: moved pairs', () => {
  const removed = (k: string) => [`route\t${k}`, rec('removed')] as const;
  const added = (k: string, kind = 'added') => [`route\t${k}`, rec(kind)] as const;

  test('a moved pair with an unrecorded difference fails; equal, or recorded moved-changed, passes', () => {
    const today = [todayRow('GET /v1/sessions/:sessionId/q', { noStore: true })];
    const next = [todayRow('GET /v1/ferrets/:ferretId/q')];
    const bare = new Map([removed('GET /v1/sessions/:sessionId/q'), added('GET /v1/ferrets/:ferretId/q')]);
    expect(movedFindings(today, next, bare).map(f => f.message)).toEqual([expect.stringContaining('noStore true → ∅')]);
    const kept = [todayRow('GET /v1/ferrets/:ferretId/q', { noStore: true })];
    expect(movedFindings(today, kept, bare)).toEqual([]);
    const recorded = new Map([
      removed('GET /v1/sessions/:sessionId/q'),
      added('GET /v1/ferrets/:ferretId/q', 'moved-changed'),
    ]);
    expect(movedFindings(today, next, recorded)).toEqual([]);
    // a record with nothing to record is stale
    expect(movedFindings(today, kept, recorded).map(f => f.message)).toEqual([
      expect.stringContaining('equals its pair'),
    ]);
  });

  describe('explicit moved records', () => {
    const rows = (...keys: string[]) => keys.map(k => todayRow(k));
    const moved = (old: string, to: string, kind = 'added') =>
      readChanges(`route\t${old}\tmoved\t${to}\twhy\nroute\t${to}\t${kind}\twhy\n`);
    const OLD = 'GET /v1/fleet/machine';
    const NEW = 'GET /v1/runtimes/machine';

    test('an explicit pair no shape rule derives is proven', () => {
      const changes = moved(OLD, NEW);
      expect(movedPairs(rows(OLD), rows(NEW), changes).pairs).toHaveLength(1);
      expect(movedFindings(rows(OLD), rows(NEW), changes)).toEqual([]);
    });

    test('a loosening through an explicit pair is a finding', () => {
      const today = [todayRow(OLD, { noStore: true })];
      expect(movedFindings(today, rows(NEW), moved(OLD, NEW)).map(f => f.message)).toEqual([
        expect.stringContaining('noStore true → ∅'),
      ]);
      // a recorded difference is still judged: dropping noStore is no tightening, so the row cannot tick
      const r = routeRow('R-0003', OLD);
      const named = fixture({ [TEST]: "test('R-0003 m', () => {})" });
      const loose = () => routeWorld(today, rows(NEW), moved(OLD, NEW, 'moved-changed'));
      expect(run([r], ctx(named, loose))[0]).toContain('not a tightening');
    });

    test('two old keys naming one new key is a finding', () => {
      const changes = readChanges(
        `route\t${OLD}\tmoved\t${NEW}\twhy\nroute\tGET /v1/fleet/other\tmoved\t${NEW}\twhy\nroute\t${NEW}\tadded\twhy\n`,
      );
      expect(movedFindings(rows(OLD, 'GET /v1/fleet/other'), rows(NEW), changes).map(f => f.message)).toEqual([
        expect.stringContaining('claimed by 2'),
      ]);
    });

    test('a missing new key, a method change and an unrecorded target are findings', () => {
      expect(movedFindings(rows(OLD), [], moved(OLD, NEW)).map(f => f.message)).toEqual([
        expect.stringContaining('declares no route GET /v1/runtimes/machine'),
      ]);
      expect(
        movedFindings(rows(OLD), rows('POST /v1/runtimes/machine'), moved(OLD, 'POST /v1/runtimes/machine')).map(
          f => f.message,
        ),
      ).toEqual([expect.stringContaining('changes the method')]);
      const unrecorded = readChanges(`route\t${OLD}\tmoved\t${NEW}\twhy\n`);
      expect(movedFindings(rows(OLD), rows(NEW), unrecorded).map(f => f.message)).toEqual([
        expect.stringContaining('not recorded added'),
      ]);
    });

    test('an explicit record wins over shape derivation, and a bad one does not fall back', () => {
      const SHAPE = 'GET /v1/sessions/:s/q';
      const changes = readChanges(
        `route\t${SHAPE}\tmoved\t${NEW}\twhy\nroute\t${NEW}\tadded\twhy\nroute\tGET /v1/ferrets/:f/q\tadded\twhy\n`,
      );
      const pairs = movedPairs(rows(SHAPE), rows(NEW, 'GET /v1/ferrets/:f/q'), changes).pairs;
      expect(pairs.map(p => p.now.key)).toEqual([NEW]);
      const bad = readChanges(
        `route\t${SHAPE}\tmoved\tGET /v1/nowhere\twhy\nroute\tGET /v1/ferrets/:f/q\tadded\twhy\n`,
      );
      expect(movedPairs(rows(SHAPE), rows('GET /v1/ferrets/:f/q'), bad).pairs).toEqual([]);
    });

    test('a ledger row ticks through an explicit pair; a broken record says why', () => {
      const r = routeRow('R-0002', OLD);
      const named = fixture({ [TEST]: "test('R-0002 m', () => {})" });
      const world =
        (next: DescriptorRow[], changes = moved(OLD, NEW)) =>
        () =>
          routeWorld(rows(OLD), next, changes);
      expect(run([r], ctx(named, world(rows(NEW))))).toEqual([]);
      expect(run([r], ctx(named, world([])))[0]).toContain('declares no route GET /v1/runtimes/machine');
    });

    test('a moved record needs a new key and a reason; it reads as a removal', () => {
      expect(() => readChanges(`route\t${OLD}\tmoved\t\twhy\n`)).toThrow('is not table');
      expect(() => readChanges(`route\t${OLD}\tmoved\t${NEW}\n`)).toThrow('is not table');
      expect(readChanges(`route\t${OLD}\tmoved\t${NEW}\twhy\n`).get(`route\t${OLD}`)).toEqual({
        change: 'removed',
        reason: 'why',
        to: NEW,
      });
    });

    test('a record with an unknown change kind, or a moved tool, is refused naming the line', () => {
      expect(() => readChanges(`route\t${OLD}\tmovedGET /v1/x\twhy\n`)).toThrow('is not table');
      expect(() => readChanges(`route\t${OLD}\tmovedGET /v1/x\twhy\n`)).toThrow('movedGET /v1/x');
      expect(() => readChanges('tool\told_tool\tmoved\tnew_tool\twhy\n')).toThrow('is not table');
    });

    test('a new key that exists only in another table is a finding', () => {
      const member: DescriptorRow = { ...todayRow(NEW), table: 'member' };
      const changes = readChanges(`route\t${OLD}\tmoved\t${NEW}\twhy\nmember\t${NEW}\tadded\twhy\n`);
      expect(movedFindings(rows(OLD), [member], changes).map(f => f.message)).toEqual([
        expect.stringContaining('declares no route GET /v1/runtimes/machine'),
      ]);
    });

    test('an explicit pair and a shape-derived one onto the same new key are both claimed', () => {
      const SHAPE = 'GET /v1/sessions/:s/q';
      const TARGET = 'GET /v1/ferrets/:f/q';
      const changes = readChanges(
        `route\t${OLD}\tmoved\t${TARGET}\twhy\nroute\t${SHAPE}\tremoved\twhy\nroute\t${TARGET}\tadded\twhy\n`,
      );
      expect(movedFindings(rows(OLD, SHAPE), rows(TARGET), changes).map(f => f.message)).toEqual([
        expect.stringContaining('claimed by 2'),
      ]);
      const r = routeRow('R-0004', OLD);
      const named = fixture({ [TEST]: "test('R-0004 m', () => {})" });
      expect(
        run(
          [r],
          ctx(named, () => routeWorld(rows(OLD, SHAPE), rows(TARGET), changes)),
        )[0],
      ).toContain('claimed by more than one');
    });
  });

  test('two removed routes that collapse onto one 5.0 route fail', () => {
    const today = [todayRow('GET /v1/sessions/:a/q'), todayRow('GET /v1/sessions/:b/q')];
    const next = [todayRow('GET /v1/ferrets/:f/q')];
    const changes = new Map([
      removed('GET /v1/sessions/:a/q'),
      removed('GET /v1/sessions/:b/q'),
      added('GET /v1/ferrets/:f/q'),
    ]);
    expect(movedFindings(today, next, changes).map(f => f.message)).toEqual([expect.stringContaining('claimed by 2')]);
  });
});
