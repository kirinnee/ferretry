import { describe, expect, it } from 'bun:test';

import { buildLineage, byNewestActivity, lineageLabel } from '../../../app/lib/lineage.ts';
import { sessionView } from '@ferretry/app/testing';

const session = (id: string, options: { parent?: string; teammate?: string; name?: string; activity?: string } = {}) =>
  sessionView(id, {
    config: { parent: options.parent, teammate: options.teammate, name: options.name ?? `task ${id}` },
    state: { lastActivityAt: options.activity ?? '2026-07-25T00:00:00.000Z' },
  });

describe('buildLineage', () => {
  it('keeps direct-child order and computes depths even when children arrive first', () => {
    const root = session('root');
    const second = session('second', { parent: 'root' });
    const first = session('first', { parent: 'root' });
    const grandchild = session('grandchild', { parent: 'first' });
    const lineage = buildLineage([grandchild, second, first, root]);
    expect(lineage.childrenOf.get('root')?.map(view => view.config.id)).toEqual(['second', 'first']);
    expect(lineage.parentOf.get('grandchild')).toBe('first');
    expect(lineage.depthOf.get('root')).toBe(0);
    expect(lineage.depthOf.get('grandchild')).toBe(2);
  });

  it('drops missing, self and cyclic edges while retaining every row', () => {
    const missing = session('missing', { parent: 'purged' });
    const self = session('self', { parent: 'self' });
    const a = session('a', { parent: 'b' });
    const b = session('b', { parent: 'a' });
    const tail = session('tail', { parent: 'a' });
    const lineage = buildLineage([missing, self, a, b, tail]);
    expect([...lineage.parentOf]).toEqual([['tail', 'a']]);
    expect([...lineage.depthOf.values()]).toEqual([0, 0, 0, 0, 1]);
  });
});

describe('lineage labels', () => {
  it('keeps callsigns and task text human-readable while retaining raw identity', () => {
    const view = session('ms0zbxh8-5cce961d', { teammate: 'mary-jane', name: '[Legacy] Repair transcript' });
    expect(lineageLabel(view)).toEqual({
      callsign: 'Mary-Jane',
      task: 'Repair transcript',
      text: 'Mary-Jane · Repair transcript',
      full: 'Mary-Jane · Repair transcript · ms0zbxh8-5cce961d',
    });
  });

  it('suppresses duplicate identity and falls back to a concise id', () => {
    expect(lineageLabel(session('redundant-id', { teammate: 'meghan', name: '[Legacy] Meghan' })).text).toBe('Meghan');
    expect(lineageLabel(session('deadbeef0011', { name: '' })).text).toBe('deadbeef…');
  });
});

describe('byNewestActivity', () => {
  it('sorts a session with an unreadable activity time after a dated one', () => {
    const idle = session('idle', { activity: '2026-07-25T01:00:00.000Z' });
    expect(byNewestActivity(session('bad', { activity: 'not-a-date' }), idle)).toBeGreaterThan(0);
  });
});
