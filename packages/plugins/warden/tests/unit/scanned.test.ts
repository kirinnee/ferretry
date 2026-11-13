import { describe, expect, test } from 'bun:test';
import { lineageSweptAt, scannedAfter, sweptField } from '../../daemon/lib/scanned.ts';

const T1 = '2026-11-06T09:00:00.000Z';
const T2 = '2026-11-06T09:04:00.000Z';
const ids = (...list: string[]) => list.map(id => ({ config: { id } }));
const scope = { mayRead: (id: string) => id === 'a' || id === 'b' };

describe('scannedAfter', () => {
  test('records the sweep instant for every ferret scanned and keeps an unscanned ferret the fleet still lists', () => {
    expect(scannedAfter({ a: T1, c: T1 }, ids('a', 'b', 'c'), ids('a', 'b'), T2)).toEqual({ a: T2, b: T2, c: T1 });
  });

  test('forgets a ferret the fleet no longer lists', () => {
    expect(scannedAfter({ gone: T1 }, ids('a'), ids('a'), T2)).toEqual({ a: T2 });
  });
});

describe('lineageSweptAt', () => {
  test('is the newest instant among the ferrets the scope may read, and nothing else', () => {
    expect(lineageSweptAt({ a: T1, b: T2, other: '2026-11-06T10:00:00.000Z' }, scope)).toBe(T2);
  });

  test('is absent when no ferret of the lineage was ever scanned', () => {
    expect(lineageSweptAt({ other: T2 }, scope)).toBeUndefined();
    expect(lineageSweptAt(undefined, scope)).toBeUndefined();
  });
});

describe('sweptField', () => {
  const state = { lastSweepAt: T2, scanned: { other: T2 } };

  test('gives the owner the global sweep and a scoped reader only its lineage’s', () => {
    expect(sweptField(state, undefined)).toEqual({ lastSweepAt: T2 });
    expect(sweptField(state, scope)).toEqual({});
    expect(sweptField({ ...state, scanned: { a: T1 } }, scope)).toEqual({ lastSweepAt: T1 });
  });
});
