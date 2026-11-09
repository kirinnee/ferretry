import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DescriptorRow } from '../../packages/core/kernel/testing/parity.ts';
import { movedFindings } from './descriptor-parity.ts';
import { junitCases } from './guarantees.ts';
import { type LedgerRow, type TickContext, readKnown, routeWorld, tickFindings } from './parity-ticks.ts';

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

  test('an id in an enclosing describe title passes', () => {
    const root = fixture({ [TEST]: "describe('F-0019 group', () => { test('does it', () => {}) })" });
    expect(run([row({})], ctx(root))).toEqual([]);
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

describe('parity-ticks: the known list only shrinks', () => {
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
