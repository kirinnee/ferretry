import { describe, expect, test } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { type PaneReading, sessionAtPrompt, UNREAD_PANE } from '../../src/lib/session-activity.ts';
import { sessionView } from '../support/sessions.ts';

/**
 * WORKING OR AT ITS PROMPT, decided from evidence rather than from `running`.
 *
 * The pane wins whenever it was read; the daemon's turn record answers only when no frame was; and
 * no evidence at all is never read as idleness.
 */

const view = (state: Partial<SessionView['state']>): SessionView => sessionView('s', { state });
const idleFrame: PaneReading = { read: true, activity: null };
const workingFrame: PaneReading = { read: true, activity: { harness: 'claude', verb: 'Pontificating…' } };

describe('sessionAtPrompt', () => {
  test('a brand-new session on turn zero is at its prompt before any frame is read', () => {
    expect(sessionAtPrompt(view({ status: 'running', turn: 0 }), UNREAD_PANE)).toBe(true);
  });

  test('a frame with no status line is at its prompt, whatever the daemon last recorded', () => {
    expect(sessionAtPrompt(view({ status: 'running', turn: 5, promptReady: false }), idleFrame)).toBe(true);
  });

  test('a frame showing the harness at work is working, even on turn zero', () => {
    expect(sessionAtPrompt(view({ status: 'running', turn: 0, promptReady: true }), workingFrame)).toBe(false);
  });

  test("without a frame, the daemon's own record of the prompt answers", () => {
    expect(sessionAtPrompt(view({ status: 'running', turn: 2, promptReady: true }), UNREAD_PANE)).toBe(true);
    expect(sessionAtPrompt(view({ status: 'running', turn: 0, promptReady: false }), UNREAD_PANE)).toBe(false);
  });

  test('no evidence either way is not idleness', () => {
    expect(sessionAtPrompt(view({ status: 'running', turn: 2 }), UNREAD_PANE)).toBe(false);
  });

  test('only a running session is ever called ready; every other status already says what it is', () => {
    for (const status of ['starting', 'thinking', 'waiting', 'awaiting_user', 'completed', 'stopped'] as const)
      expect(sessionAtPrompt(view({ status, turn: 0 }), idleFrame)).toBe(false);
  });
});
