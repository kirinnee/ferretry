import { describe, expect, test } from 'bun:test';
import { closeAck, decideHome, insideFence, type MintedIds, type OpaqueId } from '../../contract/index.ts';

const minted = (ids: readonly string[]): MintedIds => {
  const set = new Set(ids);
  return { has: id => typeof id === 'string' && set.has(id), get: id => String(id) as OpaqueId };
};

describe('closeAck (§4.7 runtime layer)', () => {
  test('a write-only result keeps only status, code and minted ids', () => {
    const raw = { status: 'done', url: 'https://example.test/#c2VjcmV0', title: 'secret' };
    expect(closeAck(raw, minted([]))).toEqual({ status: 'done' });
  });
  test('an id the kernel did not mint is refused', () => {
    expect(closeAck({ status: 'done', ids: ['https://example.test/'] }, minted([]))).toEqual({
      status: 'refused',
      code: 'unminted_id',
    });
  });
  test('a minted id is kept', () => {
    expect(closeAck({ status: 'done', ids: ['p1'] }, minted(['p1']))).toEqual({
      status: 'done',
      ids: ['p1' as OpaqueId],
    });
  });
  test('a getter, a class instance or an unknown status is malformed', () => {
    const getter = Object.defineProperty({}, 'status', { get: () => 'done', enumerable: true });
    class Result {
      status = 'done';
    }
    for (const raw of [getter, new Result(), { status: 'ok' }, { status: 'done', code: 'nope' }, null, 'done'])
      expect(closeAck(raw, minted([]))).toEqual({ status: 'refused', code: 'malformed_result' });
  });
  test('the answer is frozen', () => {
    expect(Object.isFrozen(closeAck({ status: 'done' }, minted([])))).toBe(true);
  });
});

describe('decideHome (§9.3)', () => {
  test('nothing or an empty folder is created', () => {
    expect(decideHome('/h', { kind: 'missing' }).kind).toBe('create');
    expect(decideHome('/h', { kind: 'empty' }).kind).toBe('create');
  });
  test('a format-1 home.json starts', () => {
    const text = JSON.stringify({ format: 1, createdBy: 'fyd 5.0.0', createdAt: '2026-11-06T09:00:00Z' });
    expect(decideHome('/h', { kind: 'home-json', text }).kind).toBe('start');
  });
  test('a non-empty folder with no home.json is refused, naming the carry-over prompt', () => {
    const decision = decideHome('/h', { kind: 'no-home-json' });
    expect(decision.kind).toBe('refuse');
    expect(decision.kind === 'refuse' && decision.sentence).toContain('clean-slate-prompt.md');
  });
  test('a lower, higher or unreadable home.json is refused', () => {
    const at = '2026-11-06T09:00:00Z';
    for (const text of [
      JSON.stringify({ format: 0, createdBy: 'x', createdAt: at }),
      JSON.stringify({ format: 2 }),
      '{',
    ])
      expect(decideHome('/h', { kind: 'home-json', text }).kind).toBe('refuse');
  });
});

describe('insideFence (§7.7)', () => {
  test('the home, moved-aside homes and moved-aside plugin folders are fenced', () => {
    expect(insideFence('/u/.ferretry', '/u/.ferretry')).toBe(true);
    expect(insideFence('/u/.ferretry', '/u/.ferretry/state/vault/vault.json')).toBe(true);
    expect(insideFence('/u/.ferretry', '/u/.ferretry-before-2026-11-06-0900/state')).toBe(true);
  });
  test('the worktrees folder and the owner work are not', () => {
    expect(insideFence('/u/.ferretry', '/u/.ferretry-worktrees/x')).toBe(false);
    expect(insideFence('/u/.ferretry', '/u/work/repo')).toBe(false);
  });
});
