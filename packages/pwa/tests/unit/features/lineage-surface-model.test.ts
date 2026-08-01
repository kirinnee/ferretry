import { describe, expect, it } from 'bun:test';

import {
  buildLineageSurfaceModel,
  filterLineageRows,
  lineageFilterSummary,
  orderedStatuses,
  statusCounts,
  surfaceRows,
  toggleLineageStatusFilter,
} from '../../../src/features/lineage/lineage-surface-model.ts';
import { sessionView } from '../../support/sessions.ts';

describe('lineage surface model', () => {
  it('selects the focused family in shared lineage order and never reconnects an invalid parent', () => {
    const root = sessionView('root', { state: { status: 'waiting' } });
    const current = sessionView('current', { config: { parent: 'root' } });
    const child = sessionView('child', { config: { parent: 'current' } });
    const grandchild = sessionView('grandchild', { config: { parent: 'child' }, state: { status: 'completed' } });

    const model = buildLineageSurfaceModel('current', [grandchild, child, current, root]);
    expect(model.current?.config.id).toBe('current');
    expect(model.parent).toMatchObject({ kind: 'resolved', view: { config: { id: 'root' } } });
    expect(model.descendantCount).toBe(2);
    expect(surfaceRows(model)[0]?.view.config.id).toBe('root');

    // Looking up a deeply nested focus must walk through its ancestors rather
    // than only inspecting the first nested row.
    expect(buildLineageSurfaceModel('grandchild', [grandchild, child, current, root]).current?.config.id).toBe(
      'grandchild',
    );

    const cyclic = sessionView('cycle', { config: { parent: 'cycle' } });
    expect(buildLineageSurfaceModel('cycle', [cyclic]).parent).toEqual({ kind: 'invalid', shortId: 'cycle' });
  });

  it('keeps ancestor paths visible while filtering a tree by multiple statuses', () => {
    const root = sessionView('root', { state: { status: 'waiting' } });
    const current = sessionView('current', { config: { parent: 'root' }, state: { status: 'running' } });
    const child = sessionView('child', { config: { parent: 'current' }, state: { status: 'completed' } });
    const rows = surfaceRows(buildLineageSurfaceModel('current', [root, current, child]));

    const filtered = filterLineageRows(rows, new Set(['completed']));
    expect(filtered.matchCount).toBe(1);
    expect(filtered.contextCount).toBe(2);
    expect(filtered.rows[0]?.matchesFilter).toBeFalse();
    expect(filtered.rows[0]?.children[0]?.children[0]?.view.config.id).toBe('child');
    expect(lineageFilterSummary(filtered.matchCount, filtered.contextCount)).toBe('1 match · 2 paths');
  });

  it('toggles back to All after the final selected status is removed and retains selected zero-count chips', () => {
    const onlyRunning = toggleLineageStatusFilter(null, 'running');
    expect(onlyRunning).toEqual(new Set(['running']));
    expect(toggleLineageStatusFilter(onlyRunning, 'running')).toBeNull();

    const counts = statusCounts(surfaceRows(buildLineageSurfaceModel('missing', [])));
    expect(orderedStatuses(counts, new Set(['failed', 'running']))).toEqual(['running', 'failed']);
  });
});
