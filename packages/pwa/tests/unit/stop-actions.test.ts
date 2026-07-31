/**
 * The four fleet stop scopes.
 *
 * A bulk stop is the most destructive thing the sidebar can do, so the target
 * SELECTION is tested away from any dialog: what a person confirms has to be
 * exactly what the sweep will hit, in the order it will hit it.
 */

import { describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';

import {
  isStoppable,
  selectLiveDescendants,
  selectStopTargets,
  stopScopeLabel,
  stopScopeReason,
  type StopScope,
} from '../../src/shell/stop-actions.ts';
import { sessionView } from '../support/sessions.ts';

/** `lead → mid → leaf`, plus an unrelated session sharing the lead's label. */
const fleet = (): readonly SessionView[] => [
  sessionView('lead', { config: { label: 'batch' } }),
  sessionView('mid', { config: { parent: 'lead', label: 'batch' } }),
  sessionView('leaf', { config: { parent: 'mid' } }),
  sessionView('other', { config: { label: 'batch' } }),
];

const ids = (views: readonly SessionView[]): readonly string[] => views.map(view => view.config.id);

describe('isStoppable', () => {
  it('accepts a running session and a kill_failed one', () => {
    expect(isStoppable(sessionView('a', { state: { status: 'running' } }))).toBe(true);
    expect(isStoppable(sessionView('a', { state: { status: 'kill_failed' } }))).toBe(true);
  });

  it('rejects a session that already finished', () => {
    for (const status of ['completed', 'failed', 'stalled', 'stopped'] as const) {
      expect(isStoppable(sessionView('a', { state: { status } }))).toBe(false);
    }
  });
});

describe('selectStopTargets', () => {
  it('returns nothing when the selected session is not in the fleet', () => {
    expect(selectStopTargets(fleet(), 'ghost', 'cascade')).toEqual([]);
  });

  it('orphan targets the selected session alone, leaving its tree running', () => {
    expect(ids(selectStopTargets(fleet(), 'lead', 'orphan'))).toEqual(['lead']);
  });

  it('orphan targets nothing when the selected session is already finished', () => {
    const sessions = [sessionView('lead', { state: { status: 'completed' } })];
    expect(selectStopTargets(sessions, 'lead', 'orphan')).toEqual([]);
  });

  it('cascade takes the selected session and its whole tree, shallowest first', () => {
    expect(ids(selectStopTargets(fleet(), 'lead', 'cascade'))).toEqual(['lead', 'mid', 'leaf']);
  });

  it('children takes the tree but deliberately keeps the selected session', () => {
    expect(ids(selectStopTargets(fleet(), 'lead', 'children'))).toEqual(['mid', 'leaf']);
  });

  it('label sweeps every session carrying the identical label, including unrelated ones', () => {
    // `other` shares no lineage with `lead`; a label is an independent selector
    // and is never combined with the tree.
    expect(ids(selectStopTargets(fleet(), 'lead', 'label'))).toEqual(['lead', 'other', 'mid']);
  });

  it('label targets nothing when the selected session has a blank label', () => {
    const sessions = [sessionView('lead', { config: { label: '   ' } })];
    expect(selectStopTargets(sessions, 'lead', 'label')).toEqual([]);
  });

  it('skips sessions in the tree that can no longer be stopped', () => {
    const sessions = [
      sessionView('lead'),
      sessionView('mid', { config: { parent: 'lead' }, state: { status: 'completed' } }),
      sessionView('leaf', { config: { parent: 'mid' } }),
    ];
    // `mid` is finished, but the traversal still reaches `leaf` THROUGH it —
    // an unstoppable node must not amputate its live descendants.
    expect(ids(selectStopTargets(sessions, 'lead', 'cascade'))).toEqual(['lead', 'leaf']);
  });

  it('terminates on a self-parent rather than hanging the tab', () => {
    const sessions = [sessionView('lead', { config: { parent: 'lead' } })];
    expect(ids(selectStopTargets(sessions, 'lead', 'cascade'))).toEqual(['lead']);
  });

  it('terminates on a longer parent cycle', () => {
    const sessions = [sessionView('a', { config: { parent: 'b' } }), sessionView('b', { config: { parent: 'a' } })];
    expect(
      ids(selectStopTargets(sessions, 'a', 'cascade'))
        .slice()
        .sort(),
    ).toEqual(['a', 'b']);
  });
});

describe('selectLiveDescendants', () => {
  it('lists what orphan mode consciously leaves running, shallowest first', () => {
    expect(ids(selectLiveDescendants(fleet(), 'lead'))).toEqual(['mid', 'leaf']);
  });

  it('never includes the selected session itself', () => {
    expect(ids(selectLiveDescendants(fleet(), 'lead'))).not.toContain('lead');
  });

  it('is empty for a leaf, and for a session that is not there', () => {
    expect(selectLiveDescendants(fleet(), 'leaf')).toEqual([]);
    expect(selectLiveDescendants(fleet(), 'ghost')).toEqual([]);
  });
});

describe('stop scope wording', () => {
  const scopes: readonly StopScope[] = ['orphan', 'cascade', 'children', 'label'];

  it('labels every scope distinctly', () => {
    const labels = scopes.map(stopScopeLabel);
    expect(new Set(labels).size).toBe(scopes.length);
    expect(labels.every(label => label.startsWith('Stop · '))).toBe(true);
  });

  it('records a distinct, attributable reason naming the selection', () => {
    const reasons = scopes.map(scope => stopScopeReason(scope, 'lead'));
    expect(new Set(reasons).size).toBe(scopes.length);
    expect(reasons.every(reason => reason.includes('lead') && reason.endsWith('from browser'))).toBe(true);
  });
});
