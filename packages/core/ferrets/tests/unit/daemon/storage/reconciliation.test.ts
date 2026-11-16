import { expect, test } from 'bun:test';
import { parseSessionId } from '../../../../daemon/lib/session-id.ts';
import { type DiskSessionObservation, planReconciliation } from '../../../../daemon/lib/storage/reconciliation.ts';
import type { IndexedSession, JournalFingerprint } from '../../../../daemon/lib/storage-types.ts';

const A = parseSessionId('session-a');
const B = parseSessionId('session-b');

const print = (over: Partial<JournalFingerprint> = {}): JournalFingerprint => ({
  device: '1',
  inode: '10',
  size: 100,
  modifiedAtMs: 5,
  ...over,
});
const indexed = (journal: JournalFingerprint | null, id = A): IndexedSession => ({
  id,
  lastSequence: 7,
  journalLine: 4,
  journal,
});
const disk = (journal: JournalFingerprint | null, lastIndexedEventMatches = true, id = A): DiskSessionObservation => ({
  id,
  journal,
  lastIndexedEventMatches,
});

test('a session on disk and not indexed is rescanned; one indexed and gone from disk is forgotten', () => {
  expect(planReconciliation([disk(print(), true, A)], [indexed(print(), B)])).toEqual([
    { kind: 'rescan', id: A },
    { kind: 'forget', id: B },
  ]);
});

test('actions come back sorted by id whatever order the inputs arrive in', () => {
  const plan = planReconciliation([disk(null, true, B), disk(null, true, A)], []);
  expect(plan.map(action => action.id)).toEqual([A, B]);
});

test('a session with no journal on either side only refreshes its metadata', () => {
  expect(planReconciliation([disk(null)], [indexed(null)])).toEqual([{ kind: 'refresh-metadata', id: A }]);
});

test('a journal that appeared or vanished since indexing is rescanned', () => {
  expect(planReconciliation([disk(print())], [indexed(null)])).toEqual([{ kind: 'rescan', id: A }]);
  expect(planReconciliation([disk(null)], [indexed(print())])).toEqual([{ kind: 'rescan', id: A }]);
});

test('an unchanged journal whose last event still matches refreshes metadata only', () => {
  expect(planReconciliation([disk(print())], [indexed(print())])).toEqual([{ kind: 'refresh-metadata', id: A }]);
});

test('an unchanged journal whose last event no longer matches is rescanned', () => {
  expect(planReconciliation([disk(print(), false)], [indexed(print())])).toEqual([{ kind: 'rescan', id: A }]);
});

test('a journal that only grew in the same file is scanned from the indexed tail', () => {
  expect(planReconciliation([disk(print({ size: 160, modifiedAtMs: 9 }))], [indexed(print())])).toEqual([
    { kind: 'scan-tail', id: A, fromOffset: 100, fromSequence: 7, fromLine: 4 },
  ]);
});

test('growth is not trusted when the last indexed event stopped matching', () => {
  expect(planReconciliation([disk(print({ size: 160 }), false)], [indexed(print())])).toEqual([
    { kind: 'rescan', id: A },
  ]);
});

test('a journal that shrank, or was replaced by another file, is rescanned', () => {
  expect(planReconciliation([disk(print({ size: 50 }))], [indexed(print())])).toEqual([{ kind: 'rescan', id: A }]);
  expect(planReconciliation([disk(print({ inode: '11', size: 160 }))], [indexed(print())])).toEqual([
    { kind: 'rescan', id: A },
  ]);
  expect(planReconciliation([disk(print({ device: '2', size: 160 }))], [indexed(print())])).toEqual([
    { kind: 'rescan', id: A },
  ]);
});

test('the same size with a new modified time in the same file is rescanned, not trusted', () => {
  expect(planReconciliation([disk(print({ modifiedAtMs: 6 }))], [indexed(print())])).toEqual([
    { kind: 'rescan', id: A },
  ]);
});
