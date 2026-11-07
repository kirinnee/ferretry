import { describe, expect, it } from 'bun:test';
import { rootViews } from '../../../app/lib/session-root.ts';
import { sessionView } from '@ferretry/app/testing';

const child = (id: string, parent: string | undefined) => sessionView(id, { config: { parent } as never });

describe('rootViews', () => {
  it('is its own root for a session with no parent', () => {
    const lone = sessionView('lone');
    expect(rootViews([lone]).get('lone')).toBe(lone);
  });

  it('walks a lineage to the top-level session, however deep', () => {
    const top = sessionView('top');
    const rows = [top, child('mid', 'top'), child('leaf', 'mid')];
    const roots = rootViews(rows);
    expect(roots.get('leaf')).toBe(top);
    expect(roots.get('mid')).toBe(top);
    expect(roots.get('top')).toBe(top);
  });

  it('ends at the topmost session it holds when a parent has been pruned', () => {
    const mid = child('mid', 'gone');
    expect(rootViews([mid, child('leaf', 'mid')]).get('leaf')).toBe(mid);
  });

  it('ends where a loop first repeats instead of walking forever', () => {
    const roots = rootViews([child('a', 'b'), child('b', 'a')]);
    expect(roots.get('a')?.config.id).toBe('b');
    expect(roots.get('b')?.config.id).toBe('a');
  });
});
