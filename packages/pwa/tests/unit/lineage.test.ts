import { describe, expect, it } from 'bun:test';

import {
  buildLineage,
  byNewestActivity,
  lineageIndent,
  lineageLabel,
  nestByLineage,
  parentDisplay,
} from '../../src/lib/lineage.ts';
import { sessionView } from '../support/sessions.ts';

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

  it('resolves a live parent and identifies a purged parent without inventing one', () => {
    const parent = session('parent-123456', { teammate: 'meghan' });
    const byId = new Map([[parent.config.id, parent]]);
    expect(parentDisplay(parent.config.id, byId)).toMatchObject({
      kind: 'resolved',
      name: 'Meghan · task parent-123456',
    });
    expect(parentDisplay('deadbeef0011', byId)).toEqual({ kind: 'missing', shortId: 'deadbeef…' });
    expect(parentDisplay(undefined, byId)).toBeNull();
  });
});

describe('nestByLineage', () => {
  it('nests visible same-group parents, marks flattened children, and caps indentation', () => {
    const root = session('root');
    const child = session('child', { parent: 'root' });
    const grandchild = session('grandchild', { parent: 'child' });
    const deep = session('deep', { parent: 'grandchild' });
    const hidden = session('hidden-child', { parent: 'hidden' });
    const all = [root, child, grandchild, deep, hidden];
    const nested = nestByLineage(all, buildLineage(all));
    expect(nested[0]?.children[0]?.children[0]?.children[0]?.depth).toBe(3);
    expect(nested[1]?.spawnedBy).toBe('hidden');
    expect([lineageIndent(-1), lineageIndent(0), lineageIndent(1), lineageIndent(2), lineageIndent(99)]).toEqual([
      0, 0, 10, 20, 20,
    ]);
  });

  it('orders roots by newest descendant and siblings by their own activity', () => {
    const idle = session('idle', { activity: '2026-07-25T01:00:00.000Z' });
    const active = session('active', { activity: '2026-07-25T00:00:00.000Z' });
    const older = session('older', { parent: 'active', activity: '2026-07-25T02:00:00.000Z' });
    const newer = session('newer', { parent: 'active', activity: '2026-07-25T03:00:00.000Z' });
    const all = [idle, active, older, newer];
    const nested = nestByLineage(all, buildLineage(all));
    expect(nested.map(row => row.view.config.id)).toEqual(['active', 'idle']);
    expect(nested[0]?.children.map(row => row.view.config.id)).toEqual(['newer', 'older']);
    expect(byNewestActivity(session('bad', { activity: 'not-a-date' }), idle)).toBeGreaterThan(0);
  });
});
