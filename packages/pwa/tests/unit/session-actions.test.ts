/**
 * The row/header action gate.
 *
 * These assertions are the contract two surfaces share — the fleet sidebar's row
 * menu and the session header's inline controls — so a change that quietly drops
 * an action from one of them fails here rather than in a screenshot.
 */

import { describe, expect, it } from 'bun:test';
import type { SessionStatus } from '@ferretry/protocol';

import { sessionActionSpecs, type SessionAction } from '../../src/shell/session-actions.ts';
import { sessionView } from '../support/sessions.ts';

const actionsFor = (status: SessionStatus, canMutate = true): readonly SessionAction[] =>
  sessionActionSpecs(sessionView('s1', { state: { status } }), canMutate).map(spec => spec.action);

describe('sessionActionSpecs', () => {
  it('offers nothing at all when the connection may not mutate', () => {
    // The multi-daemon point: authority is per connection, so a caller that says
    // "no" gets an empty menu rather than a tempting action that would fail.
    expect(sessionActionSpecs(sessionView('s1'), false)).toEqual([]);
  });

  it('offers interrupt and stop, never resume, for a live session', () => {
    for (const status of ['created', 'starting', 'running', 'thinking', 'tool_running', 'waiting'] as const) {
      expect(actionsFor(status)).toEqual(['interrupt', 'stop', 'rename', 'migrate']);
    }
  });

  it('offers resume instead of interrupt or stop once a session has finished', () => {
    for (const status of ['completed', 'failed', 'stalled', 'stopped'] as const) {
      expect(actionsFor(status)).toEqual(['resume', 'rename', 'migrate']);
    }
  });

  it('keeps stop — and only stop — available on a kill_failed session', () => {
    // kill_failed is terminal, but it is the previous STOP that failed, so the
    // one action it still needs is another stop. Resume would be wrong here.
    expect(actionsFor('kill_failed')).toEqual(['stop', 'rename', 'migrate']);
  });

  it('marks stop and migrate destructive and nothing else', () => {
    const specs = sessionActionSpecs(sessionView('s1', { state: { status: 'running' } }), true);
    const danger = specs.filter(spec => spec.danger === true).map(spec => spec.action);
    expect(danger).toEqual(['stop', 'migrate']);
  });

  it('labels every action it offers', () => {
    const specs = sessionActionSpecs(sessionView('s1', { state: { status: 'running' } }), true);
    expect(specs.every(spec => spec.label.trim().length > 0)).toBe(true);
  });
});
