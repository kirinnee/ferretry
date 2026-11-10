import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AFTER_MERGE_JSON,
  type AfterMerge,
  afterMergeFindings,
  parityOpen,
  parseAfterMerge,
  portsPendingLines,
} from './after-merge.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'after-merge-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const BASE: AfterMerge = {
  format: 1,
  end: '2026-11-22',
  counts: { parityOpen: 10, portsPendingLines: 5, guaranteesMissing: 0 },
  items: [
    { id: 'darwin-smoke', what: 'the darwin smoke run', owner: 'gustavo' },
    { id: 'lane-p', what: 'kernel lane P', owner: 'gustavo' },
  ],
};
const AT_BASE = BASE.counts;

describe('after-merge', () => {
  test('the committed baseline parses and every item has an owner', () => {
    const committed = parseAfterMerge(
      readFileSync(join(import.meta.dir, '..', '..', AFTER_MERGE_JSON), 'utf8'),
      AFTER_MERGE_JSON,
    );
    expect(afterMergeFindings(committed, committed, committed.counts)).toEqual([]);
    expect(committed.items.map(item => item.id)).toContain('darwin-smoke');
    expect(committed.items.map(item => item.id)).toContain('ffi-descriptor-verify');
  });

  test('an unchanged or shrunk list passes', () => {
    expect(afterMergeFindings(BASE, BASE, AT_BASE)).toEqual([]);
    const shrunk: AfterMerge = {
      ...BASE,
      counts: { parityOpen: 7, portsPendingLines: 5, guaranteesMissing: 0 },
      items: BASE.items.slice(1),
    };
    expect(afterMergeFindings(shrunk, BASE, { parityOpen: 6, portsPendingLines: 4, guaranteesMissing: 0 })).toEqual([]);
  });

  test('a baseline count that grows against the base is a finding', () => {
    const grown: AfterMerge = { ...BASE, counts: { ...BASE.counts, parityOpen: 11 } };
    expect(afterMergeFindings(grown, BASE, AT_BASE).map(f => f.message)).toEqual([
      'counts.parityOpen grew from 10 to 11; the list may only go down',
    ]);
  });

  test('a tree over the baseline is a finding for each count', () => {
    const over = { parityOpen: 11, portsPendingLines: 6, guaranteesMissing: 1 };
    expect(afterMergeFindings(BASE, BASE, over).map(f => f.message)).toEqual([
      'parityOpen is 11 in the tree but the baseline is 10; the list may only go down',
      'portsPendingLines is 6 in the tree but the baseline is 5; the list may only go down',
      'guaranteesMissing is 1 in the tree but the baseline is 0; the list may only go down',
    ]);
  });

  test('an added item, an ownerless item, a duplicate and a later end date are findings', () => {
    const head: AfterMerge = {
      ...BASE,
      end: '2026-11-30',
      items: [...BASE.items, { id: 'new', what: 'more', owner: '' }, { id: 'lane-p', what: 'again', owner: 'kaizen' }],
    };
    expect(afterMergeFindings(head, BASE, AT_BASE).map(f => f.message)).toEqual([
      'new has no owner; every after-merge item keeps one',
      'lane-p is listed twice',
      'new was added; the list may only go down',
      'the end date moved from 2026-11-22 to 2026-11-30; only the owner moves it',
    ]);
  });

  test('with no base yet, the tree is still held to the baseline', () => {
    expect(afterMergeFindings(BASE, undefined, AT_BASE)).toEqual([]);
    expect(afterMergeFindings(BASE, undefined, { ...AT_BASE, guaranteesMissing: 2 })).toHaveLength(1);
  });

  test('a shape it cannot read is a sentence', () => {
    expect(() => parseAfterMerge('{"format":1,"end":"soon","counts":{},"items":[]}', 'x')).toThrow(
      'x: "end" is not a YYYY-MM-DD date',
    );
    expect(() => parseAfterMerge('{"format":1,"end":"2026-11-22","counts":{"parityOpen":-1},"items":[]}', 'x')).toThrow(
      'x: "counts.parityOpen" is not a whole number',
    );
  });

  test('counts open parity rows by the status column and every ports-pending line', () => {
    const root = fixture({
      'docs/design/rebuild-parity.tsv':
        'id\tkind\tstatus\nV-1\tV\t[ ]\nV-2\tV\t[x]\nV-3\tV\tremoved by design (x)\nV-4\tV\t[ ]\n',
      'ports-pending.json': JSON.stringify({
        format: 1,
        pending: ['a', 'b'],
        pendingReasons: { a: ['one', 'two'], b: ['three'] },
      }),
    });
    expect(parityOpen(root)).toBe(2);
    expect(portsPendingLines(root)).toBe(3);
  });
});
