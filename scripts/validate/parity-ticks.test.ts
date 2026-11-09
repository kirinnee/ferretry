import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DescriptorRow } from '../../packages/core/kernel/testing/parity.ts';
import { type LedgerRow, readKnown, routeWorld, tickFindings } from './parity-ticks.ts';

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

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  id: 'F-0019',
  kind: 'F',
  what: 'x',
  name5: 'x',
  check: 'a.test.ts',
  status: '[x]',
  ...over,
});

const todayRow = (key: string): DescriptorRow => ({ table: 'route', key, minimum: 'operator' });
const noWorld = () => routeWorld([], [], new Map());
const run = (rows: LedgerRow[], root: string, world = noWorld, known = new Map<string, string>()) =>
  tickFindings(rows, root, world, known).map(f => `${f.where}: ${f.message}`);

describe('parity-ticks', () => {
  test('a ticked row whose check file names its id passes', () => {
    const root = fixture({ 'a.test.ts': "test('F-0019 does it', () => {})" });
    expect(run([row({})], root)).toEqual([]);
  });

  test('a ticked row whose check file never names its id fails', () => {
    const root = fixture({ 'a.test.ts': "test('F-0020 other', () => {})" });
    expect(run([row({})], root)).toEqual(['F-0019: check file never mentions F-0019: a.test.ts']);
  });

  test('a ticked row with a missing check file or an empty check fails', () => {
    const root = fixture({});
    expect(run([row({}), row({ id: 'F-0021', check: '' })], root)).toEqual([
      'F-0019: check path does not exist: a.test.ts',
      'F-0021: empty check cell',
    ]);
  });

  test('an open row is never checked', () => {
    expect(run([row({ status: '[ ]', check: '' })], fixture({}))).toEqual([]);
  });

  test('a route proven by descriptor-parity passes, one missing from 5.0 fails', () => {
    const world = () => routeWorld([todayRow('GET /v1/a'), todayRow('GET /v1/b')], [todayRow('GET /v1/a')], new Map());
    const ok = row({ id: 'R-0001', kind: 'R', what: 'GET /v1/a', name5: 'GET /v1/a', check: 'descriptor-parity' });
    const gone = row({ id: 'R-0002', kind: 'R', what: 'GET /v1/b', name5: 'GET /v1/b', check: 'descriptor-parity' });
    expect(run([ok, gone], fixture({}), world)).toEqual(['R-0002: route missing: 5.0 declares no route GET /v1/b']);
  });

  test('a route whose descriptor changed with no record fails, and passes once recorded', () => {
    const next = { ...todayRow('GET /v1/a'), minimum: 'none' };
    const r = row({ id: 'R-0001', kind: 'R', what: 'GET /v1/a', name5: 'GET /v1/a', check: 'descriptor-parity' });
    const bare = () => routeWorld([todayRow('GET /v1/a')], [next], new Map());
    expect(run([r], fixture({}), bare)[0]).toContain('route changed with no record');
    const recorded = () =>
      routeWorld(
        [todayRow('GET /v1/a')],
        [next],
        new Map([['route\tGET /v1/a', { change: 'changed', reason: 'why' }]]),
      );
    expect(run([r], fixture({}), recorded)).toEqual([]);
  });

  test('a route ticked with a check other than descriptor-parity fails', () => {
    const r = row({ id: 'R-0001', kind: 'R', what: 'GET /v1/a', name5: 'GET /v1/a', check: 'a.test.ts' });
    expect(run([r], fixture({}))).toEqual(['R-0001: route check is "a.test.ts", not descriptor-parity']);
  });

  test('a route moved by a renamed word passes only when both halves are recorded', () => {
    const r = row({
      id: 'R-0001',
      kind: 'R',
      what: 'GET /v1/sessions/:sessionId/q',
      name5: 'x',
      check: 'descriptor-parity',
    });
    const today = [todayRow('GET /v1/sessions/:sessionId/q')];
    const next = [todayRow('GET /v1/ferrets/:ferretId/q')];
    const both = new Map([
      ['route\tGET /v1/sessions/:sessionId/q', { change: 'removed', reason: 'renamed' }],
      ['route\tGET /v1/ferrets/:ferretId/q', { change: 'added', reason: 'renamed' }],
    ]);
    expect(run([r], fixture({}), () => routeWorld(today, next, both))).toEqual([]);
    const half = new Map([...both].slice(0, 1));
    expect(run([r], fixture({}), () => routeWorld(today, next, half))[0]).toContain('no single counterpart');
  });

  test('a known row is skipped while it fails, and an entry that passes or is not ticked fails', () => {
    const root = fixture({ 'a.test.ts': 'F-0019' });
    const known = readKnown('# note\nF-0019\tstill being fixed\nF-0077\tgone\n');
    expect(run([row({}), row({ id: 'F-0030', check: 'missing.ts' })], root, noWorld, known)).toEqual([
      'F-0019: passes now; remove it from scripts/validate/parity-ticks-known.tsv',
      'F-0030: check path does not exist: missing.ts',
      'F-0077: not a ticked row; remove it from scripts/validate/parity-ticks-known.tsv',
    ]);
  });
});
