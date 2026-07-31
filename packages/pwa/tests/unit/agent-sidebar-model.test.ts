/**
 * The sidebar's decisions, asserted without a browser.
 *
 * The gesture thresholds and the bulk-run token are the two places this surface
 * can go wrong invisibly: a mis-tuned press either swallows navigation or opens
 * a menu mid-scroll, and a stale token lets a superseded sweep overwrite the
 * dialog a person is currently reading.
 */

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';

import {
  activeSessionAncestorIds,
  bulkStopMenuActions,
  bulkStopReason,
  cancelsRowLongPress,
  CLICK_SUPPRESS_MS,
  drawerFocusPolicy,
  isCurrentBulkRun,
  MOVE_CANCEL_PX,
  pinScopedFirst,
  rowMenuActionSpecs,
  suppressesRowClick,
  type BulkStopRequest,
} from '../../src/shell/agent-sidebar-model.ts';
import { sessionView } from '../support/sessions.ts';

const fleet = (): readonly SessionView[] => [
  sessionView('lead', { config: { label: 'batch' } }),
  sessionView('mid', { config: { parent: 'lead', label: 'batch' } }),
  sessionView('leaf', { config: { parent: 'mid' } }),
];

describe('row gesture policy', () => {
  it('keeps a press that has barely moved', () => {
    const start = { x: 100, y: 100 };
    expect(cancelsRowLongPress(start, { x: 100 + MOVE_CANCEL_PX, y: 100 })).toBe(false);
    expect(cancelsRowLongPress(start, { x: 100, y: 100 - MOVE_CANCEL_PX })).toBe(false);
  });

  it('cancels a press that drifted past the threshold on either axis', () => {
    const start = { x: 100, y: 100 };
    expect(cancelsRowLongPress(start, { x: 100 + MOVE_CANCEL_PX + 1, y: 100 })).toBe(true);
    expect(cancelsRowLongPress(start, { x: 100, y: 100 + MOVE_CANCEL_PX + 1 })).toBe(true);
  });

  it('suppresses the click the menu-opening press fires, then stops suppressing', () => {
    expect(suppressesRowClick(1_000, 1_000)).toBe(true);
    expect(suppressesRowClick(1_000, 1_000 + CLICK_SUPPRESS_MS - 1)).toBe(true);
    expect(suppressesRowClick(1_000, 1_000 + CLICK_SUPPRESS_MS)).toBe(false);
  });
});

describe('rowMenuActionSpecs', () => {
  it('never offers the opaque single stop — the explicit scopes replace it', () => {
    const actions = rowMenuActionSpecs(sessionView('lead'), true).map(spec => spec.action);
    expect(actions).not.toContain('stop');
    expect(actions).toEqual(['interrupt', 'rename', 'migrate']);
  });

  it('offers nothing when the connection may not mutate', () => {
    expect(rowMenuActionSpecs(sessionView('lead'), false)).toEqual([]);
  });
});

describe('bulkStopMenuActions', () => {
  it('offers nothing when the connection may not mutate', () => {
    expect(bulkStopMenuActions(fleet(), 'lead', false)).toEqual([]);
  });

  it('offers all four scopes, with each scope carrying the targets it would hit', () => {
    const actions = bulkStopMenuActions(fleet(), 'lead', true);
    expect(actions.map(action => action.scope)).toEqual(['orphan', 'cascade', 'children', 'label']);
    const cascade = actions.find(action => action.scope === 'cascade')!;
    expect(cascade.targets.map(view => view.config.id)).toEqual(['lead', 'mid', 'leaf']);
  });

  it('names the label in the label entry so the sweep is never anonymous', () => {
    const actions = bulkStopMenuActions(fleet(), 'lead', true);
    expect(actions.find(action => action.scope === 'label')!.label).toBe('Stop label “batch”');
  });

  it('drops the label scope when the selected session has no usable label', () => {
    const sessions = [sessionView('lead', { config: { label: '  ' } }), sessionView('solo')];
    for (const id of ['lead', 'solo']) {
      const scopes = bulkStopMenuActions(sessions, id, true).map(action => action.scope);
      expect(scopes).toEqual(['orphan', 'cascade', 'children']);
    }
  });

  it('still offers the lineage scopes for a session that is not in the fleet, with no targets', () => {
    const actions = bulkStopMenuActions(fleet(), 'ghost', true);
    expect(actions.map(action => action.scope)).toEqual(['orphan', 'cascade', 'children']);
    expect(actions.every(action => action.targets.length === 0)).toBe(true);
  });
});

describe('bulk run identity', () => {
  const request = (overrides: Partial<BulkStopRequest> = {}): BulkStopRequest => ({
    token: 7,
    selectedId: 'lead',
    scope: 'cascade',
    targets: [],
    ...overrides,
  });

  it('recognises only the run whose token is still current', () => {
    expect(isCurrentBulkRun(request(), 7)).toBe(true);
    expect(isCurrentBulkRun(request(), 8)).toBe(false);
  });

  it('treats a closed dialog as no current run', () => {
    expect(isCurrentBulkRun(null, 7)).toBe(false);
  });

  it('records the selected session in a lineage reason', () => {
    expect(bulkStopReason(request({ scope: 'orphan' }))).toBe('stopped orphan lead from browser');
  });

  it('records the captured label — not the selection — in a label reason', () => {
    // The point of `labelIdentity`: a refresh may move the selected row between
    // opening the confirmation and running the sweep, and the reason must still
    // describe what the person actually confirmed.
    const reason = bulkStopReason(request({ scope: 'label', selectedId: 'moved', labelIdentity: 'batch' }));
    expect(reason).toBe('stopped label batch from browser');
  });
});

describe('activeSessionAncestorIds', () => {
  it('is empty when nothing is being viewed', () => {
    expect([...activeSessionAncestorIds(undefined, fleet())]).toEqual([]);
  });

  it('lists every ancestor of the viewed session but not the session itself', () => {
    const ancestors = activeSessionAncestorIds('leaf', fleet());
    expect([...ancestors].sort()).toEqual(['lead', 'mid']);
    expect(ancestors.has('leaf')).toBe(false);
  });

  it('is empty for a root session', () => {
    expect([...activeSessionAncestorIds('lead', fleet())]).toEqual([]);
  });

  it('terminates on a parent cycle rather than hanging the tab', () => {
    const sessions = [sessionView('a', { config: { parent: 'b' } }), sessionView('b', { config: { parent: 'a' } })];
    expect([...activeSessionAncestorIds('a', sessions)].sort()).toEqual(['b']);
  });
});

describe('pinScopedFirst', () => {
  const groups = [{ path: '/a' }, { path: '/b' }, { path: '/c' }];

  it('leaves the order alone when nothing is scoped', () => {
    expect(pinScopedFirst(groups, null)).toEqual(groups);
  });

  it('moves the scoped group to the front and keeps the rest in order', () => {
    expect(pinScopedFirst(groups, '/c')).toEqual([{ path: '/c' }, { path: '/a' }, { path: '/b' }]);
  });

  it('changes nothing when the scoped group is already first', () => {
    expect(pinScopedFirst(groups, '/a')).toEqual(groups);
  });

  it('changes nothing when the scope was filtered out of the list', () => {
    expect(pinScopedFirst(groups, '/gone')).toEqual(groups);
  });
});

describe('drawerFocusPolicy', () => {
  it('focuses the dialog on touch so the keyboard does not cover the fleet', () => {
    expect(drawerFocusPolicy(true)).toEqual({ dialogAutoFocus: true, searchAutoFocus: false });
  });

  it('keeps the search-first flow for a pointer', () => {
    expect(drawerFocusPolicy(false)).toEqual({ dialogAutoFocus: false, searchAutoFocus: true });
  });
});
